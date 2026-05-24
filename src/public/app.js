const state = {
  token: localStorage.getItem("hubToken") || "",
  clients: [],
  tasks: [],
  messages: [],
  socket: null
};

const $ = (id) => document.getElementById(id);
const fmt = (value) => value ? new Date(value).toLocaleString() : "-";

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-hub-token": state.token,
      ...(options.headers || {})
    }
  }).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  });
}

function badge(text) {
  return `<span class="badge ${text}">${text}</span>`;
}

function shortId(id) {
  return id ? id.slice(0, 8) : "-";
}

function render() {
  $("stat-online").textContent = state.clients.filter((c) => c.status === "online").length;
  $("stat-clients").textContent = state.clients.length;
  $("stat-running").textContent = state.tasks.filter((t) => t.status === "running").length;
  $("stat-messages").textContent = state.messages.length;

  $("clients").innerHTML = state.clients.map((client) => `
    <tr>
      <td title="${client.id}">${client.id}</td>
      <td>${client.name || "-"}</td>
      <td>${client.phone || "-"}</td>
      <td>${badge(client.status)}</td>
      <td>${fmt(client.last_seen_at)}</td>
    </tr>
  `).join("");

  $("send-client").innerHTML = `<option value="">Random online client</option>` + state.clients
    .filter((client) => client.status === "online")
    .map((client) => `<option value="${client.id}">${client.name || client.id}</option>`)
    .join("");

  $("tasks").innerHTML = state.tasks.map((task) => `
    <tr>
      <td title="${task.id}">${shortId(task.id)}</td>
      <td>${task.client_id || "-"}</td>
      <td>${task.target_phone || "-"}</td>
      <td>${badge(task.status)}</td>
      <td>${fmt(task.updated_at)}</td>
    </tr>
  `).join("");

  $("messages").innerHTML = state.messages.map((message) => `
    <article class="message">
      <header><span>${message.client_id} / ${message.sender || "-"}</span><time>${fmt(message.created_at)}</time></header>
      <p>${escapeHtml(message.body || "")}</p>
    </article>
  `).join("");
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

async function load() {
  if (!state.token) return;
  const [clients, tasks, messages] = await Promise.all([
    api("/api/clients"),
    api("/api/tasks?limit=50"),
    api("/api/messages?limit=50")
  ]);
  state.clients = clients.clients;
  state.tasks = tasks.tasks;
  state.messages = messages.messages;
  render();
  connectSocket();
}

function connectSocket() {
  if (state.socket?.connected) return;
  state.socket?.disconnect();
  state.socket = io({ auth: { token: state.token } });
  state.socket.on("client:updated", (client) => {
    state.clients = [client, ...state.clients.filter((item) => item.id !== client.id)];
    render();
  });
  state.socket.on("task:updated", (task) => {
    state.tasks = [task, ...state.tasks.filter((item) => item.id !== task.id)].slice(0, 50);
    render();
  });
  state.socket.on("message:created", (message) => {
    state.messages = [message, ...state.messages.filter((item) => item.id !== message.id)].slice(0, 50);
    render();
  });
}

$("token-input").value = state.token;
$("token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = $("token-input").value.trim();
  localStorage.setItem("hubToken", state.token);
  await load().catch((error) => alert(error.message));
});

$("refresh").addEventListener("click", () => load().catch((error) => alert(error.message)));

$("send-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    clientId: $("send-client").value || undefined,
    to: $("send-to").value.trim(),
    body: $("send-body").value
  };
  await api("/api/tasks/send-message", { method: "POST", body: JSON.stringify(payload) })
    .then(({ task }) => {
      state.tasks = [task, ...state.tasks.filter((item) => item.id !== task.id)];
      $("send-body").value = "";
      render();
    })
    .catch((error) => alert(error.message));
});

load().catch(() => {});
