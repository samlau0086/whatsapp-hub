import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import dotenv from "dotenv";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Pino from "pino";
import { ProxyAgent } from "proxy-agent";
import QRCode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import { io } from "socket.io-client";

dotenv.config();

const config = {
  hubUrl: process.env.HUB_URL || "http://localhost:3000",
  token: process.env.CLIENT_TOKEN || process.env.HUB_API_TOKEN || "dev-token",
  clientId: process.env.CLIENT_ID || "client-main",
  clientName: process.env.CLIENT_NAME || "Main WhatsApp Client",
  authDataPath: path.resolve(process.env.BAILEYS_AUTH_DATA_PATH || process.env.WWEBJS_AUTH_DATA_PATH || ".baileys_auth"),
  cachePath: path.resolve(process.env.BAILEYS_STORE_PATH || process.env.WWEBJS_CACHE_PATH || ".baileys_store"),
  proxyUrl: process.env.CLIENT_PROXY_URL || "",
  proxyUsername: process.env.CLIENT_PROXY_USERNAME || "",
  proxyPassword: process.env.CLIENT_PROXY_PASSWORD || "",
  qrOutputDir: path.resolve(process.env.QR_OUTPUT_DIR || "."),
  historySyncOnReady: process.env.HISTORY_SYNC_ON_READY !== "false",
  historySyncChatLimit: numberFromEnv("HISTORY_SYNC_CHAT_LIMIT", 50),
  historySyncMessageLimit: numberFromEnv("HISTORY_SYNC_MESSAGE_LIMIT", 30),
  historySyncIntervalMs: numberFromEnv("HISTORY_SYNC_INTERVAL_MS", 300_000),
  inboundVideoMode: process.env.INBOUND_VIDEO_MODE || "lazy",
  printQrInTerminal: process.env.PRINT_QR_IN_TERMINAL !== "false",
  syncFullHistory: process.env.BAILEYS_SYNC_FULL_HISTORY === "true",
  connectTimeoutMs: numberFromEnv("BAILEYS_CONNECT_TIMEOUT_MS", 60_000),
  keepAliveIntervalMs: numberFromEnv("BAILEYS_KEEP_ALIVE_INTERVAL_MS", 30_000),
  reconnectMinDelayMs: numberFromEnv("BAILEYS_RECONNECT_MIN_DELAY_MS", 5_000),
  reconnectMaxDelayMs: numberFromEnv("BAILEYS_RECONNECT_MAX_DELAY_MS", 120_000)
};

const logger = Pino({ level: process.env.BAILEYS_LOG_LEVEL || "silent" });
const proxyUrl = buildProxyUrl(config.proxyUrl, config.proxyUsername, config.proxyPassword);
const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
const socket = io(config.hubUrl, {
  auth: { token: config.token },
  reconnection: true,
  reconnectionDelayMax: 10_000
});

let sock = null;
let whatsappReady = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let historySyncTimer = null;
let historySyncInProgress = false;
const recentMessages = new Map();
const knownChats = new Map();
const knownContacts = new Map();

console.log(`baileys auth data path: ${config.authDataPath}`);
console.log(`baileys store path: ${config.cachePath}`);
console.log(`whatsapp proxy: ${proxyUrl ? maskProxyUrl(proxyUrl) : "disabled"}`);
console.log(`qr image output: ${config.qrOutputDir}`);
console.log(`history sync: ${config.historySyncOnReady ? `${config.historySyncChatLimit} chats x ${config.historySyncMessageLimit} messages` : "disabled"}`);
console.log(`history sync interval: ${config.historySyncOnReady ? `${config.historySyncIntervalMs} ms` : "disabled"}`);
console.log(`baileys connect timeout: ${config.connectTimeoutMs} ms`);

socket.on("connect", () => {
  console.log(`Hub socket connected; WhatsApp is ${whatsappReady ? "ready" : "not ready yet"}`);
  emitHello(whatsappReady ? "online" : "offline");
  if (whatsappReady) scheduleHistorySync("socket_reconnect", 2_000);
});

