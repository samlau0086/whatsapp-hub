import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");

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
`);

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value === undefined ? {} : value);
const parseJson = (value, fallback = {}) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const mapClient = (row) => row && ({ ...row, metadata: parseJson(row.metadata) });
const mapTask = (row) => row && ({ ...row, payload: parseJson(row.payload), result: parseJson(row.result, null) });
const mapMessage = (row) => row && ({ ...row, payload: parseJson(row.payload) });
const mapWebhook = (row) => row && ({ ...row, events: parseJson(row.events, []), enabled: Boolean(row.enabled) });
const mapApiRequest = (row) => row && ({ ...row, request_body: parseJson(row.request_body, null) });

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
  return db.prepare("DELETE FROM clients WHERE id = ?").run(id).changes > 0;
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
  return getTask(task.id);
}

export function updateTask(id, patch) {
  const current = getTask(id);
  if (!current) return null;
  const next = {
    status: patch.status ?? current.status,
    client_id: patch.clientId ?? current.client_id,
    result: patch.result === undefined ? json(current.result) : json(patch.result),
    error: patch.error ?? current.error,
    completed_at: patch.completedAt ?? current.completed_at,
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

export function createMessage(message) {
  const timestamp = now();
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
    payload: json(message.payload || message),
    created_at: message.createdAt || timestamp,
    received_at: timestamp
  };
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, external_id, client_id, direction, chat_id, sender, recipient, body, message_type, payload, created_at, received_at)
    VALUES (@id, @external_id, @client_id, @direction, @chat_id, @sender, @recipient, @body, @message_type, @payload, @created_at, @received_at)
  `).run(row);
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
  return mapMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(id));
}

export function listMessages({ clientId, sender, chatId, limit = 100 } = {}) {
  const where = [];
  const params = {};
  if (clientId) {
    where.push("client_id = @clientId");
    params.clientId = clientId;
  }
  if (sender) {
    where.push("sender = @sender");
    params.sender = sender;
  }
  if (chatId) {
    where.push("chat_id = @chatId");
    params.chatId = chatId;
  }
  params.limit = Math.min(Number(limit) || 100, 500);
  const sql = `SELECT * FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT @limit`;
  return db.prepare(sql).all(params).map(mapMessage);
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
