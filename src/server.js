import cors from "cors";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashPassword,
  apiPermissions,
  authenticateApiToken,
  generateApiToken,
  getApiTokenFromRequest,
  hashApiToken,
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
  createClientConfig,
  createTask,
  createUser,
  assignTask,
  createApiToken,
  createWebhook,
  deleteUser,
  deleteWebhook,
  getClient,
  getClientConfigByClientId,
  getTask,
  getUser,
  findLastOutboundClientForTarget,
  listApiRequests,
  listApiTokens,
  listClientConfigs,
  listClients,
  listChats,
  listMessages,
  listTasks,
  listUsers,
  listWebhooks,
  purgeClientData,
  removeClient,
  revokeApiToken,
  setClientStatus,
  touchApiToken,
  updateApiToken,
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
  const token = getApiTokenFromRequest(req);
  if (authenticateApiToken(token, "uploads:create") || req.header("cookie")) return next();
  return res.status(401).send("unauthorized");
}, express.static(path.resolve(config.uploadDir)));

app.get("/", requireWebSession, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/agent/wwebjs-client.js", (req, res) => {
  res.type("text/javascript").sendFile(path.join(__dirname, "..", "agents", "wwebjs-client", "index.js"));
});

app.get("/agent/package.json", (req, res) => {
  res.json(agentPackageJson());
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
  res.json({ user: req.user, roles, apiPermissions });
});

app.get("/admin/api/clients", requireWebSession, requirePermission("clients:read"), (req, res) => {
  reconcileClientPresence();
  res.json({ clients: listClients() });
});

app.get("/admin/api/client-configs", requireWebSession, requirePermission("clients:read"), (req, res) => {
  res.json({ clientConfigs: listClientConfigs().map(publicClientConfig) });
});

app.post("/admin/api/client-configs", requireWebSession, requirePermission("clients:delete"), (req, res) => {
  const payload = req.body || {};
  const clientId = String(payload.clientId || "").trim();
  const name = String(payload.name || clientId).trim();
  if (!clientId) return res.status(400).json({ error: "clientId is required" });
  if (!/^[a-zA-Z0-9_.-]{2,64}$/.test(clientId)) {
    return res.status(400).json({ error: "clientId may contain letters, numbers, dot, underscore, and dash only" });
  }
  if (getClientConfigByClientId(clientId)) return res.status(409).json({ error: "client config already exists" });

  const rawToken = generateApiToken();
  const apiToken = createApiToken({
    name: `agent:${clientId}`,
    tokenHash: hashApiToken(rawToken),
    permissions: ["agent:connect", "uploads:create"],
    enabled: true,
    createdBy: req.user.id
  });
  const clientConfig = createClientConfig({
    clientId,
    name,
    hubUrl: String(payload.hubUrl || config.publicBaseUrl).trim(),
    authDataPath: String(payload.authDataPath || `./.wwebjs_auth_${clientId}`).trim(),
    cachePath: String(payload.cachePath || `./.wwebjs_cache_${clientId}`).trim(),
    proxyUrl: String(payload.proxyUrl || "").trim(),
    proxyUsername: String(payload.proxyUsername || "").trim(),
    proxyPassword: String(payload.proxyPassword || ""),
    headless: payload.headless !== false,
    apiTokenId: apiToken.id,
    createdBy: req.user.id
  });
  res.status(201).json({
    clientConfig: publicClientConfig(clientConfig),
    deployment: buildClientDeployment(clientConfig, rawToken)
  });
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

app.get("/admin/api/tokens", requireWebSession, requirePermission("api_tokens:manage"), (req, res) => {
  res.json({ tokens: listApiTokens().map(publicApiToken), permissions: apiPermissions });
});

app.post("/admin/api/tokens", requireWebSession, requirePermission("api_tokens:manage"), (req, res) => {
  const { name, permissions, enabled } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const invalid = (permissions || []).filter((permission) => !apiPermissions.includes(permission));
  if (invalid.length) return res.status(400).json({ error: `invalid permissions: ${invalid.join(", ")}` });
  const rawToken = generateApiToken();
  const token = createApiToken({
    name,
    tokenHash: hashApiToken(rawToken),
    permissions: permissions || [],
    enabled: enabled !== false,
    createdBy: req.user.id
  });
  res.status(201).json({ token: publicApiToken(token), secret: rawToken });
});

app.patch("/admin/api/tokens/:id", requireWebSession, requirePermission("api_tokens:manage"), (req, res) => {
  const { name, permissions, enabled } = req.body || {};
  const invalid = permissions ? permissions.filter((permission) => !apiPermissions.includes(permission)) : [];
  if (invalid.length) return res.status(400).json({ error: `invalid permissions: ${invalid.join(", ")}` });
  const token = updateApiToken(req.params.id, { name, permissions, enabled });
  if (!token) return res.status(404).json({ error: "token not found" });
  res.json({ token: publicApiToken(token) });
});

app.post("/admin/api/tokens/:id/revoke", requireWebSession, requirePermission("api_tokens:manage"), (req, res) => {
  const token = revokeApiToken(req.params.id);
  if (!token) return res.status(404).json({ error: "token not found" });
  res.json({ token: publicApiToken(token) });
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
  const token = getApiTokenFromRequest(req);
  const apiToken = authenticateApiToken(token);
  if (!apiToken) {
    return res.status(401).json({ error: "unauthorized" });
  }
  req.apiToken = apiToken;
  touchApiToken(apiToken.id);
  next();
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "whatsapp-actor-hub", time: new Date().toISOString() });
});

