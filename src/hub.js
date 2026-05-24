import { Server } from "socket.io";
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

export function createHub(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true }
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers["x-hub-token"];
    if (token !== config.apiToken) {
      return next(new Error("unauthorized"));
    }
    return next();
  });

  io.on("connection", (socket) => {
    socket.on("client:hello", (payload = {}, ack) => {
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
      const id = payload.id || socket.data.clientId;
      if (!id) return ack?.({ ok: false, error: "client id required" });
      const client = touchClient(id, payload.status || "online");
      io.emit("client:updated", client);
      ack?.({ ok: true, client });
    });

    socket.on("message:created", async (payload = {}, ack) => {
      const clientId = payload.clientId || socket.data.clientId;
      if (!clientId) return ack?.({ ok: false, error: "client id required" });
      const message = createMessage({ ...payload, clientId });
      io.emit("message:created", message);
      await dispatchWebhook("message.created", message);
      ack?.({ ok: true, message });
    });

    socket.on("task:result", async (payload = {}, ack) => {
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
      const socketId = socketsByClient.get(task.client_id);
      const socket = socketId && io.sockets.sockets.get(socketId);
      if (!socket || getClient(task.client_id)?.status !== "online") {
        const failed = updateTask(task.id, {
          status: "failed",
          error: `client ${task.client_id} is offline`,
          completedAt: new Date().toISOString()
        });
        io.emit("task:updated", failed);
        await dispatchWebhook("task.updated", failed);
        return failed;
      }

      const updated = updateTask(task.id, { status: "running" });
      io.emit("task:updated", updated);
      socket.emit("task:send-message", updated);
      await dispatchWebhook("task.updated", updated);
      return updated;
    }
  };
}

export function chooseClient(requestedClientId) {
  if (requestedClientId) {
    const client = getClient(requestedClientId);
    return client?.status === "online" ? client : null;
  }
  const clients = listOnlineClients();
  if (!clients.length) return null;
  return clients[Math.floor(Math.random() * clients.length)];
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
