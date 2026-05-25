import cors from "cors";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashPassword,
  loginUser,
  logoutUser,
  publicUser,
  requirePermission,
  requireWebSession,
  roles,
  setSessionCookie
} from "./auth.js";
import { config } from "./config.js";
import {
  createApiRequest,
  createTask,
  createUser,
  assignTask,
  createWebhook,
  deleteUser,
  deleteWebhook,
  getClient,
  getTask,
  getUser,
  findLastOutboundClientForTarget,
  listApiRequests,
  listClients,
  listChats,
  listMessages,
  listTasks,
  listUsers,
  listWebhooks,
  purgeClientData,
  removeClient,
  setClientStatus,
  updateUser
} from "./db.js";
import { chooseClient, createHub, forgetClientSocket, reconcileClientPresence } from "./hub.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const hub = createHub(server);
fs.mkdirSync(config.uploadDir, { recursive: true });
const upload = multer({ dest: config.uploadDir, limits: { fileSize: 50 * 1024 * 1024 } });

if (config.trustProxy) {
  app.set("trust proxy", 1);
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.use("/uploads", (req, res, next) => {
  const token = req.header("x-hub-token") || req.query.token;
  if (token === config.apiToken || req.header("cookie")) return next();
  return res.status(401).send("unauthorized");
}, express.static(path.resolve(config.uploadDir)));

app.get("/", requireWebSession, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const result = loginUser(username, password, req);
  if (!result) return res.status(401).json({ error: "invalid credentials" });
  setSessionCookie(res, result.token, result.expiresAt);
  res.json({ user: result.user });
});

app.post("/auth/logout", (req, res) => {
  logoutUser(req, res);
  res.json({ ok: true });
});

app.get("/admin/api/me", requireWebSession, (req, res) => {
  res.json({ user: req.user, roles });
});

app.get("/admin/api/clients", requireWebSession, requirePermission("clients:read"), (req, res) => {
  reconcileClientPresence();
  res.json({ clients: listClients() });
});

app.delete("/admin/api/clients/:id", requireWebSession, requirePermission("clients:delete"), (req, res) => {
  forgetClientSocket(req.params.id);
  setClientStatus(req.params.id, "offline");
  const deleted = removeClient(req.params.id);
  res.json({ ok: deleted });
});

app.delete("/admin/api/clients/:id/data", requireWebSession, requirePermission("clients:delete"), (req, res) => {
  forgetClientSocket(req.params.id);
  res.json({ ok: true, deleted: purgeClientData(req.params.id) });
});

app.get("/admin/api/messages", requireWebSession, requirePermission("messages:read"), (req, res) => {
  res.json({
    messages: listMessages({
      clientId: req.query.clientId,
      sender: req.query.sender,
      chatId: req.query.chatId,
      targetPhone: req.query.targetPhone,
      limit: req.query.limit
    })
  });
});

app.get("/admin/api/chats", requireWebSession, requirePermission("messages:read"), (req, res) => {
  res.json({ chats: listChats({ clientId: req.query.clientId, limit: req.query.limit }) });
});

app.get("/admin/api/clients/:id/messages", requireWebSession, requirePermission("messages:read"), (req, res) => {
  res.json({ messages: listMessages({ clientId: req.params.id, limit: req.query.limit }) });
});

app.get("/admin/api/tasks", requireWebSession, requirePermission("tasks:read"), (req, res) => {
  res.json({ tasks: listTasks({ clientId: req.query.clientId, status: req.query.status, limit: req.query.limit }) });
});

app.patch("/admin/api/tasks/:id/assign", requireWebSession, requirePermission("tasks:send"), async (req, res) => {
  const { clientId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: "clientId is required" });
  if (!getClient(clientId)) return res.status(404).json({ error: "client not found" });
  const task = assignTask(req.params.id, clientId);
  if (!task) return res.status(404).json({ error: "task not found" });
  const dispatched = await hub.dispatchTask(task);
  res.json({ task: dispatched });
});

app.post("/admin/api/tasks/send-message", requireWebSession, requirePermission("tasks:send"), async (req, res) => {
  const dispatched = await createAndDispatchMessageTask(req, res);
  if (dispatched) res.status(202).json({ task: dispatched });
});

app.post("/admin/api/uploads", requireWebSession, requirePermission("tasks:send"), upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required" });
  res.status(201).json({
    file: {
      id: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
      url: `/uploads/${req.file.filename}`
    }
  });
});

app.get("/admin/api/requests", requireWebSession, requirePermission("requests:read"), (req, res) => {
  res.json({
    requests: listApiRequests({
      method: req.query.method,
      statusCode: req.query.statusCode,
      limit: req.query.limit
    })
  });
});

