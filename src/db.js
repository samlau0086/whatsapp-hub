import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { pbkdf2Sync, randomUUID } from "node:crypto";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.function("stripChatIdServer", (value) => String(value || "").split("@")[0]);
db.function("digitsOnly", (value) => String(value || "").replace(/\D/g, ""));

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  client_id TEXT,
  target_phone TEXT,
  payload TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  client_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  chat_id TEXT,
  sender TEXT,
  recipient TEXT,
  body TEXT,
  message_type TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_client_created ON messages(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_client_created ON tasks(client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_requests (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  client_ip TEXT,
  user_agent TEXT,
  request_body TEXT,
  response_time_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_requests_created ON api_requests(created_at DESC);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS web_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

CREATE TABLE IF NOT EXISTS client_configs (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  hub_url TEXT NOT NULL,
  auth_data_path TEXT NOT NULL,
  cache_path TEXT NOT NULL,
  proxy_url TEXT,
  proxy_username TEXT,
  proxy_password TEXT,
  headless INTEGER NOT NULL DEFAULT 1,
  api_token_id TEXT,
  agent_token TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(api_token_id) REFERENCES api_tokens(id) ON DELETE SET NULL,
  FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_client_configs_client_id ON client_configs(client_id);

CREATE TABLE IF NOT EXISTS contact_mappings (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  client_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  contact_payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(client_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_mappings_phone ON contact_mappings(phone);
CREATE INDEX IF NOT EXISTS idx_contact_mappings_chat ON contact_mappings(client_id, chat_id);
`);

ensureColumn("client_configs", "agent_token", "TEXT");

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value === undefined ? {} : value);
const parseJson = (value, fallback = {}) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

migrateContactMappingsToAliases();
repairContactMappingAliases();
repairContactMappingsFromTasks();

const mapClient = (row) => row && ({ ...row, metadata: parseJson(row.metadata) });
const mapTask = (row) => row && ({ ...row, payload: parseJson(row.payload), result: parseJson(row.result, null) });
const mapMessage = (row) => {
  if (!row) return null;
  const payload = parseJson(row.payload);
  const contactPhone = row.contact_phone || payload?.senderPhone || payload?.recipientPhone || payload?.contact?.number || null;
  const conversationKey = contactPhone || row.chat_id || row.sender || row.recipient || null;
  return {
    ...row,
    payload,
    contact_phone: contactPhone,
    conversation_id: conversationKey,
    conversation_key: conversationKey,
    raw_chat_id: row.chat_id || null
  };
};
const mapWebhook = (row) => row && ({ ...row, events: parseJson(row.events, []), enabled: Boolean(row.enabled) });
const mapApiRequest = (row) => row && ({ ...row, request_body: parseJson(row.request_body, null) });
const mapUser = (row) => row && ({ ...row, enabled: Boolean(row.enabled) });
const mapApiToken = (row) => row && ({
  ...row,
  enabled: Boolean(row.enabled),
  permissions: parseJson(row.permissions, [])
});
const mapClientConfig = (row) => row && ({ ...row, headless: Boolean(row.headless) });
const mapContactMapping = (row) => row && ({ ...row, contact_payload: parseJson(row.contact_payload, {}) });

seedAdminUser();
ensureSuperAdminUser();

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
  if (!exists) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

export function upsertClient({ id, name, phone = null, metadata = {}, status = "online" }) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO clients (id, name, phone, status, metadata, created_at, updated_at, last_seen_at)
    VALUES (@id, @name, @phone, @status, @metadata, @created_at, @updated_at, @last_seen_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      phone = excluded.phone,
      status = excluded.status,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at
  `).run({
    id,
    name,
    phone,
    status,
    metadata: json(metadata),
    created_at: timestamp,
    updated_at: timestamp,
    last_seen_at: timestamp
  });
  return getClient(id);
}

export function touchClient(id, status = "online") {
  const timestamp = now();
  db.prepare("UPDATE clients SET status = ?, updated_at = ?, last_seen_at = ? WHERE id = ?")
    .run(status, timestamp, timestamp, id);
  return getClient(id);
}

export function setClientStatus(id, status) {
  const timestamp = now();
  db.prepare("UPDATE clients SET status = ?, updated_at = ? WHERE id = ?").run(status, timestamp, id);
  return getClient(id);
}

export function removeClient(id) {
  const transaction = db.transaction((clientId) => {
    db.prepare("DELETE FROM messages WHERE client_id = ?").run(clientId);
    db.prepare("DELETE FROM tasks WHERE client_id = ?").run(clientId);
    return db.prepare("DELETE FROM clients WHERE id = ?").run(clientId).changes > 0;
  });
  return transaction(id);
}

export function purgeClientData(id) {
  const transaction = db.transaction((clientId) => {
    const configRows = db.prepare("SELECT api_token_id FROM client_configs WHERE client_id = ?").all(clientId);
    for (const row of configRows) {
      if (row.api_token_id) {
        db.prepare("UPDATE api_tokens SET enabled = 0, revoked_at = ?, updated_at = ? WHERE id = ?")
          .run(now(), now(), row.api_token_id);
      }
    }
    const configs = db.prepare("DELETE FROM client_configs WHERE client_id = ?").run(clientId).changes;
    const messages = db.prepare("DELETE FROM messages WHERE client_id = ?").run(clientId).changes;
    const tasks = db.prepare("DELETE FROM tasks WHERE client_id = ?").run(clientId).changes;
    const clients = db.prepare("DELETE FROM clients WHERE id = ?").run(clientId).changes;
    return { clients, configs, tasks, messages };
  });
  return transaction(id);
}

export function getClient(id) {
  return mapClient(db.prepare("SELECT * FROM clients WHERE id = ?").get(id));
}

export function listClients() {
  return db.prepare("SELECT * FROM clients ORDER BY updated_at DESC").all().map(mapClient);
}

export function listOnlineClients() {
  return db.prepare("SELECT * FROM clients WHERE status = 'online' ORDER BY last_seen_at DESC").all().map(mapClient);
}

export function createClientConfig({
  clientId,
  name,
  hubUrl,
  authDataPath,
  cachePath,
  proxyUrl = "",
  proxyUsername = "",
  proxyPassword = "",
  headless = true,
  apiTokenId = null,
  agentToken = "",
  createdBy = null
}) {
  const timestamp = now();
  const id = randomUUID();
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO client_configs (
        id, client_id, name, hub_url, auth_data_path, cache_path,
        proxy_url, proxy_username, proxy_password, headless,
        api_token_id, agent_token, created_by, created_at, updated_at
      )
      VALUES (
        @id, @client_id, @name, @hub_url, @auth_data_path, @cache_path,
        @proxy_url, @proxy_username, @proxy_password, @headless,
        @api_token_id, @agent_token, @created_by, @created_at, @updated_at
      )
    `).run({
      id,
      client_id: clientId,
      name,
      hub_url: hubUrl,
      auth_data_path: authDataPath,
      cache_path: cachePath,
      proxy_url: proxyUrl,
      proxy_username: proxyUsername,
      proxy_password: proxyPassword,
      headless: headless ? 1 : 0,
      api_token_id: apiTokenId,
      agent_token: agentToken,
      created_by: createdBy,
      created_at: timestamp,
      updated_at: timestamp
    });

    db.prepare(`
      INSERT INTO clients (id, name, phone, status, metadata, created_at, updated_at, last_seen_at)
      VALUES (@id, @name, NULL, 'offline', @metadata, @created_at, @updated_at, NULL)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run({
      id: clientId,
      name,
      metadata: json({ configured: true }),
      created_at: timestamp,
      updated_at: timestamp
    });
  });
  transaction();
  return getClientConfig(id);
}

export function getClientConfig(id) {
  return mapClientConfig(db.prepare("SELECT * FROM client_configs WHERE id = ?").get(id));
}

export function getClientConfigByClientId(clientId) {
  return mapClientConfig(db.prepare("SELECT * FROM client_configs WHERE client_id = ?").get(clientId));
}

export function updateClientConfigAgentToken(id, { apiTokenId, agentToken }) {
  db.prepare(`
    UPDATE client_configs
    SET api_token_id = @api_token_id,
        agent_token = @agent_token,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    id,
    api_token_id: apiTokenId,
    agent_token: agentToken,
    updated_at: now()
  });
  return getClientConfig(id);
}

export function updateClientConfig(id, patch) {
  const current = getClientConfig(id);
  if (!current) return null;
  const next = {
    id,
    name: patch.name ?? current.name,
    hub_url: patch.hubUrl ?? current.hub_url,
    auth_data_path: patch.authDataPath ?? current.auth_data_path,
    cache_path: patch.cachePath ?? current.cache_path,
    proxy_url: patch.proxyUrl ?? current.proxy_url,
    proxy_username: patch.proxyUsername ?? current.proxy_username,
    proxy_password: patch.proxyPassword ?? current.proxy_password,
    headless: patch.headless === undefined ? (current.headless ? 1 : 0) : (patch.headless ? 1 : 0),
    updated_at: now()
  };
  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE client_configs
      SET name = @name,
          hub_url = @hub_url,
          auth_data_path = @auth_data_path,
          cache_path = @cache_path,
          proxy_url = @proxy_url,
          proxy_username = @proxy_username,
          proxy_password = @proxy_password,
          headless = @headless,
          updated_at = @updated_at
      WHERE id = @id
    `).run(next);
    db.prepare("UPDATE clients SET name = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.updated_at, current.client_id);
  });
  transaction();
  return getClientConfig(id);
}

export function listClientConfigs() {
  return db.prepare("SELECT * FROM client_configs ORDER BY updated_at DESC").all().map(mapClientConfig);
}

export function createTask({ type, clientId = null, targetPhone = null, payload }) {
  const timestamp = now();
  const task = {
    id: randomUUID(),
    type,
    status: "queued",
    client_id: clientId,
    target_phone: targetPhone,
    payload: json(payload),
    created_at: timestamp,
    updated_at: timestamp
  };
  db.prepare(`
    INSERT INTO tasks (id, type, status, client_id, target_phone, payload, created_at, updated_at)
    VALUES (@id, @type, @status, @client_id, @target_phone, @payload, @created_at, @updated_at)
  `).run(task);
  upsertContactMappingFromTask(task);
  return getTask(task.id);
}

export function updateTask(id, patch) {
  const current = getTask(id);
  if (!current) return null;
  const next = {
    status: patch.status ?? current.status,
    client_id: patch.clientId ?? current.client_id,
    result: patch.result === undefined ? json(current.result) : json(patch.result),
    error: Object.hasOwn(patch, "error") ? patch.error : current.error,
    completed_at: Object.hasOwn(patch, "completedAt") ? patch.completedAt : current.completed_at,
    updated_at: now(),
    id
  };
  db.prepare(`
    UPDATE tasks
    SET status = @status,
        client_id = @client_id,
        result = @result,
        error = @error,
        completed_at = @completed_at,
        updated_at = @updated_at
    WHERE id = @id
  `).run(next);
  return getTask(id);
}

export function assignTask(id, clientId) {
  return updateTask(id, {
    clientId,
    status: "queued",
    result: null,
    error: null,
    completedAt: null
  });
}

export function getTask(id) {
  return mapTask(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
}

export function listTasks({ clientId, status, limit = 100 } = {}) {
  const where = [];
  const params = {};
  if (clientId) {
    where.push("client_id = @clientId");
    params.clientId = clientId;
  }
  if (status) {
    where.push("status = @status");
    params.status = status;
  }
  params.limit = Math.min(Number(limit) || 100, 500);
  const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT @limit`;
  return db.prepare(sql).all(params).map(mapTask);
}

export function listQueuedTasksForClient(clientId, limit = 100) {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE client_id = ? AND status = 'queued'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(clientId, Math.min(Number(limit) || 100, 500)).map(mapTask);
}

export function createMessage(message) {
  const timestamp = now();
  const payload = message.payload || message;
  const row = {
    id: message.id || randomUUID(),
    external_id: message.externalId || null,
    client_id: message.clientId,
    direction: message.direction || "inbound",
    chat_id: message.chatId || null,
    sender: message.sender || null,
    recipient: message.recipient || null,
    body: message.body || "",
    message_type: message.messageType || "text",
    payload: json(payload),
    created_at: message.createdAt || timestamp,
    received_at: timestamp
  };
  if (row.external_id) {
    const existing = db.prepare(`
      SELECT id
      FROM messages
      WHERE client_id = ? AND external_id = ?
      LIMIT 1
    `).get(row.client_id, row.external_id);
    if (existing) return getMessage(existing.id);
  }
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, external_id, client_id, direction, chat_id, sender, recipient, body, message_type, payload, created_at, received_at)
    VALUES (@id, @external_id, @client_id, @direction, @chat_id, @sender, @recipient, @body, @message_type, @payload, @created_at, @received_at)
  `).run(row);
  upsertContactMappingFromMessage(row, payload);
  return getMessage(row.id);
}

export function createApiRequest(request) {
  const row = {
    id: randomUUID(),
    method: request.method,
    path: request.path,
    status_code: request.statusCode,
    client_ip: request.clientIp || null,
    user_agent: request.userAgent || null,
    request_body: request.requestBody === undefined ? null : json(request.requestBody),
    response_time_ms: request.responseTimeMs,
    created_at: now()
  };
  db.prepare(`
    INSERT INTO api_requests (id, method, path, status_code, client_ip, user_agent, request_body, response_time_ms, created_at)
    VALUES (@id, @method, @path, @status_code, @client_ip, @user_agent, @request_body, @response_time_ms, @created_at)
  `).run(row);
  return getApiRequest(row.id);
}

export function getMessage(id) {
  return mapMessage(db.prepare(`
    SELECT messages.*, ${contactPhoneSql("messages")} AS contact_phone
    FROM messages
    WHERE messages.id = ?
  `).get(id));
}

export function listMessages({ clientId, sender, chatId, targetPhone, limit = 100 } = {}) {
  const where = [];
  const params = {};
  if (clientId) {
    where.push("messages.client_id = @clientId");
    params.clientId = clientId;
  }
  if (sender) {
    where.push("messages.sender = @sender");
    params.sender = sender;
  }
  if (chatId) {
    where.push("messages.chat_id = @chatId");
    params.chatId = chatId;
  }
  if (targetPhone) {
    const phone = normalizePhone(targetPhone);
    const mappedChatIds = listChatIdsForPhone(phone, clientId);
    where.push(`(
      messages.sender LIKE @targetPhoneLike
      OR messages.recipient LIKE @targetPhoneLike
      OR messages.chat_id LIKE @targetPhoneLike
      OR EXISTS (
        SELECT 1
        FROM contact_mappings cm
        WHERE cm.client_id = messages.client_id
          AND cm.phone = @targetPhone
          AND (
            cm.chat_id = messages.chat_id
            OR stripChatIdServer(cm.chat_id) = stripChatIdServer(messages.chat_id)
            OR cm.phone = digitsOnly(messages.sender)
            OR cm.phone = digitsOnly(messages.recipient)
          )
      )
      ${mappedChatIds.length ? `OR messages.chat_id IN (${mappedChatIds.map((_, index) => `@mappedChatId${index}`).join(", ")})` : ""}
    )`);
    params.targetPhone = phone;
    params.targetPhoneLike = `%${phone}%`;
    mappedChatIds.forEach((mappedChatId, index) => {
      params[`mappedChatId${index}`] = mappedChatId;
    });
  }
  params.limit = Math.min(Number(limit) || 100, 500);
  const sql = `
    SELECT messages.*, ${contactPhoneSql("messages")} AS contact_phone
    FROM messages
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY messages.created_at DESC
    LIMIT @limit
  `;
  return db.prepare(sql).all(params).map(mapMessage);
}

export function listChats({ clientId, limit = 100 } = {}) {
  const params = { limit: Math.min(Number(limit) || 100, 500) };
  const where = ["messages.chat_id IS NOT NULL", "messages.chat_id != ''"];
  if (clientId) {
    where.push("messages.client_id = @clientId");
    params.clientId = clientId;
  }
  return db.prepare(`
    WITH mapped_messages AS (
      SELECT messages.*, ${contactPhoneSql("messages")} AS contact_phone
      FROM messages
      WHERE ${where.join(" AND ")}
    )
    SELECT
      COALESCE(contact_phone, chat_id) AS conversation_id,
      COALESCE(contact_phone, chat_id) AS conversation_key,
      contact_phone,
      COALESCE(
        (
          SELECT cm.chat_id
          FROM contact_mappings cm
          WHERE cm.client_id = mapped_messages.client_id
            AND cm.phone = mapped_messages.contact_phone
          ORDER BY cm.last_seen_at DESC
          LIMIT 1
        ),
        chat_id
      ) AS chat_id,
      client_id,
      MAX(created_at) AS last_message_at,
      COUNT(*) AS message_count,
      (
        SELECT body
        FROM mapped_messages m2
        WHERE m2.client_id = mapped_messages.client_id
          AND COALESCE(m2.contact_phone, m2.chat_id) = COALESCE(mapped_messages.contact_phone, mapped_messages.chat_id)
        ORDER BY m2.created_at DESC
        LIMIT 1
      ) AS last_body,
      (
        SELECT sender
        FROM mapped_messages m2
        WHERE m2.client_id = mapped_messages.client_id
          AND COALESCE(m2.contact_phone, m2.chat_id) = COALESCE(mapped_messages.contact_phone, mapped_messages.chat_id)
        ORDER BY m2.created_at DESC
        LIMIT 1
      ) AS last_sender
    FROM mapped_messages
    GROUP BY client_id, COALESCE(contact_phone, chat_id)
    ORDER BY last_message_at DESC
    LIMIT @limit
  `).all(params);
}

export function listContactMappings({ clientId, phone, limit = 100 } = {}) {
  const where = [];
  const params = {};
  if (clientId) {
    where.push("client_id = @clientId");
    params.clientId = clientId;
  }
  if (phone) {
    where.push("phone = @phone");
    params.phone = normalizePhone(phone);
  }
  params.limit = Math.min(Number(limit) || 100, 500);
  return db.prepare(`
    SELECT *
    FROM contact_mappings
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY last_seen_at DESC
    LIMIT @limit
  `).all(params).map(mapContactMapping);
}

export function getContactMappingByChatId({ clientId, chatId }) {
  if (!clientId || !chatId) return null;
  return mapContactMapping(db.prepare(`
    SELECT *
    FROM contact_mappings
    WHERE client_id = @clientId AND chat_id = @chatId
    LIMIT 1
  `).get({ clientId, chatId }));
}

export function getPreferredContactMappingForChatId({ clientId, chatId }) {
  if (!clientId || !chatId) return null;
  return mapContactMapping(db.prepare(`
    SELECT *
    FROM contact_mappings
    WHERE client_id = @clientId
      AND stripChatIdServer(chat_id) = stripChatIdServer(@chatId)
    ORDER BY
      CASE WHEN phone != stripChatIdServer(@chatId) THEN 0 ELSE 1 END,
      last_seen_at DESC
    LIMIT 1
  `).get({ clientId, chatId }));
}

export function findLastOutboundClientForTarget(targetPhone) {
  const phone = normalizePhone(targetPhone);
  if (!phone) return null;
  const row = db.prepare(`
    SELECT client_id
    FROM messages
    WHERE direction = 'outbound'
      AND (recipient LIKE @targetPhoneLike OR chat_id LIKE @targetPhoneLike)
    ORDER BY created_at DESC
    LIMIT 1
  `).get({ targetPhoneLike: `%${phone}%` });
  return row?.client_id || null;
}

export function findLastClientForPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const row = db.prepare(`
    SELECT client_id
    FROM contact_mappings
    WHERE phone = @phone
    ORDER BY last_seen_at DESC
    LIMIT 1
  `).get({ phone: normalized });
  return row?.client_id || null;
}

