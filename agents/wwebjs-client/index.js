import dotenv from "dotenv";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import QRCode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import { io } from "socket.io-client";
import pkg from "whatsapp-web.js";

dotenv.config();

const { Client, LocalAuth, MessageMedia } = pkg;

const configuredExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH || "";
const executablePath = resolveBrowserExecutablePath(configuredExecutablePath);

const config = {
  hubUrl: process.env.HUB_URL || "http://localhost:3000",
  token: process.env.CLIENT_TOKEN || process.env.HUB_API_TOKEN || "dev-token",
  clientId: process.env.CLIENT_ID || "client-main",
  clientName: process.env.CLIENT_NAME || "Main WhatsApp Client",
  authDataPath: path.resolve(process.env.WWEBJS_AUTH_DATA_PATH || ".wwebjs_auth"),
  cachePath: path.resolve(process.env.WWEBJS_CACHE_PATH || ".wwebjs_cache"),
  proxyUrl: process.env.CLIENT_PROXY_URL || "",
  proxyUsername: process.env.CLIENT_PROXY_USERNAME || "",
  proxyPassword: process.env.CLIENT_PROXY_PASSWORD || "",
  executablePath,
  qrOutputDir: path.resolve(process.env.QR_OUTPUT_DIR || "."),
  headless: process.env.PUPPETEER_HEADLESS !== "false",
  historySyncOnReady: process.env.HISTORY_SYNC_ON_READY !== "false",
  historySyncChatLimit: numberFromEnv("HISTORY_SYNC_CHAT_LIMIT", 50),
  historySyncMessageLimit: numberFromEnv("HISTORY_SYNC_MESSAGE_LIMIT", 30)
};

const puppeteerArgs = ["--no-sandbox", "--disable-setuid-sandbox"];
if (config.proxyUrl) {
  puppeteerArgs.push(`--proxy-server=${config.proxyUrl}`);
}

const socket = io(config.hubUrl, {
  auth: { token: config.token },
  reconnection: true,
  reconnectionDelayMax: 10_000
});

const whatsapp = new Client({
  authStrategy: new LocalAuth({
    clientId: config.clientId,
    dataPath: config.authDataPath
  }),
  ...(config.proxyUsername || config.proxyPassword
    ? {
        proxyAuthentication: {
          username: config.proxyUsername,
          password: config.proxyPassword
        }
      }
    : {}),
  puppeteer: {
    headless: config.headless,
    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
    args: puppeteerArgs
  },
  webVersionCache: {
    type: "local",
    path: config.cachePath
  }
});

console.log(`auth data path: ${config.authDataPath}`);
console.log(`web cache path: ${config.cachePath}`);
console.log(`proxy: ${config.proxyUrl || "disabled"}`);
console.log(`browser executable: ${config.executablePath || "Puppeteer managed Chrome"}`);
console.log(`qr image output: ${config.qrOutputDir}`);
console.log(`history sync: ${config.historySyncOnReady ? `${config.historySyncChatLimit} chats x ${config.historySyncMessageLimit} messages` : "disabled"}`);

function emitHello(status = "online") {
  socket.emit("client:hello", {
    id: config.clientId,
    name: config.clientName,
    phone: whatsapp.info?.wid?.user || null,
    status,
    metadata: {
      platform: "whatsapp-web.js",
      pushname: whatsapp.info?.pushname || null
    }
  }, (response) => {
    if (!response?.ok) {
      console.error(`Hub rejected client hello: ${response?.error || "unknown error"}`);
    } else {
      console.log(`Hub registered client ${config.clientId} as ${response.client?.status || status}`);
    }
  });
}

socket.on("connect", () => {
  emitHello();
});

socket.on("connect_error", (error) => {
  console.error(`Hub socket connection failed: ${error.message}`);
});

socket.on("task:send-message", async (task, ack) => {
  ack?.({ accepted: true });
  try {
    const { to, chatId: payloadChatId, body } = task.payload;
    const chatId = normalizeChatId(payloadChatId || to);
    const mediaPayload = task.payload.media;
    const localMediaPath = mediaPayload?.url ? await downloadMedia(mediaPayload) : null;
    const result = localMediaPath
      ? await whatsapp.sendMessage(chatId, MessageMedia.fromFilePath(localMediaPath), {
          caption: body || "",
          sendMediaAsDocument: mediaPayload.sendAsDocument === true
        })
      : await whatsapp.sendMessage(chatId, body);
    socket.emit("task:result", {
      taskId: task.id,
      ok: true,
      result: {
        messageId: result.id?._serialized,
        chatId
      }
    });
  } catch (error) {
    socket.emit("task:result", {
      taskId: task.id,
      ok: false,
      error: error.message
    });
  }
});

socket.on("contact:resolve", async (payload = {}, ack) => {
  try {
    const chatId = normalizeChatId(payload.chatId || payload.id || payload.to);
    const contact = await whatsapp.getContactById(chatId);
    ack?.({ ok: true, contact: serializeContact(contact), chatId });
  } catch (error) {
    ack?.({ ok: false, error: error.message });
  }
});