app.get("/admin/api/users", requireWebSession, requirePermission("users:manage"), (req, res) => {
  res.json({ users: listUsers().map(publicUser), roles });
});

app.post("/admin/api/users", requireWebSession, requirePermission("users:manage"), (req, res) => {
  const { username, displayName, password, role, enabled } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username and password are required" });
  if (!roles[role]) return res.status(400).json({ error: "invalid role" });
  const user = createUser({
    username,
    displayName,
    passwordHash: hashPassword(password),
    role,
    enabled: enabled !== false
  });
  res.status(201).json({ user: publicUser(user) });
});

app.patch("/admin/api/users/:id", requireWebSession, requirePermission("users:manage"), (req, res) => {
  const current = getUser(req.params.id);
  if (!current) return res.status(404).json({ error: "user not found" });
  const { username, displayName, password, role, enabled } = req.body || {};
  if (role && !roles[role]) return res.status(400).json({ error: "invalid role" });
  const user = updateUser(req.params.id, {
    username,
    displayName,
    passwordHash: password ? hashPassword(password) : undefined,
    role,
    enabled
  });
  res.json({ user: publicUser(user) });
});

app.delete("/admin/api/users/:id", requireWebSession, requirePermission("users:manage"), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "cannot delete yourself" });
  res.json({ ok: deleteUser(req.params.id) });
});

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
  reconcileClientPresence();
  res.json({ clients: listClients() });
});

app.get("/api/clients/:id", (req, res) => {
  const client = getClient(req.params.id);
  if (!client) return res.status(404).json({ error: "client not found" });
  res.json({ client });
});

app.delete("/api/clients/:id", (req, res) => {
  forgetClientSocket(req.params.id);
  setClientStatus(req.params.id, "offline");
  const deleted = removeClient(req.params.id);
  res.json({ ok: deleted });
});

app.delete("/api/clients/:id/data", (req, res) => {
  forgetClientSocket(req.params.id);
  res.json({ ok: true, deleted: purgeClientData(req.params.id) });
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
      targetPhone: req.query.targetPhone,
      limit: req.query.limit
    })
  });
});

app.get("/api/chats", (req, res) => {
  res.json({ chats: listChats({ clientId: req.query.clientId, limit: req.query.limit }) });
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

app.post("/api/uploads", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required" });
  res.status(201).json({
    file: {
      id: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
      url: `/uploads/${req.file.filename}`
    }
  });
});

app.post("/api/tasks/send-message", async (req, res) => {
  const dispatched = await createAndDispatchMessageTask(req, res);
  if (dispatched) res.status(202).json({ task: dispatched });
});

app.get("/api/tasks", (req, res) => {
  res.json({ tasks: listTasks({ clientId: req.query.clientId, status: req.query.status, limit: req.query.limit }) });
});

app.get("/api/tasks/:id", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "task not found" });
  res.json({ task });
});

app.patch("/api/tasks/:id/assign", async (req, res) => {
  const { clientId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: "clientId is required" });
  if (!getClient(clientId)) return res.status(404).json({ error: "client not found" });
  const task = assignTask(req.params.id, clientId);
  if (!task) return res.status(404).json({ error: "task not found" });
  const dispatched = await hub.dispatchTask(task);
  res.json({ task: dispatched });
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

async function createAndDispatchMessageTask(req, res) {
  const { clientId, to, body, metadata, media } = req.body || {};
  if (!to || (!body && !media)) {
    res.status(400).json({ error: "to and body or media are required" });
    return null;
  }

  const stickyClientId = findLastOutboundClientForTarget(to);
  const stickyClient = stickyClientId ? getClient(stickyClientId) : null;
  const client = stickyClient || (clientId ? getClient(clientId) : chooseClient(null));
  if (!client) {
    res.status(409).json({ error: clientId ? "requested client was not found" : "no online clients available" });
    return null;
  }

  const task = createTask({
    type: "send-message",
    clientId: client.id,
    targetPhone: to,
    payload: {
      to,
      body: body || "",
      media: media || null,
      metadata: metadata || {},
      routing: {
        reason: stickyClientId ? "sticky-target-client" : (clientId ? "requested-client" : "random-online-client"),
        requestedClientId: clientId || null,
        stickyClientId: stickyClientId || null
      }
    }
  });
  return hub.dispatchTask(task);
}

server.listen(config.port, () => {
  console.log(`whatsapp actor hub listening on ${config.publicBaseUrl}`);
});