export function resolveChatIdForPhone({ phone, clientId }) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const where = ["phone = @phone"];
  const params = { phone: normalized };
  if (clientId) {
    where.push("client_id = @clientId");
    params.clientId = clientId;
  }
  return mapContactMapping(db.prepare(`
    SELECT *
    FROM contact_mappings
    WHERE ${where.join(" AND ")}
    ORDER BY
      CASE WHEN stripChatIdServer(chat_id) = @phone THEN 1 ELSE 0 END,
      last_seen_at DESC
    LIMIT 1
  `).get(params));
}

export function upsertContactMapping({ phone, clientId, chatId, contact = {} }) {
  const normalized = normalizePhone(phone);
  if (!normalized || !clientId || !chatId || !String(chatId).includes("@")) return null;
  const timestamp = now();
  const existing = getContactMappingByChatId({ clientId, chatId });
  const isAuthoritative = ["manual", "task", "task_recovery"].includes(contact?.source);
  const sibling = existing || getPreferredContactMappingForChatId({ clientId, chatId });
  const nextPhone = sibling && !isAuthoritative ? sibling.phone : normalized;
  const row = {
    id: randomUUID(),
    phone: nextPhone,
    client_id: clientId,
    chat_id: chatId,
    contact_payload: json({
      ...(existing && !isAuthoritative ? existing.contact_payload : {}),
      ...contact,
      preservedPhone: existing && !isAuthoritative && existing.phone !== normalized ? normalized : undefined
    }),
    created_at: timestamp,
    updated_at: timestamp,
    last_seen_at: timestamp
  };
  db.transaction(() => {
    db.prepare(`
      INSERT INTO contact_mappings (id, phone, client_id, chat_id, contact_payload, created_at, updated_at, last_seen_at)
      VALUES (@id, @phone, @client_id, @chat_id, @contact_payload, @created_at, @updated_at, @last_seen_at)
      ON CONFLICT(client_id, chat_id) DO UPDATE SET
        phone = excluded.phone,
        contact_payload = excluded.contact_payload,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
    `).run(row);

    if (isAuthoritative) {
      db.prepare(`
        UPDATE contact_mappings
        SET phone = @phone,
            contact_payload = @contact_payload,
            updated_at = @updated_at,
            last_seen_at = @last_seen_at
        WHERE client_id = @client_id
          AND stripChatIdServer(chat_id) = stripChatIdServer(@chat_id)
      `).run(row);
    }
  })();
  return getContactMappingByChatId({ clientId, chatId });
}