app.get("/api/auth/check", (req, res) => {
  res.json({
    ok: true,
    token: {
      id: req.apiToken.id,
      name: req.apiToken.name,
      permissions: req.apiToken.permissions,
      is_env_token: Boolean(req.apiToken.is_env_token)
    }
  });
});

app.get("/api/clients", (req, res) => {
  if (!hasApiPermission(req, "clients:read")) return res.status(403).json({ error: "forbidden" });
  reconcileClientPresence();
  res.json({ clients: listClients() });
});

app.get("/api/clients/:id", (req, res) => {
  if (!hasApiPermission(req, "clients:read")) return res.status(403).json({ error: "forbidden" });
  const client = getClient(req.params.id);
  if (!client) return res.status(404).json({ error: "client not found" });
  res.json({ client });
});

app.delete("/api/clients/:id", (req, res) => {
  if (!hasApiPermission(req, "clients:delete")) return res.status(403).json({ error: "forbidden" });
  forgetClientSocket(req.params.id);
  setClientStatus(req.params.id, "offline");
  const deleted = removeClient(req.params.id);
  res.json({ ok: deleted });
});

app.delete("/api/clients/:id/data", (req, res) => {
  if (!hasApiPermission(req, "clients:delete")) return res.status(403).json({ error: "forbidden" });
  forgetClientSocket(req.params.id);
  res.json({ ok: true, deleted: purgeClientData(req.params.id) });
});

app.get("/api/clients/:id/messages", (req, res) => {
  if (!hasApiPermission(req, "messages:read")) return res.status(403).json({ error: "forbidden" });
  res.json({ messages: listMessages({ clientId: req.params.id, limit: req.query.limit }) });
});

app.get("/api/messages", (req, res) => {
  if (!hasApiPermission(req, "messages:read")) return res.status(403).json({ error: "forbidden" });
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
  if (!hasApiPermission(req, "messages:read")) return res.status(403).json({ error: "forbidden" });
  res.json({ chats: listChats({ clientId: req.query.clientId, limit: req.query.limit }) });
});

app.get("/api/requests", (req, res) => {
  if (!hasApiPermission(req, "requests:read")) return res.status(403).json({ error: "forbidden" });
  res.json({
    requests: listApiRequests({
      method: req.query.method,
      statusCode: req.query.statusCode,
      limit: req.query.limit
    })
  });
});

app.post("/api/uploads", upload.single("file"), (req, res) => {
  if (!hasApiPermission(req, "uploads:create")) return res.status(403).json({ error: "forbidden" });
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
  if (!hasApiPermission(req, "tasks:send")) return res.status(403).json({ error: "forbidden" });
  const dispatched = await createAndDispatchMessageTask(req, res);
  if (dispatched) res.status(202).json({ task: dispatched });
});

app.get("/api/tasks", (req, res) => {
  if (!hasApiPermission(req, "tasks:read")) return res.status(403).json({ error: "forbidden" });
  res.json({ tasks: listTasks({ clientId: req.query.clientId, status: req.query.status, limit: req.query.limit }) });
});

app.get("/api/tasks/:id", (req, res) => {
  if (!hasApiPermission(req, "tasks:read")) return res.status(403).json({ error: "forbidden" });
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "task not found" });
  res.json({ task });
});

app.patch("/api/tasks/:id/assign", async (req, res) => {
  if (!hasApiPermission(req, "tasks:assign")) return res.status(403).json({ error: "forbidden" });
  const { clientId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: "clientId is required" });
  if (!getClient(clientId)) return res.status(404).json({ error: "client not found" });
  const task = assignTask(req.params.id, clientId);
  if (!task) return res.status(404).json({ error: "task not found" });
  const dispatched = await hub.dispatchTask(task);
  res.json({ task: dispatched });
});

