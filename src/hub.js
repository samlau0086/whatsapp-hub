import { Server } from "socket.io";
import { getSessionFromCookieHeader } from "./auth.js";
import {
  createMessage,
  getClient,
  getTask,
  listOnlineClients,
  listWebhooks,
  setClientStatus,
  touchClient,
  updateTask,
  upsertClient
} from "./db.js";
import { config } from "./config.js";

const socketsByClient = new Map();
let activeIo = null;

export function createHub(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true }
  });
  activeIo = io;

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers["x-hub-token"];
    if (token === config.apiToken) {
      socket.data.kind = "agent";
      return next();
    }

    const session = getSessionFromCookieHeader(socket.handshake.headers.cookie || "");
    if (session?.user) {
      socket.data.kind = "admin";
      socket.data.user = session.user;
      return next();
    }

    return next(new Error("unauthorized"));
  });

  io.on("connection", (socket) => {
    socket.on("client:hello", (payload = {}, ack) => {
      if (socket.data.kind !== "agent") return ack?.({ ok: false, error: "forbidden" });
      const id = payload.id || socket.id;
      socket.data.clientId = id;
      socketsByClient.set(id, socket.id);
      const client = upsertClient({
        id,
        name: payload.name || id,
        phone: payload.phone || null,
        metadata: payload.metadata || {},
        status: "online"
      });
      io.emit("client:updated", client);
      ack?.({ ok: true, client });
    });

    socket.on("client:heartbeat", (payload = {}, ack) => {
      if (socket.data.kind !== "agent") return ack?.({ ok: false, error: "forbidden" });
      const id = payload.id || socket.data.clientId;
      if (!id) return ack?.({ ok: false, error: "client id required" });
      const status = payload.status || "online";
      if (status !== "online") socketsByClient.delete(id);
      const client = status === "online" ? touchClient(id, status) : setClientStatus(id, status);
      io.emit("client:updated", client);
      ack?.({ ok: true, client });
    });

    socket.on("message:created", async (payload = {}, ack) => {
      if (socket.data.kind !== "agent") return ack?.({ ok: false, error: "forbidden" });
      const clientId = payload.clientId || socket.data.clientId;
      if (!clientId) return ack?.({ ok: false, error: "client id required" });
      const message = createMessage({ ...payload, clientId });
      io.emit("message:created", message);
      await dispatchWebhook("message.created", message);
      ack?.({ ok: true, message });
    });

    socket.on("task:result", async (payload = {}, ack) => {
      if (socket.data.kind !== "agent") return ack?.({ ok: false, error: "forbidden" });
      const task = getTask(payload.taskId);
      if (!task) return ack?.({ ok: false, error: "task not found" });
      const status = payload.ok ? "succeeded" : "failed";
      const updated = updateTask(payload.taskId, {
        status,
        result: payload.result || null,
        error: payload.error || null,
        completedAt: new Date().toISOString()
      });
      if (payload.ok && task.type === "send-message") {
        const message = createMessage({
          id: `task-${task.id}`,
          externalId: payload.result?.messageId || null,
          clientId: task.client_id,
          direction: "outbound",
          chatId: payload.result?.chatId || null,
          sender: task.client_id,
          recipient: task.target_phone,
          body: task.payload?.body || "",
          messageType: "text",
          payload: {
            taskId: task.id,
            result: payload.result || null,
            metadata: task.payload?.metadata || {}
          }
        });
        io.emit("message:created", message);
        await dispatchWebhook("message.created", message);
      }
      io.emit("task:updated", updated);
      await dispatchWebhook("task.updated", updated);
      ack?.({ ok: true, task: updated });
    });

    socket.on("disconnect", () => {
      if (socket.data.kind !== "agent") return;
      const clientId = socket.data.clientId;
      if (!clientId) return;
      if (socketsByClient.get(clientId) === socket.id) {
        socketsByClient.delete(clientId);
        const client = setClientStatus(clientId, "offline");
        io.emit("client:updated", client);
      }
    });
  });

  setInterval(() => {
    const cutoff = Date.now() - config.clientOfflineAfterMs;
    for (const client of listOnlineClients()) {
      if (!client.last_seen_at || new Date(client.last_seen_at).getTime() < cutoff) {
        socketsByClient.delete(client.id);
        const updated = setClientStatus(client.id, "offline");
        io.emit("client:updated", updated);
      }
    }
  }, 15_000).unref();

  return {
    io,
    async dispatchTask(task) {
      const socket = getLiveClientSocket(task.client_id);
      if (!socket) return failTask(io, task, `client ${task.client_id} is offline`);

      const updated = updateTask(task.id, { status: "running" });
      io.emit("task:updated", updated);
      await dispatchWebhook("task.updated", updated);
      try {
        const result = await socket.timeout(30_000).emitWithAck("task:send-message", updated);
        if (result?.accepted === false) {
          return failTask(io, task, result.error || `client ${task.client_id} rejected task`);
        }
        return updated;
      } catch (error) {
        return failTask(io, task, `client ${task.client_id} did not acknowledge task dispatch`);
      }
    }
  };
}

export function chooseClient(requestedClientId) {
  if (requestedClientId) {
    const client = getClient(requestedClientId);
    return client?.status === "online" && getLiveClientSocket(requestedClientId) ? client : null;
  }
  const clients = listOnlineClients().filter((client) => getLiveClientSocket(client.id));
  if (!clients.length) return null;
  return clients[Math.floor(Math.random() * clients.length)];
}

export function reconcileClientPresence() {
  const updated = [];
  for (const client of listOnlineClients()) {
    if (!getLiveClientSocket(client.id)) {
      const offline = getClient(client.id);
      if (offline) updated.push(offline);
    }
  }
  return updated;
}

function getLiveClientSocket(clientId) {
  if (!activeIo) return null;
  const socketId = socketsByClient.get(clientId);
  const socket = socketId && activeIo.sockets.sockets.get(socketId);
  if (!socket || !socket.connected || socket.data.kind !== "agent") {
    socketsByClient.delete(clientId);
    const stale = getClient(clientId);
    if (stale?.status === "online") {
      const updated = setClientStatus(clientId, "offline");
      activeIo.emit("client:updated", updated);
    }
    return null;
  }
  return socket;
}

async function failTask(io, task, error) {
  const failed = updateTask(task.id, {
    status: "failed",
    error,
    completedAt: new Date().toISOString()
  });
  io.emit("task:updated", failed);
  await dispatchWebhook("task.updated", failed);
  return failed;
}

async function dispatchWebhook(event, data) {
  const hooks = listWebhooks(event);
  await Promise.allSettled(hooks.map(async (hook) => {
    const body = JSON.stringify({ event, data, sentAt: new Date().toISOString() });
    const headers = { "content-type": "application/json" };
    if (hook.secret) headers["x-hub-signature"] = hook.secret;
    await fetch(hook.url, { method: "POST", headers, body });
  }));
}