export function getApiRequest(id) {
  return mapApiRequest(db.prepare("SELECT * FROM api_requests WHERE id = ?").get(id));
}

export function listApiRequests({ method, statusCode, limit = 100 } = {}) {
  const where = [];
  const params = {};
  if (method) {
    where.push("method = @method");
    params.method = method;
  }
  if (statusCode) {
    where.push("status_code = @statusCode");
    params.statusCode = Number(statusCode);
  }
  params.limit = Math.min(Number(limit) || 100, 500);
  const sql = `SELECT * FROM api_requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT @limit`;
  return db.prepare(sql).all(params).map(mapApiRequest);
}

export function createWebhook({ url, events = ["message.created", "task.updated"], secret = null }) {
  const timestamp = now();
  const row = { id: randomUUID(), url, events: json(events), secret, created_at: timestamp, updated_at: timestamp };
  db.prepare("INSERT INTO webhooks (id, url, events, secret, created_at, updated_at) VALUES (@id, @url, @events, @secret, @created_at, @updated_at)").run(row);
  return getWebhook(row.id);
}

export function deleteWebhook(id) {
  return db.prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes > 0;
}

export function getWebhook(id) {
  return mapWebhook(db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id));
}

export function listWebhooks(eventName) {
  return db.prepare("SELECT * FROM webhooks WHERE enabled = 1 ORDER BY created_at DESC")
    .all()
    .map(mapWebhook)
    .filter((hook) => !eventName || hook.events.includes(eventName) || hook.events.includes("*"));
}