app.get("/api/webhooks", (req, res) => {
  if (!hasApiPermission(req, "webhooks:manage")) return res.status(403).json({ error: "forbidden" });
  res.json({ webhooks: listWebhooks() });
});

app.post("/api/webhooks", (req, res) => {
  if (!hasApiPermission(req, "webhooks:manage")) return res.status(403).json({ error: "forbidden" });
  const { url, events, secret } = req.body || {};
  if (!url) return res.status(400).json({ error: "url is required" });
  res.status(201).json({ webhook: createWebhook({ url, events, secret }) });
});

app.delete("/api/webhooks/:id", (req, res) => {
  if (!hasApiPermission(req, "webhooks:manage")) return res.status(403).json({ error: "forbidden" });
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

function hasApiPermission(req, permission) {
  return req.apiToken?.permissions?.includes("*") || req.apiToken?.permissions?.includes(permission);
}

function publicApiToken(token) {
  return token && {
    id: token.id,
    name: token.name,
    permissions: token.permissions,
    enabled: token.enabled,
    created_by: token.created_by,
    created_at: token.created_at,
    updated_at: token.updated_at,
    last_used_at: token.last_used_at,
    revoked_at: token.revoked_at
  };
}

function publicClientConfig(clientConfig) {
  return clientConfig && {
    id: clientConfig.id,
    client_id: clientConfig.client_id,
    name: clientConfig.name,
    hub_url: clientConfig.hub_url,
    auth_data_path: clientConfig.auth_data_path,
    cache_path: clientConfig.cache_path,
    proxy_url: clientConfig.proxy_url,
    proxy_username: clientConfig.proxy_username,
    headless: clientConfig.headless,
    api_token_id: clientConfig.api_token_id,
    created_at: clientConfig.created_at,
    updated_at: clientConfig.updated_at
  };
}

function agentPackageJson() {
  return {
    name: "whatsapp-hub-client-agent",
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      start: "node wwebjs-client.js"
    },
    dependencies: {
      dotenv: "^16.4.7",
      "qrcode-terminal": "^0.12.0",
      "socket.io-client": "^4.8.1",
      "whatsapp-web.js": "^1.34.7"
    }
  };
}

function buildClientDeployment(clientConfig, token) {
  const env = [
    ["HUB_URL", clientConfig.hub_url],
    ["CLIENT_ID", clientConfig.client_id],
    ["CLIENT_NAME", clientConfig.name],
    ["CLIENT_TOKEN", token],
    ["WWEBJS_AUTH_DATA_PATH", clientConfig.auth_data_path],
    ["WWEBJS_CACHE_PATH", clientConfig.cache_path],
    ["CLIENT_PROXY_URL", clientConfig.proxy_url || ""],
    ["CLIENT_PROXY_USERNAME", clientConfig.proxy_username || ""],
    ["CLIENT_PROXY_PASSWORD", clientConfig.proxy_password || ""],
    ["PUPPETEER_HEADLESS", clientConfig.headless ? "true" : "false"]
  ].map(([key, value]) => `${key}=${quoteEnv(value)}`).join("\n");

  const agentBaseUrl = new URL("/agent/", clientConfig.hub_url).toString();
  return {
    env,
    agentUrl: new URL("wwebjs-client.js", agentBaseUrl).toString(),
    packageUrl: new URL("package.json", agentBaseUrl).toString(),
    linux: [
      `mkdir -p whatsapp-agent-${clientConfig.client_id}`,
      `cd whatsapp-agent-${clientConfig.client_id}`,
      `curl -fsSL ${new URL("package.json", agentBaseUrl).toString()} -o package.json`,
      `curl -fsSL ${new URL("wwebjs-client.js", agentBaseUrl).toString()} -o wwebjs-client.js`,
      "cat > .env <<'EOF'",
      env,
      "EOF",
      "npm install",
      "npm start"
    ].join("\n"),
    windowsPowerShell: [
      `New-Item -ItemType Directory -Force whatsapp-agent-${clientConfig.client_id} | Out-Null`,
      `Set-Location whatsapp-agent-${clientConfig.client_id}`,
      `Invoke-WebRequest "${new URL("package.json", agentBaseUrl).toString()}" -OutFile package.json`,
      `Invoke-WebRequest "${new URL("wwebjs-client.js", agentBaseUrl).toString()}" -OutFile wwebjs-client.js`,
      "@'",
      env,
      "'@ | Set-Content -Encoding utf8 .env",
      "npm install",
      "npm start"
    ].join("\n")
  };
}

function quoteEnv(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`;
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
