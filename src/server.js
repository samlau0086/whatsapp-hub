import cors from "cors";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireWebAdmin } from "./auth.js";
import { config } from "./config.js";
import {
  createApiRequest,
  createTask,
  createWebhook,
  deleteWebhook,
  getClient,
  getTask,
  listApiRequests,
  listClients,
  listMessages,
  listTasks,
  listWebhooks,
  removeClient,
  setClientStatus
} from "./db.js";
import { chooseClient, createHub } from "./hub.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const hub = createHub(server);

if (config.trustProxy) {
  app.set("trust proxy", 1);
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/", requireWebAdmin, express.static(path.join(__dirname, "public")));

app.use("/api", (req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    try {
      createApiRequest({
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        clientIp: req.ip,
        userAgent: req.header("user-agent"),
        requestBody: sanitizeRequestBody(req.body),
        responseTimeMs: Date.now() - startedAt
      });
    } catch (error) {
      console.error("failed to record api request", error);
    }
  });
  next();
});

app.use("/api", (req, res, next) => {
  const token = req.header("x-hub-token") || req.query.token;
  if (token !== config.apiToken) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "whatsapp-actor-hub", time: new Date().toISOString() });
});

app.get("/api/clients", (req, res) => {
  res.json({ clients: listClients() });
});

app.get("/api/clients/:id", (req, res) => {
  const client = getClient(req.params.id);
  if (!client) return res.status(404).json({ error: "client not found" });
  res.json({ client });
});

app.delete("/api/clients/:id", (req, res) => {
  setClientStatus(req.params.id, "offline");
  const deleted = removeClient(req.params.id);
  res.json({ ok: deleted });
});

app.get("/api/clients/:id/messages", (req, res) => {
  res.json({ messages: listMessages({ clientId: req.params.id, limit: req.query.limit }) });
});

app.get("/api/messages", (req, res) => {
  res.json({
    messages: listMessages({
      clientId: req.query.clientId,
      sender: req.query.sender,
      chatId: req.query.chatId,
      limit: req.query.limit
    })
  });
});

app.get("/api/requests", (req, res) => {
  res.json({
    requests: listApiRequests({
      method: req.query.method,
      statusCode: req.query.statusCode,
      limit: req.query.limit
    })
  });
});

app.post("/api/tasks/send-message", async (req, res) => {
  const { clientId, to, body, metadata } = req.body || {};
  if (!to || !body) {
    return res.status(400).json({ error: "to and body are required" });
  }

  const client = chooseClient(clientId);
  if (!client) {
    return res.status(409).json({ error: clientId ? "requested client is not online" : "no online clients available" });
  }

  const task = createTask({
    type: "send-message",
    clientId: client.id,
    targetPhone: to,
    payload: { to, body, metadata: metadata || {} }
  });
  const dispatched = await hub.dispatchTask(task);
  res.status(202).json({ task: dispatched });
});

app.get("/api/tasks", (req, res) => {
  res.json({ tasks: listTasks({ clientId: req.query.clientId, status: req.query.status, limit: req.query.limit }) });
});

app.get("/api/tasks/:id", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "task not found" });
  res.json({ task });
});

app.get("/api/webhooks", (req, res) => {
  res.json({ webhooks: listWebhooks() });
});

app.post("/api/webhooks", (req, res) => {
  const { url, events, secret } = req.body || {};
  if (!url) return res.status(400).json({ error: "url is required" });
  res.status(201).json({ webhook: createWebhook({ url, events, secret }) });
});

app.delete("/api/webhooks/:id", (req, res) => {
  res.json({ ok: deleteWebhook(req.params.id) });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

function sanitizeRequestBody(body) {
  if (!body || typeof body !== "object") return body || null;
  const redacted = { ...body };
  for (const key of Object.keys(redacted)) {
    if (/token|password|secret|key/i.test(key)) {
      redacted[key] = "[redacted]";
    }
  }
  return redacted;
}

server.listen(config.port, () => {
  console.log(`whatsapp actor hub listening on ${config.publicBaseUrl}`);
});