function upsertContactMappingFromMessage(row, payload) {
  if (!row.chat_id || !row.client_id) return;
  const contact = payload?.contact || {};
  const candidates = row.direction === "outbound"
    ? [payload?.recipientPhone, contact.number, row.recipient]
    : [payload?.senderPhone, contact.number, row.sender];
  const phone = candidates.map(normalizePhone).find(Boolean);
  if (!phone) return;
  upsertContactMapping({
    phone,
    clientId: row.client_id,
    chatId: row.chat_id,
    contact
  });
}

function upsertContactMappingFromTask(task) {
  if (task.type !== "send-message" || !task.client_id || !task.target_phone) return;
  const payload = parseJson(task.payload);
  const chatId = payload?.chatId;
  const phone = normalizePhone(task.target_phone);
  if (!phone || !chatId || !String(chatId).includes("@")) return;
  upsertContactMapping({
    phone,
    clientId: task.client_id,
    chatId,
    contact: {
      number: phone,
      id: chatId,
      source: "task",
      taskId: task.id
    }
  });
}

function listChatIdsForPhone(phone, clientId) {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];
  const where = ["phone = @phone"];
  const params = { phone: normalized };
  if (clientId) {
    where.push("client_id = @clientId");
    params.clientId = clientId;
  }
  return db.prepare(`
    SELECT chat_id
    FROM contact_mappings
    WHERE ${where.join(" AND ")}
    ORDER BY
      CASE WHEN stripChatIdServer(chat_id) = @phone THEN 1 ELSE 0 END,
      last_seen_at DESC
    LIMIT 50
  `).all(params).map((row) => row.chat_id);
}