socket.on("connect_error", (error) => {
  console.error(`Hub socket connection failed: ${error.message}`);
});

socket.on("task:send-message", async (task, ack) => {
  ack?.({ accepted: true });
  try {
    if (!whatsappReady || !sock) throw new Error("WhatsApp client is not ready yet");
    const { to, chatId: payloadChatId, body } = task.payload || {};
    const jid = normalizeChatId(payloadChatId || to);
    const mediaPayload = task.payload?.media;
    const content = mediaPayload?.url
      ? await buildBaileysMediaContent(mediaPayload, body)
      : { text: body || "" };
    const result = await sock.sendMessage(jid, content);
    socket.emit("task:result", {
      taskId: task.id,
      ok: true,
      result: {
        messageId: makeMessageExternalId(result?.key),
        chatId: jid
      }
    });
  } catch (error) {
    socket.emit("task:result", {
      taskId: task.id,
      ok: false,
      error: error.message,
      result: {
        code: "baileys_send_failed",
        recoverable: isRecoverableBaileysError(error)
      }
    });
    if (isRecoverableBaileysError(error)) scheduleReconnect(error.message);
  }
});

socket.on("contact:resolve", async (payload = {}, ack) => {
  try {
    const jid = normalizeChatId(payload.chatId || payload.id || payload.to);
    ack?.({ ok: true, chatId: jid, contact: serializeContact(jid) });
  } catch (error) {
    ack?.({ ok: false, error: error.message });
  }
});

socket.on("media:download", async (payload = {}, ack) => {
  try {
    const messageId = payload.externalId || payload.whatsappMessageId;
    const message = recentMessages.get(messageId);
    if (!message) {
      return ack?.({ ok: false, error: "message is no longer available in this client session" });
    }
    const media = await uploadInboundMedia(message, "lazy_download", { force: true });
    if (!media?.url) return ack?.({ ok: false, error: "failed to download media from WhatsApp" });
    await emitHubMessage(message, "lazy_download", { media });
    ack?.({ ok: true, media });
  } catch (error) {
    ack?.({ ok: false, error: error.message });
  }
});

await connectBaileys();

async function connectBaileys() {
  await closeCurrentBaileysSocket("starting new Baileys socket");
  const { state, saveCreds } = await useMultiFileAuthState(config.authDataPath);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: ["WhatsApp Actor Hub", "Chrome", "1.0.0"],
    connectTimeoutMs: config.connectTimeoutMs,
    defaultQueryTimeoutMs: config.connectTimeoutMs,
    emitOwnEvents: true,
    keepAliveIntervalMs: config.keepAliveIntervalMs,
    logger,
    markOnlineOnConnect: true,
    printQRInTerminal: false,
    shouldSyncHistoryMessage: () => config.historySyncOnReady,
    syncFullHistory: config.syncFullHistory,
    ...(proxyAgent ? { agent: proxyAgent, fetchAgent: proxyAgent } : {}),
    version
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", handleConnectionUpdate);
  sock.ev.on("chats.set", ({ chats = [] } = {}) => {
    chats.forEach((chat) => rememberChat(chat));
  });
  sock.ev.on("chats.upsert", (chats = []) => {
    chats.forEach((chat) => rememberChat(chat));
  });
  sock.ev.on("contacts.set", ({ contacts = [] } = {}) => {
    contacts.forEach((contact) => rememberContact(contact));
  });
  sock.ev.on("contacts.upsert", (contacts = []) => {
    contacts.forEach((contact) => rememberContact(contact));
  });
  sock.ev.on("messages.upsert", async ({ messages = [], type } = {}) => {
    await processMessages(messages, type || "messages_upsert");
  });
  sock.ev.on("messaging-history.set", async ({ chats = [], contacts = [], messages = [] } = {}) => {
    chats.forEach((chat) => rememberChat(chat));
    contacts.forEach((contact) => rememberContact(contact));
    await processMessages(messages, "history_sync");
  });
}

