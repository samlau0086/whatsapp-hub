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
  getClientConfig,
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
  updateClientConfig,
  updateClientConfigAgentToken,
  updateUser
} from "./db.js";
import { chooseClient, createHub, emitClientDeleted, forgetClientSocket, reconcileClientPresence } from "./hub.js";

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
app.use((req, res, next) => {
  if (["/", "/login", "/app.js", "/styles.css"].includes(req.path) || req.path.startsWith("/admin/api/") || req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
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

app.get("/admin/api/client-configs/:id/deployment", requireWebSession, requirePermission("clients:read"), (req, res) => {
  let clientConfig = getClientConfig(req.params.id);
  if (!clientConfig) return res.status(404).json({ error: "client config not found" });
  if (!clientConfig.agent_token) {
    const rawToken = generateApiToken();
    const apiToken = createApiToken({
      name: `agent:${clientConfig.client_id}`,
      tokenHash: hashApiToken(rawToken),
      permissions: ["agent:connect", "uploads:create"],
      enabled: true,
      createdBy: req.user.id
    });
    clientConfig = updateClientConfigAgentToken(clientConfig.id, {
      apiTokenId: apiToken.id,
      agentToken: rawToken
    });
  }
  res.json({
    clientConfig: editableClientConfig(clientConfig),
    deployment: buildClientDeployment(clientConfig, clientConfig.agent_token, requestPublicBaseUrl(req))
  });
});

app.patch("/admin/api/client-configs/:id", requireWebSession, requirePermission("clients:delete"), (req, res) => {
  const payload = req.body || {};
  const current = getClientConfig(req.params.id);
  if (!current) return res.status(404).json({ error: "client config not found" });
  const clientConfig = updateClientConfig(req.params.id, {
    name: String(payload.name || current.name).trim(),
    hubUrl: String(payload.hubUrl || requestPublicBaseUrl(req) || current.hub_url || config.publicBaseUrl).trim(),
    authDataPath: String(payload.authDataPath || current.auth_data_path || `./.wwebjs_auth_${current.client_id}`).trim(),
    cachePath: String(payload.cachePath || current.cache_path || `./.wwebjs_cache_${current.client_id}`).trim(),
    proxyUrl: String(payload.proxyUrl || "").trim(),
    proxyUsername: String(payload.proxyUsername || "").trim(),
    proxyPassword: String(payload.proxyPassword || ""),
    headless: payload.headless !== false
  });
  res.json({
    clientConfig: editableClientConfig(clientConfig),
    deployment: buildClientDeployment(clientConfig, clientConfig.agent_token, requestPublicBaseUrl(req))
  });
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
    hubUrl: String(payload.hubUrl || requestPublicBaseUrl(req) || config.publicBaseUrl).trim(),
    authDataPath: String(payload.authDataPath || `./.wwebjs_auth_${clientId}`).trim(),
    cachePath: String(payload.cachePath || `./.wwebjs_cache_${clientId}`).trim(),
    proxyUrl: String(payload.proxyUrl || "").trim(),
    proxyUsername: String(payload.proxyUsername || "").trim(),
    proxyPassword: String(payload.proxyPassword || ""),
    headless: payload.headless !== false,
    apiTokenId: apiToken.id,
    agentToken: rawToken,
    createdBy: req.user.id
  });
  res.status(201).json({
    clientConfig: publicClientConfig(clientConfig),
    deployment: buildClientDeployment(clientConfig, rawToken, requestPublicBaseUrl(req))
  });
});

app.delete("/admin/api/clients/:id", requireWebSession, requirePermission("clients:delete"), (req, res) => {
  forgetClientSocket(req.params.id);
  setClientStatus(req.params.id, "offline");
  const deleted = removeClient(req.params.id);
  if (deleted) emitClientDeleted(req.params.id);
  res.json({ ok: deleted });
});

app.delete("/admin/api/clients/:id/data", requireWebSession, requirePermission("clients:delete"), (req, res) => {
  forgetClientSocket(req.params.id);
  const deleted = purgeClientData(req.params.id);
  emitClientDeleted(req.params.id);
  res.json({ ok: true, deleted });
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
  if (deleted) emitClientDeleted(req.params.id);
  res.json({ ok: deleted });
});

app.delete("/api/clients/:id/data", (req, res) => {
  if (!hasApiPermission(req, "clients:delete")) return res.status(403).json({ error: "forbidden" });
  forgetClientSocket(req.params.id);
  const deleted = purgeClientData(req.params.id);
  emitClientDeleted(req.params.id);
  res.json({ ok: true, deleted });
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

function editableClientConfig(clientConfig) {
  return clientConfig && {
    ...publicClientConfig(clientConfig),
    proxy_password: clientConfig.proxy_password
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
      qrcode: "^1.5.4",
      "qrcode-terminal": "^0.12.0",
      "socket.io-client": "^4.8.1",
      "whatsapp-web.js": "^1.34.7"
    }
  };
}

function buildClientDeployment(clientConfig, token, fallbackHubUrl = config.publicBaseUrl) {
  const storedClient = getClient(clientConfig.client_id);
  const resolved = {
    hubUrl: clientConfig.hub_url || fallbackHubUrl || config.publicBaseUrl,
    clientId: clientConfig.client_id || storedClient?.id || "client-main",
    clientName: clientConfig.name || storedClient?.name || clientConfig.client_id || "WhatsApp Client",
    authDataPath: clientConfig.auth_data_path || `./.wwebjs_auth_${clientConfig.client_id || "client-main"}`,
    cachePath: clientConfig.cache_path || `./.wwebjs_cache_${clientConfig.client_id || "client-main"}`,
    proxyUrl: clientConfig.proxy_url || "",
    proxyUsername: clientConfig.proxy_username || "",
    proxyPassword: clientConfig.proxy_password || "",
    headless: clientConfig.headless !== false
  };
  const env = [
    ["HUB_URL", resolved.hubUrl],
    ["CLIENT_ID", resolved.clientId],
    ["CLIENT_NAME", resolved.clientName],
    ["CLIENT_TOKEN", token],
    ["WWEBJS_AUTH_DATA_PATH", resolved.authDataPath],
    ["WWEBJS_CACHE_PATH", resolved.cachePath],
    ["CLIENT_PROXY_URL", resolved.proxyUrl],
    ["CLIENT_PROXY_USERNAME", resolved.proxyUsername],
    ["CLIENT_PROXY_PASSWORD", resolved.proxyPassword],
    ["PUPPETEER_CACHE_DIR", "./.puppeteer-cache"],
    ["PUPPETEER_EXECUTABLE_PATH", ""],
    ["QR_OUTPUT_DIR", "."],
    ["PUPPETEER_HEADLESS", resolved.headless ? "true" : "false"]
  ].map(([key, value]) => `${key}=${quoteEnv(value)}`).join("\n");

  const agentBaseUrl = new URL("/agent/", resolved.hubUrl).toString();
  return {
    config: resolved,
    env,
    agentUrl: new URL("wwebjs-client.js", agentBaseUrl).toString(),
    packageUrl: new URL("package.json", agentBaseUrl).toString(),
    linux: buildLinuxAgentScript({ clientId: resolved.clientId, agentBaseUrl, env }),
    windowsBat: buildWindowsAgentScript({ clientId: resolved.clientId, agentBaseUrl, env })
  };
}

function requestPublicBaseUrl(req) {
  const protocol = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host");
  return host ? `${protocol}://${host}` : config.publicBaseUrl;
}

function quoteEnv(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`;
}

function buildLinuxAgentScript({ clientId, agentBaseUrl, env }) {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "need_node_major=18",
    "",
    "has_node() {",
    "  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && [ \"$(node -p 'Number(process.versions.node.split(`.`)[0])')\" -ge \"$need_node_major\" ];",
    "}",
    "",
    "install_node() {",
    "  if has_node; then",
    "    return",
    "  fi",
    "  echo \"Node.js ${need_node_major}+ and npm are required. Installing when possible...\"",
    "  if [ \"$(uname -s)\" = \"Darwin\" ]; then",
    "    if command -v brew >/dev/null 2>&1; then",
    "      brew install node",
    "    else",
    "      echo \"Homebrew is not installed. Install Node.js LTS from https://nodejs.org, then rerun this script.\" >&2",
    "      exit 1",
    "    fi",
    "  elif command -v apt-get >/dev/null 2>&1; then",
    "    sudo apt-get update",
    "    sudo apt-get install -y ca-certificates curl gnupg",
    "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -",
    "    sudo apt-get install -y nodejs",
    "    sudo apt-get install -y libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2 libgbm1 || true",
    "  elif command -v dnf >/dev/null 2>&1; then",
    "    sudo dnf install -y nodejs npm nss atk at-spi2-atk gtk3 libXScrnSaver alsa-lib mesa-libgbm",
    "  elif command -v yum >/dev/null 2>&1; then",
    "    sudo yum install -y nodejs npm nss atk at-spi2-atk gtk3 libXScrnSaver alsa-lib mesa-libgbm",
    "  elif command -v pacman >/dev/null 2>&1; then",
    "    sudo pacman -Sy --needed nodejs npm nss atk at-spi2-atk gtk3 libxss alsa-lib mesa",
    "  else",
    "    echo \"No supported package manager found. Install Node.js LTS and npm manually, then rerun this script.\" >&2",
    "    exit 1",
    "  fi",
    "  has_node || { echo \"Node.js/npm installation failed or version is too old.\" >&2; exit 1; }",
    "}",
    "",
    "download_file() {",
    "  url=\"$1\"",
    "  output=\"$2\"",
    "  if command -v curl >/dev/null 2>&1; then",
    "    curl -fsSL \"$url\" -o \"$output\"",
    "  elif command -v wget >/dev/null 2>&1; then",
    "    wget -q \"$url\" -O \"$output\"",
    "  else",
    "    echo \"curl or wget is required to download agent files.\" >&2",
    "    exit 1",
    "  fi",
    "}",
    "",
    "find_browser() {",
    "  for browser in \\",
    "    /usr/bin/google-chrome-stable \\",
    "    /usr/bin/google-chrome \\",
    "    /usr/bin/chromium-browser \\",
    "    /usr/bin/chromium \\",
    "    /snap/bin/chromium \\",
    "    /usr/bin/microsoft-edge-stable \\",
    "    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \\",
    "    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' \\",
    "    '/Applications/Chromium.app/Contents/MacOS/Chromium'; do",
    "    [ -x \"$browser\" ] && { printf '%s' \"$browser\"; return 0; }",
    "  done",
    "  return 1",
    "}",
    "",
    "install_dependencies() {",
    "  export PUPPETEER_CACHE_DIR=\"$PWD/.puppeteer-cache\"",
    "  detected_browser=\"${PUPPETEER_EXECUTABLE_PATH:-}\"",
    "  if [ -z \"$detected_browser\" ]; then",
    "    detected_browser=\"$(find_browser || true)\"",
    "  fi",
    "  if [ -n \"$detected_browser\" ]; then",
    "    export PUPPETEER_EXECUTABLE_PATH=\"$detected_browser\"",
    "    export PUPPETEER_SKIP_DOWNLOAD=true",
    "    echo \"Using local browser: $PUPPETEER_EXECUTABLE_PATH\"",
    "  else",
    "    echo \"No local Chrome/Chromium/Edge found. npm may try to download Puppeteer Chrome.\"",
    "  fi",
    "  if npm install --omit=dev; then",
    "    return",
    "  fi",
    "  echo \"npm install failed. Cleaning partial install and local Puppeteer cache, then retrying once...\" >&2",
    "  rm -rf node_modules package-lock.json .puppeteer-cache",
    "  npm cache verify || true",
    "  npm install --omit=dev",
    "}",
    "",
    "install_node",
    `mkdir -p whatsapp-agent-${shellSingleQuote(clientId)}`,
    `cd whatsapp-agent-${shellSingleQuote(clientId)}`,
    `download_file ${shellSingleQuote(new URL("package.json", agentBaseUrl).toString())} package.json`,
    `download_file ${shellSingleQuote(new URL("wwebjs-client.js", agentBaseUrl).toString())} wwebjs-client.js`,
    "cat > .env <<'EOF'",
    env,
    "EOF",
    "install_dependencies",
    "npm start"
  ].join("\n");
}

function buildWindowsAgentScript({ clientId, agentBaseUrl, env }) {
  return [
    "@echo off",
    "setlocal EnableExtensions",
    "cd /d \"%~dp0\"",
    "set \"REQUIRED_NODE_MAJOR=18\"",
    "set \"AGENT_DIR=whatsapp-agent-" + windowsBatchValue(clientId) + "\"",
    "",
    "echo Checking Node.js and npm...",
    "call :CheckNode",
    "if errorlevel 1 call :InstallNode",
    "call :CheckNode",
    "if errorlevel 1 (",
    "  echo.",
    "  echo Node.js 18+ and npm are still not available.",
    "  echo Please install Node.js LTS from https://nodejs.org and run this BAT again.",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "if not exist \"%AGENT_DIR%\" mkdir \"%AGENT_DIR%\"",
    "cd /d \"%AGENT_DIR%\"",
    "set \"PUPPETEER_CACHE_DIR=%CD%\\.puppeteer-cache\"",
    "call :DetectBrowser",
    "if defined DETECTED_BROWSER (",
    "  echo Using local browser: %DETECTED_BROWSER%",
    "  set \"PUPPETEER_EXECUTABLE_PATH=%DETECTED_BROWSER%\"",
    "  set \"PUPPETEER_SKIP_DOWNLOAD=true\"",
    ") else (",
    "  echo No local Chrome or Edge found. npm may try to download Puppeteer Chrome.",
    ")",
    "",
    "echo Downloading WhatsApp agent files...",
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest '${new URL("package.json", agentBaseUrl).toString()}' -OutFile 'package.json'"`,
    "if errorlevel 1 goto :DownloadFailed",
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest '${new URL("wwebjs-client.js", agentBaseUrl).toString()}' -OutFile 'wwebjs-client.js'"`,
    "if errorlevel 1 goto :DownloadFailed",
    "",
    "echo Writing .env...",
    `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${powershellEncodedWriteEnv(env)}`,
    "if errorlevel 1 goto :Failed",
    "",
    "echo Creating one-click startup script...",
    "call :WriteStartBat",
    "if errorlevel 1 goto :Failed",
    "",
    "echo Installing dependencies. This may take several minutes...",
    "call npm install --omit=dev",
    "if errorlevel 1 (",
    "  echo.",
    "  echo npm install failed. Cleaning partial install and local Puppeteer cache, then retrying once...",
    "  if exist node_modules rmdir /s /q node_modules",
    "  if exist package-lock.json del /f /q package-lock.json",
    "  if exist .puppeteer-cache rmdir /s /q .puppeteer-cache",
    "  call npm cache verify",
    "  call npm install --omit=dev",
    "  if errorlevel 1 goto :NpmFailed",
    ")",
    "",
    "echo Starting WhatsApp agent...",
    "call start-agent.bat",
    "if errorlevel 1 goto :Failed",
    "pause",
    "exit /b 0",
    "",
    ":CheckNode",
    "where node >nul 2>nul || exit /b 1",
    "where npm >nul 2>nul || exit /b 1",
    "for /f %%v in ('node -p \"Number(process.versions.node.split('.')[0])\"') do set \"NODE_MAJOR=%%v\"",
    "if not defined NODE_MAJOR exit /b 1",
    "if %NODE_MAJOR% LSS %REQUIRED_NODE_MAJOR% exit /b 1",
    "exit /b 0",
    "",
    ":InstallNode",
    "echo Node.js 18+ and npm are required. Installing when possible...",
    "where winget >nul 2>nul",
    "if not errorlevel 1 (",
    "  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements",
    "  call :RefreshPath",
    "  exit /b 0",
    ")",
    "where choco >nul 2>nul",
    "if not errorlevel 1 (",
    "  choco install nodejs-lts -y",
    "  call :RefreshPath",
    "  exit /b 0",
    ")",
    "echo Could not find winget or Chocolatey.",
    "exit /b 1",
    "",
    ":RefreshPath",
    "for /f \"skip=2 tokens=2,*\" %%A in ('reg query \"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\" /v Path 2^>nul') do set \"MACHINE_PATH=%%B\"",
    "for /f \"skip=2 tokens=2,*\" %%A in ('reg query \"HKCU\\Environment\" /v Path 2^>nul') do set \"USER_PATH=%%B\"",
    "set \"PATH=%MACHINE_PATH%;%USER_PATH%;%PATH%\"",
    "exit /b 0",
    "",
    ":DetectBrowser",
    "set \"DETECTED_BROWSER=\"",
    "if exist \"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe\" set \"DETECTED_BROWSER=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe\"",
    "if not defined DETECTED_BROWSER if exist \"%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe\" set \"DETECTED_BROWSER=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe\"",
    "if not defined DETECTED_BROWSER if exist \"%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe\" set \"DETECTED_BROWSER=%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe\"",
    "if not defined DETECTED_BROWSER if exist \"%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe\" set \"DETECTED_BROWSER=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe\"",
    "if not defined DETECTED_BROWSER if exist \"%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe\" set \"DETECTED_BROWSER=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe\"",
    "if not defined DETECTED_BROWSER if exist \"%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe\" set \"DETECTED_BROWSER=%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe\"",
    "exit /b 0",
    "",
    ":WriteStartBat",
    "(",
    "  echo @echo off",
    "  echo setlocal EnableExtensions",
    "  echo cd /d \"%%~dp0\"",
    "  echo set \"PUPPETEER_CACHE_DIR=%%CD%%\\.puppeteer-cache\"",
    "  echo if not exist package.json ^(",
    "  echo   echo package.json not found. Run the install BAT again first.",
    "  echo   pause",
    "  echo   exit /b 1",
    "  echo ^)",
    "  echo if not exist node_modules ^(",
    "  echo   echo Dependencies are missing. Running npm install...",
    "  echo   call npm install --omit=dev",
    "  echo   if errorlevel 1 ^(",
    "  echo     echo npm install failed. Run the install BAT again.",
    "  echo     pause",
    "  echo     exit /b 1",
    "  echo   ^)",
    "  echo ^)",
    "  echo echo Starting WhatsApp agent...",
    "  echo call npm start",
    "  echo if errorlevel 1 ^(",
    "  echo   echo WhatsApp agent stopped with an error.",
    "  echo   pause",
    "  echo   exit /b 1",
    "  echo ^)",
    ") > start-agent.bat",
    "exit /b 0",
    "",
    ":DownloadFailed",
    "echo Failed to download agent files. Check your network and Hub URL.",
    "pause",
    "exit /b 1",
    "",
    ":NpmFailed",
    "echo npm install failed again. Check the npm log shown above.",
    "pause",
    "exit /b 1",
    "",
    ":Failed",
    "echo Installation or startup failed. Check the error shown above.",
    "pause",
    "exit /b 1"
  ].join("\n");
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function windowsBatchValue(value) {
  return String(value).replace(/[%"]/g, "-");
}

function powershellEncodedWriteEnv(env) {
  const script = [
    "$envText = @'",
    env,
    "'@",
    "Set-Content -Encoding utf8 '.env' $envText"
  ].join("\n");
  return Buffer.from(script, "utf16le").toString("base64");
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