function contactPhoneSql(alias) {
  return `(
    SELECT cm.phone
    FROM contact_mappings cm
    WHERE cm.client_id = ${alias}.client_id
      AND (
        cm.chat_id = ${alias}.chat_id
        OR stripChatIdServer(cm.chat_id) = stripChatIdServer(${alias}.chat_id)
        OR cm.phone = digitsOnly(${alias}.sender)
        OR cm.phone = digitsOnly(${alias}.recipient)
      )
    ORDER BY
      CASE
        WHEN cm.phone != stripChatIdServer(${alias}.chat_id) THEN 0
        ELSE 1
      END,
      CASE
        WHEN cm.chat_id = ${alias}.chat_id THEN 0
        WHEN stripChatIdServer(cm.chat_id) = stripChatIdServer(${alias}.chat_id) THEN 1
        ELSE 2
      END,
      cm.last_seen_at DESC
    LIMIT 1
  )`;
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function migrateContactMappingsToAliases() {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'contact_mappings'").get();
  if (!table?.sql?.includes("UNIQUE(client_id, phone)")) return;
  const oldTable = `contact_mappings_old_${Date.now()}`;
  db.transaction(() => {
    db.prepare(`ALTER TABLE contact_mappings RENAME TO ${oldTable}`).run();
    db.prepare(`
      CREATE TABLE contact_mappings (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        client_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        contact_payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(client_id, chat_id)
      )
    `).run();
    db.prepare(`
      INSERT OR IGNORE INTO contact_mappings (
        id, phone, client_id, chat_id, contact_payload, created_at, updated_at, last_seen_at
      )
      SELECT id, phone, client_id, chat_id, contact_payload, created_at, updated_at, last_seen_at
      FROM ${oldTable}
      ORDER BY last_seen_at DESC, updated_at DESC
    `).run();
    db.prepare(`DROP TABLE ${oldTable}`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_contact_mappings_phone ON contact_mappings(phone)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_contact_mappings_chat ON contact_mappings(client_id, chat_id)").run();
  })();
}

function repairContactMappingAliases() {
  db.prepare(`
    UPDATE contact_mappings
    SET phone = (
      SELECT preferred.phone
      FROM contact_mappings preferred
      WHERE preferred.client_id = contact_mappings.client_id
        AND stripChatIdServer(preferred.chat_id) = stripChatIdServer(contact_mappings.chat_id)
        AND preferred.phone != stripChatIdServer(preferred.chat_id)
      ORDER BY preferred.last_seen_at DESC
      LIMIT 1
    ),
    updated_at = @timestamp
    WHERE phone = stripChatIdServer(chat_id)
      AND EXISTS (
        SELECT 1
        FROM contact_mappings preferred
        WHERE preferred.client_id = contact_mappings.client_id
          AND stripChatIdServer(preferred.chat_id) = stripChatIdServer(contact_mappings.chat_id)
          AND preferred.phone != stripChatIdServer(preferred.chat_id)
      )
  `).run({ timestamp: new Date().toISOString() });
}

function repairContactMappingsFromTasks() {
  const rows = db.prepare(`
    SELECT id, type, client_id, target_phone, payload
    FROM tasks
    WHERE type = 'send-message'
      AND client_id IS NOT NULL
      AND target_phone IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 5000
  `).all();
  for (const row of rows) {
    upsertContactMappingFromTask(row);
  }
}

export function createUser({ username, displayName, passwordHash, role = "viewer", enabled = true }) {
  const timestamp = now();
  const row = {
    id: randomUUID(),
    username,
    display_name: displayName || username,
    password_hash: passwordHash,
    role,
    enabled: enabled ? 1 : 0,
    created_at: timestamp,
    updated_at: timestamp
  };
  db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, role, enabled, created_at, updated_at)
    VALUES (@id, @username, @display_name, @password_hash, @role, @enabled, @created_at, @updated_at)
  `).run(row);
  return getUser(row.id);
}

export function updateUser(id, patch) {
  const current = getUser(id);
  if (!current) return null;
  const next = {
    id,
    username: patch.username ?? current.username,
    display_name: patch.displayName ?? current.display_name,
    password_hash: patch.passwordHash ?? current.password_hash,
    role: patch.role ?? current.role,
    enabled: patch.enabled === undefined ? Number(current.enabled) : (patch.enabled ? 1 : 0),
    updated_at: now()
  };
  db.prepare(`
    UPDATE users
    SET username = @username,
        display_name = @display_name,
        password_hash = @password_hash,
        role = @role,
        enabled = @enabled,
        updated_at = @updated_at
    WHERE id = @id
  `).run(next);
  return getUser(id);
}

export function deleteUser(id) {
  return db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
}

export function getUser(id) {
  return mapUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
}

export function getUserByUsername(username) {
  return mapUser(db.prepare("SELECT * FROM users WHERE username = ?").get(username));
}

export function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY created_at ASC").all().map(mapUser);
}

export function markUserLogin(id) {
  db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
}

export function createSession({ token, userId, expiresAt, ip, userAgent }) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO web_sessions (token, user_id, ip, user_agent, created_at, updated_at, expires_at)
    VALUES (@token, @user_id, @ip, @user_agent, @created_at, @updated_at, @expires_at)
  `).run({
    token,
    user_id: userId,
    ip: ip || null,
    user_agent: userAgent || null,
    created_at: timestamp,
    updated_at: timestamp,
    expires_at: expiresAt
  });
  markUserLogin(userId);
  return getSession(token);
}