async function handleConnectionUpdate(update = {}) {
  const { connection, lastDisconnect, qr } = update;
  if (qr) await saveQr(qr);
  if (connection === "open") {
    whatsappReady = true;
    reconnectAttempts = 0;
    emitHello("online");
    console.log(`${config.clientId} is ready (Baileys)`);
    startPeriodicHistorySync();
    scheduleHistorySync("ready", 3_000);
  }
  if (connection === "close") {
    whatsappReady = false;
    stopPeriodicHistorySync();
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const errorMessage = lastDisconnect?.error?.message || "connection closed";
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    emitHeartbeat("offline", errorMessage);
    console.warn(`Baileys connection closed: ${errorMessage}${statusCode ? ` (${statusCode})` : ""}`);
    if (isWhatsAppNetworkRefusedError(lastDisconnect?.error) && !proxyUrl) {
      console.warn("WhatsApp WebSocket connection was refused or timed out without CLIENT_PROXY_URL. Configure CLIENT_PROXY_URL, or verify this network can reach WhatsApp Web directly.");
    }
    if (loggedOut) {
      console.error("WhatsApp logged out. Delete auth directory if needed, then scan QR again.");
      return;
    }
    scheduleReconnect(errorMessage || `connection closed (${statusCode || "unknown"})`);
  }
}

async function processMessages(messages, source) {
  const cleanMessages = messages
    .filter((message) => message?.key?.remoteJid && message.message)
    .sort((a, b) => (Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0)));
  for (const message of cleanMessages) {
    rememberRecentMessage(message);
    await emitHubMessage(message, source).catch((error) => {
      console.error(`failed to emit message ${makeMessageExternalId(message.key)}: ${error.message}`);
    });
  }
}

function emitHello(status = "online") {
  socket.emit("client:hello", {
    id: config.clientId,
    name: config.clientName,
    phone: ownPhone(),
    status,
    metadata: {
      platform: "baileys",
      pushname: sock?.user?.name || null
    }
  }, (response) => {
    if (!response?.ok) {
      console.error(`Hub rejected client hello: ${response?.error || "unknown error"}`);
    } else {
      console.log(`Hub registered client ${config.clientId} as ${response.client?.status || status}`);
    }
  });
}

function emitHeartbeat(status = "online", reason = null) {
  if (!socket.connected) return;
  socket.emit("client:heartbeat", {
    id: config.clientId,
    name: config.clientName,
    phone: ownPhone(),
    status,
    reason,
    metadata: {
      platform: "baileys",
      pushname: sock?.user?.name || null
    }
  });
}

setInterval(() => {
  emitHeartbeat(whatsappReady ? "online" : "offline");
}, 15_000).unref();

