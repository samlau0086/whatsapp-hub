import dotenv from "dotenv";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import qrcode from "qrcode-terminal";
import { io } from "socket.io-client";
import pkg from "whatsapp-web.js";

dotenv.config();

const { Client, LocalAuth, MessageMedia } = pkg;

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
  headless: process.env.PUPPETEER_HEADLESS !== "false"
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
  });
}

socket.on("connect", () => {
  emitHello();
});

socket.on("task:send-message", async (task, ack) => {
  ack?.({ accepted: true });
  try {
    const { to, body } = task.payload;
    const chatId = to.includes("@c.us") ? to : `${to.replace(/\D/g, "")}@c.us`;
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

async function downloadMedia(mediaPayload) {
  const url = new URL(mediaPayload.url, config.hubUrl).toString();
  const response = await fetch(url, {
    headers: { "x-hub-token": config.token }
  });
  if (!response.ok) throw new Error(`failed to download media: ${response.status}`);
  const extension = path.extname(mediaPayload.originalName || "") || "";
  const filePath = path.join(os.tmpdir(), `wah-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, bytes);
  return filePath;
}

setInterval(() => {
  if (socket.connected) {
    socket.emit("client:heartbeat", { id: config.clientId, status: "online" });
  }
}, 15_000).unref();

whatsapp.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

whatsapp.on("ready", () => {
  emitHello();
  console.log(`${config.clientId} is ready`);
});

whatsapp.on("authenticated", () => {
  console.log(`${config.clientId} authenticated`);
});

whatsapp.on("disconnected", (reason) => {
  socket.emit("client:heartbeat", { id: config.clientId, status: "offline", reason });
});

whatsapp.on("message", async (message) => {
  socket.emit("message:created", {
    clientId: config.clientId,
    externalId: message.id?._serialized,
    direction: message.fromMe ? "outbound" : "inbound",
    chatId: message.from,
    sender: message.author || message.from,
    recipient: message.to,
    body: message.body,
    messageType: message.type,
    createdAt: message.timestamp ? new Date(message.timestamp * 1000).toISOString() : new Date().toISOString(),
    payload: {
      from: message.from,
      to: message.to,
      author: message.author,
      hasMedia: message.hasMedia,
      type: message.type
    }
  });
});

whatsapp.initialize();