export function getSession(token) {
  const session = db.prepare("SELECT * FROM web_sessions WHERE token = ?").get(token);
  if (!session) return null;
  return { ...session, user: getUser(session.user_id) };
}

export function touchSession(token) {
  db.prepare("UPDATE web_sessions SET updated_at = ? WHERE token = ?").run(now(), token);
}

export function deleteSession(token) {
  return db.prepare("DELETE FROM web_sessions WHERE token = ?").run(token).changes > 0;
}

export function createApiToken({ name, tokenHash, permissions, createdBy = null, enabled = true }) {
  const timestamp = now();
  const row = {
    id: randomUUID(),
    name,
    token_hash: tokenHash,
    permissions: json(permissions || []),
    enabled: enabled ? 1 : 0,
    created_by: createdBy,
    created_at: timestamp,
    updated_at: timestamp
  };
  db.prepare(`
    INSERT INTO api_tokens (id, name, token_hash, permissions, enabled, created_by, created_at, updated_at)
    VALUES (@id, @name, @token_hash, @permissions, @enabled, @created_by, @created_at, @updated_at)
  `).run(row);
  return getApiToken(row.id);
}

export function updateApiToken(id, patch) {
  const current = getApiToken(id);
  if (!current) return null;
  const next = {
    id,
    name: patch.name ?? current.name,
    permissions: json(patch.permissions ?? current.permissions),
    enabled: patch.enabled === undefined ? Number(current.enabled) : (patch.enabled ? 1 : 0),
    revoked_at: Object.hasOwn(patch, "revokedAt") ? patch.revokedAt : current.revoked_at,
    updated_at: now()
  };
  db.prepare(`
    UPDATE api_tokens
    SET name = @name,
        permissions = @permissions,
        enabled = @enabled,
        revoked_at = @revoked_at,
        updated_at = @updated_at
    WHERE id = @id
  `).run(next);
  return getApiToken(id);
}