async function buildBaileysMediaContent(mediaPayload, body = "") {
  const url = new URL(mediaPayload.url, config.hubUrl).toString();
  const response = await fetch(url, {
    headers: { "x-hub-token": config.token }
  });
  if (!response.ok) throw new Error(`failed to download media: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType = mediaPayload.mimeType || mediaPayload.mimetype || response.headers.get("content-type") || "application/octet-stream";
  const fileName = mediaPayload.originalName || mediaPayload.filename || `file-${Date.now()}${extensionFromMime(mimeType)}`;
  if (mediaPayload.sendAsDocument === true) {
    return { document: buffer, mimetype: mimeType, fileName, caption: body || "" };
  }
  if (mimeType.startsWith("image/")) return { image: buffer, caption: body || "" };
  if (mimeType.startsWith("video/")) return { video: buffer, mimetype: mimeType, caption: body || "" };
  if (mimeType.startsWith("audio/")) return { audio: buffer, mimetype: mimeType, ptt: false };
  return { document: buffer, mimetype: mimeType, fileName, caption: body || "" };
}

async function uploadInboundMedia(message, source, options = {}) {
  const mediaInfo = mediaMessageInfo(message);
  if (!mediaInfo) return null;
  if (!options.force && shouldLazyInboundMedia(mediaInfo)) {
    return lazyMediaPayload(message, mediaInfo, source);
  }
  try {
    const buffer = await downloadMediaMessage(message, "buffer", {}, {
      logger,
      reuploadRequest: sock?.updateMediaMessage
    });
    if (!buffer?.length) return null;
    const fileName = mediaInfo.fileName || `whatsapp-${message.key?.id || Date.now()}${extensionFromMime(mediaInfo.mimeType)}`;
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mediaInfo.mimeType }), fileName);
    const response = await fetch(new URL("/api/uploads", config.hubUrl), {
      method: "POST",
      headers: { "x-hub-token": config.token },
      body: form
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `upload failed with ${response.status}`);
    return {
      ...body.file,
      filename: fileName,
      originalName: body.file?.originalName || fileName,
      mimeType: body.file?.mimeType || mediaInfo.mimeType,
      source,
      whatsappMessageId: makeMessageExternalId(message.key),
      lazyDownload: false,
      downloadStatus: "downloaded"
    };
  } catch (error) {
    console.error(`failed to upload inbound media ${makeMessageExternalId(message.key)}: ${error.message}`);
    return null;
  }
}

async function emitHubMessage(message, source, options = {}) {
  rememberRecentMessage(message);
  const content = normalizeMessageContent(message.message);
  const mediaInfo = mediaMessageInfo(message);
  const media = options.media || await uploadInboundMedia(message, source);
  const remoteJid = jidNormalizedUser(message.key.remoteJid);
  const participant = message.key.participant ? jidNormalizedUser(message.key.participant) : null;
  const fromMe = Boolean(message.key.fromMe);
  const peerJid = fromMe ? remoteJid : (participant || remoteJid);
  const peerPhone = jidToPhone(peerJid);
  const own = ownPhone();
  const body = messageBody(content) || media?.originalName || "";
  const createdAt = message.messageTimestamp
    ? new Date(Number(message.messageTimestamp) * 1000).toISOString()
    : new Date().toISOString();

  socket.emit("message:created", {
    clientId: config.clientId,
    externalId: makeMessageExternalId(message.key),
    direction: fromMe ? "outbound" : "inbound",
    chatId: remoteJid,
    sender: fromMe ? (own || sock?.user?.id) : (peerPhone || peerJid),
    recipient: fromMe ? (peerPhone || remoteJid) : (own || sock?.user?.id),
    body,
    messageType: media ? "media" : (mediaInfo?.type || messageType(content)),
    createdAt,
    payload: {
      from: fromMe ? sock?.user?.id : peerJid,
      to: fromMe ? remoteJid : sock?.user?.id,
      author: participant,
      source,
      senderId: fromMe ? sock?.user?.id : peerJid,
      senderPhone: fromMe ? own : peerPhone,
      recipientPhone: fromMe ? peerPhone : own,
      contact: serializeContact(peerJid),
      media,
      caption: body,
      hasMedia: Boolean(mediaInfo),
      type: mediaInfo?.type || messageType(content),
      rawKey: message.key
    }
  });
}

function normalizeMessageContent(message = {}) {
  let content = message;
  for (const wrapper of ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "documentWithCaptionMessage"]) {
    if (content?.[wrapper]?.message) content = content[wrapper].message;
  }
  return content || {};
}

function messageType(content = {}) {
  return Object.keys(content).find((key) => key !== "messageContextInfo") || "text";
}

function messageBody(content = {}) {
  return content.conversation
    || content.extendedTextMessage?.text
    || content.imageMessage?.caption
    || content.videoMessage?.caption
    || content.documentMessage?.caption
    || content.buttonsResponseMessage?.selectedDisplayText
    || content.listResponseMessage?.title
    || content.templateButtonReplyMessage?.selectedDisplayText
    || "";
}

function mediaMessageInfo(message) {
  const content = normalizeMessageContent(message.message);
  const mediaTypes = [
    ["image", content.imageMessage],
    ["video", content.videoMessage],
    ["audio", content.audioMessage],
    ["document", content.documentMessage],
    ["sticker", content.stickerMessage]
  ];
  const [type, media] = mediaTypes.find(([, value]) => Boolean(value)) || [];
  if (!type || !media) return null;
  return {
    type,
    mimeType: media.mimetype || defaultMimeType(type),
    fileName: media.fileName || media.title || `whatsapp-${message.key?.id || Date.now()}${extensionFromMime(media.mimetype || defaultMimeType(type))}`
  };
}

function shouldLazyInboundMedia(mediaInfo) {
  if (mediaInfo.type !== "video") return false;
  return ["lazy", "thumbnail", "metadata"].includes(config.inboundVideoMode);
}

function lazyMediaPayload(message, mediaInfo, source) {
  const fileName = mediaInfo.fileName || `whatsapp-${message.key?.id || Date.now()}${extensionFromMime(mediaInfo.mimeType) || ".mp4"}`;
  return {
    originalName: fileName,
    filename: fileName,
    mimeType: mediaInfo.mimeType,
    source,
    whatsappMessageId: makeMessageExternalId(message.key),
    lazyDownload: true,
    downloadStatus: "pending"
  };
}

function startPeriodicHistorySync() {
  if (historySyncTimer || !config.historySyncOnReady) return;
  historySyncTimer = setInterval(() => {
    scheduleHistorySync("periodic");
  }, config.historySyncIntervalMs);
  historySyncTimer.unref?.();
}

function stopPeriodicHistorySync() {
  if (!historySyncTimer) return;
  clearInterval(historySyncTimer);
  historySyncTimer = null;
}

function scheduleHistorySync(reason, delayMs = 0) {
  if (!config.historySyncOnReady || !whatsappReady) return;
  setTimeout(() => {
    syncRecentMessages(reason).catch((error) => {
      console.error(`history sync failed (${reason}): ${error.message}`);
    });
  }, delayMs).unref?.();
}

async function syncRecentMessages(reason = "manual") {
  if (!whatsappReady || !sock) return;
  if (historySyncInProgress) {
    console.log(`history sync skipped (${reason}): previous sync is still running`);
    return;
  }
  historySyncInProgress = true;
  try {
    const chatIds = Array.from(knownChats.values())
      .filter((chat) => chat?.id)
      .sort((a, b) => Number(b.conversationTimestamp || b.timestamp || 0) - Number(a.conversationTimestamp || a.timestamp || 0))
      .slice(0, config.historySyncChatLimit)
      .map((chat) => chat.id);
    console.log(`history sync (${reason}): Baileys live messages are event-driven; cached chats=${chatIds.length}`);
  } finally {
    historySyncInProgress = false;
  }
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  reconnectAttempts += 1;
  const delayMs = Math.min(
    config.reconnectMaxDelayMs,
    config.reconnectMinDelayMs * 2 ** Math.min(reconnectAttempts - 1, 6)
  );
  console.warn(`scheduling Baileys reconnect in ${delayMs}ms: ${reason}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBaileys().catch((error) => {
      console.error(`failed to reconnect Baileys: ${error.message}`);
      scheduleReconnect(error.message);
    });
  }, delayMs);
  reconnectTimer.unref?.();
}