async function downloadMedia(mediaPayload) {
  const url = new URL(mediaPayload.url, config.hubUrl).toString();
  const response = await fetch(url, {
    headers: { "x-hub-token": config.token }
  });
  if (!response.ok) throw new Error(`failed to download media: ${response.status}`);
  const extension = path.extname(mediaPayload.originalName || "") || "";
  const filePath = path.join(os.tmpdir(), `wah-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(filePath, bytes);
  return filePath;
}

setInterval(() => {
  if (socket.connected) {
    socket.emit("client:heartbeat", {
      id: config.clientId,
      name: config.clientName,
      phone: whatsapp.info?.wid?.user || null,
      status: "online",
      metadata: {
        platform: "whatsapp-web.js",
        pushname: whatsapp.info?.pushname || null
      }
    });
  }
}, 15_000).unref();

whatsapp.on("qr", async (qr) => {
  qrcodeTerminal.generate(qr, { small: true });
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
});

whatsapp.on("ready", async () => {
  emitHello();
  console.log(`${config.clientId} is ready`);
  if (config.historySyncOnReady) {
    await syncRecentMessages().catch((error) => {
      console.error(`history sync failed: ${error.message}`);
    });
  }
});

whatsapp.on("authenticated", () => {
  console.log(`${config.clientId} authenticated`);
});

whatsapp.on("disconnected", (reason) => {
  socket.emit("client:heartbeat", { id: config.clientId, status: "offline", reason });
});

whatsapp.on("message", async (message) => {
  await emitHubMessage(message, "message");
});

whatsapp.on("message_create", async (message) => {
  if (!message.fromMe) return;
  await emitHubMessage(message, "message_create");
});

whatsapp.initialize();

async function syncRecentMessages() {
  console.log("starting history sync");
  const chats = await whatsapp.getChats();
  const recentChats = chats
    .filter((chat) => chat?.id?._serialized)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, config.historySyncChatLimit);
  let synced = 0;

  for (const chat of recentChats) {
    try {
      const messages = await chat.fetchMessages({ limit: config.historySyncMessageLimit });
      for (const message of messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))) {
        await emitHubMessage(message, "history_sync");
        synced += 1;
      }
    } catch (error) {
      console.error(`failed to sync chat ${chat.id?._serialized || "unknown"}: ${error.message}`);
    }
  }

  console.log(`history sync completed: ${synced} messages from ${recentChats.length} chats`);
}

function safeFileName(value) {
  return String(value || "client").replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function normalizeChatId(value) {
  const target = String(value || "").trim();
  if (target.includes("@")) return target;
  const digits = target.replace(/\D/g, "");
  if (!digits) throw new Error("message target is empty or invalid");
  return `${digits}@c.us`;
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function resolveMessageContact(message) {
  const contactId = message.fromMe ? message.to : (message.author || message.from);
  if (contactId) {
    try {
      return await whatsapp.getContactById(contactId);
    } catch {
      // Fall through to the message helper. Some group and newsletter ids do not
      // resolve cleanly through getContactById.
    }
  }
  try {
    return await message.getContact();
  } catch {
    return null;
  }
}

async function emitHubMessage(message, source) {
  const contact = await resolveMessageContact(message);
  const contactInfo = serializeContact(contact);
  const direction = message.fromMe ? "outbound" : "inbound";
  const chatId = message.fromMe ? message.to : message.from;
  const peerId = message.fromMe ? message.to : (message.author || message.from);
  const peerPhone = contactInfo?.number || contactInfo?.phone || null;
  const ownPhone = whatsapp.info?.wid?.user || null;

  socket.emit("message:created", {
    clientId: config.clientId,
    externalId: message.id?._serialized,
    direction,
    chatId,
    sender: message.fromMe ? (ownPhone || message.from) : (peerPhone || peerId),
    recipient: message.fromMe ? (peerPhone || message.to) : (ownPhone || message.to),
    body: message.body,
    messageType: message.type,
    createdAt: message.timestamp ? new Date(message.timestamp * 1000).toISOString() : new Date().toISOString(),
    payload: {
      from: message.from,
      to: message.to,
      author: message.author,
      source,
      senderId: message.fromMe ? (whatsapp.info?.wid?._serialized || message.from) : peerId,
      senderPhone: message.fromMe ? ownPhone : peerPhone,
      recipientPhone: message.fromMe ? peerPhone : ownPhone,
      contact: contactInfo,
      hasMedia: message.hasMedia,
      type: message.type
    }
  });
}

function serializeContact(contact) {
  if (!contact) return null;
  return {
    id: contact.id?._serialized || null,
    server: contact.id?.server || null,
    user: contact.id?.user || null,
    number: contact.number || null,
    name: contact.name || null,
    pushname: contact.pushname || null,
    shortName: contact.shortName || null,
    isBusiness: Boolean(contact.isBusiness),
    isEnterprise: Boolean(contact.isEnterprise),
    isGroup: Boolean(contact.isGroup),
    isMe: Boolean(contact.isMe),
    isMyContact: Boolean(contact.isMyContact),
    isUser: Boolean(contact.isUser),
    isWAContact: Boolean(contact.isWAContact)
  };
}

function findInstalledBrowser() {
  const candidates = browserCandidates();
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function resolveBrowserExecutablePath(configuredPath) {
  if (configuredPath && fs.existsSync(configuredPath)) {
    return configuredPath;
  }
  if (configuredPath) {
    console.warn(`PUPPETEER_EXECUTABLE_PATH does not exist: ${configuredPath}`);
  }
  return findInstalledBrowser();
}

function browserCandidates() {
  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA
    ].filter(Boolean);
    return [
      ...roots.map((root) => path.join(root, "Google", "Chrome", "Application", "chrome.exe")),
      ...roots.map((root) => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
      ...roots.map((root) => path.join(root, "Chromium", "Application", "chrome.exe"))
    ];
  }

  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ];
  }

  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge-stable"
  ];
}