export function revokeApiToken(id) {
  return updateApiToken(id, { enabled: false, revokedAt: now() });
}

export function touchApiToken(id) {
  if (id === "env") return;
  db.prepare("UPDATE api_tokens SET last_used_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
}

export function getApiToken(id) {
  return mapApiToken(db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id));
}

export function getApiTokenByHash(tokenHash) {
  return mapApiToken(db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(tokenHash));
}

export function listApiTokens() {
  return db.prepare("SELECT * FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC").all().map(mapApiToken);
}

function seedAdminUser() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (count > 0 || !config.webAdminUsername || !config.webAdminPassword) return;
  const salt = randomUUID().replace(/-/g, "");
  const hash = pbkdf2Sync(String(config.webAdminPassword), salt, 310_000, 32, "sha256").toString("hex");
  createUser({
    username: config.webAdminUsername,
    displayName: config.webAdminUsername,
    passwordHash: `pbkdf2_sha256$${salt}$${hash}`,
    role: "superadmin",
    enabled: true
  });
}

function ensureSuperAdminUser() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'superadmin'").get().count;
  if (count > 0 || !config.webAdminUsername) return;
  db.prepare("UPDATE users SET role = 'superadmin', updated_at = ? WHERE username = ?")
    .run(now(), config.webAdminUsername);
}