async function closeCurrentBaileysSocket(reason) {
  if (!sock) return;
  const current = sock;
  sock = null;
  try {
    current.ev?.removeAllListeners?.();
  } catch {
    // ignore cleanup errors from partially initialized sockets
  }
  try {
    await current.end?.(new Error(reason));
  } catch {
    // ignore cleanup errors from already closed sockets
  }
}

async function saveQr(qr) {
  if (config.printQrInTerminal) qrcodeTerminal.generate(qr, { small: true });
  try {
    await fsp.mkdir(config.qrOutputDir, { recursive: true });
    const clientQrPath = path.join(config.qrOutputDir, `whatsapp-qr-${safeFileName(config.clientId)}.png`);
    const latestQrPath = path.join(config.qrOutputDir, "whatsapp-qr-latest.png");
    await QRCode.toFile(clientQrPath, qr, { width: 420, margin: 2 });
    await QRCode.toFile(latestQrPath, qr, { width: 420, margin: 2 });
    console.log(`QR image saved: ${clientQrPath}`);
    console.log(`Latest QR image: ${latestQrPath}`);
  } catch (error) {
    console.error(`failed to save QR image: ${error.message}`);
  }
}

function rememberRecentMessage(message) {
  const id = makeMessageExternalId(message.key);
  if (!id) return;
  recentMessages.set(id, message);
  if (recentMessages.size > 500) {
    const firstKey = recentMessages.keys().next().value;
    recentMessages.delete(firstKey);
  }
}

function rememberChat(chat) {
  const id = chat?.id || chat?.jid;
  if (!id) return;
  knownChats.set(jidNormalizedUser(id), { ...chat, id: jidNormalizedUser(id) });
}

function rememberContact(contact) {
  const id = contact?.id || contact?.jid;
  if (!id) return;
  knownContacts.set(jidNormalizedUser(id), contact);
}

function serializeContact(jid) {
  const normalized = jid ? jidNormalizedUser(jid) : "";
  const contact = knownContacts.get(normalized) || {};
  return {
    id: normalized || null,
    server: normalized.includes("@") ? normalized.split("@")[1] : null,
    user: normalized.includes("@") ? normalized.split("@")[0] : normalized || null,
    number: jidToPhone(normalized),
    name: contact.name || contact.notify || contact.verifiedName || null,
    pushname: contact.notify || contact.name || null,
    shortName: contact.short || null,
    isBusiness: Boolean(contact.verifiedName || contact.biz)
  };
}

function makeMessageExternalId(key = {}) {
  if (!key.id) return null;
  return [key.remoteJid, key.id, key.participant || "", key.fromMe ? "fromMe" : ""].filter(Boolean).join(":");
}

function normalizeChatId(value) {
  const target = String(value || "").trim();
  if (!target) throw new Error("message target is empty or invalid");
  if (target.includes("@")) return jidNormalizedUser(target);
  const digits = target.replace(/\D/g, "");
  if (!digits) throw new Error("message target is empty or invalid");
  return `${digits}@s.whatsapp.net`;
}

function buildProxyUrl(proxyUrl, username, password) {
  if (!proxyUrl) return "";
  if (!username && !password) return proxyUrl;
  try {
    const url = new URL(proxyUrl);
    if (username) url.username = username;
    if (password) url.password = password;
    return url.toString();
  } catch {
    return proxyUrl;
  }
}

function maskProxyUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return value;
  }
}

function jidToPhone(jid) {
  const normalized = String(jid || "");
  if (!normalized.endsWith("@s.whatsapp.net")) return null;
  const digits = normalized.split("@")[0].replace(/\D/g, "");
  return digits || null;
}

function ownPhone() {
  return jidToPhone(sock?.user?.id) || sock?.user?.id?.split(":")[0]?.replace(/\D/g, "") || null;
}

function extensionFromMime(mimeType = "") {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "application/pdf": ".pdf"
  };
  return map[mimeType] || "";
}

function defaultMimeType(type) {
  return {
    image: "image/jpeg",
    video: "video/mp4",
    audio: "audio/ogg",
    document: "application/octet-stream",
    sticker: "image/webp"
  }[type] || "application/octet-stream";
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeFileName(value) {
  return String(value || "client").replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function isRecoverableBaileysError(error) {
  return /connection|closed|timed out|socket|stream|restart|required/i.test(error?.message || "");
}

function isWhatsAppNetworkRefusedError(error) {
  return /Opening handshake has timed out|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(error?.message || "");
}

process.on("SIGINT", async () => {
  stopPeriodicHistorySync();
  await sock?.end?.();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  stopPeriodicHistorySync();
  await sock?.end?.();
  process.exit(0);
});
