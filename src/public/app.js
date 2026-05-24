const state = {
  token: localStorage.getItem("hubToken") || "",
  clients: [],
  tasks: [],
  messages: [],
  socket: null,
  clientFilter: "all",
  selectedClientId: ""
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

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function badge(text) {
  return `<span class="badge ${escapeHtml(text)}">${escapeHtml(text)}</span>`;
}

function shortId(id) {
  return id ? id.slice(0, 8) : "-";
}

function relativeTime(value) {
  if (!value) return "-";
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return "-";
  const seconds = Math.max(1, Math.round(diff / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function selectedClient() {
  return state.clients.find((client) => client.id === state.selectedClientId);
}

function filteredClients() {
  if (state.clientFilter === "online") {
    return state.clients.filter((client) => client.status === "online");
  }
  if (state.clientFilter === "offline") {
    return state.clients.filter((client) => client.status !== "online");
  }
  return state.clients;
}

function scopedTasks() {
  if (!state.selectedClientId) return state.tasks;
  return state.tasks.filter((task) => task.client_id === state.selectedClientId);
}

function scopedMessages() {
  if (!state.selectedClientId) return state.messages;
  return state.messages.filter((message) => message.client_id === state.selectedClientId);
}

function render() {
  const onlineCount = state.clients.filter((client) => client.status === "online").length;
  const runningCount = state.tasks.filter((task) => task.status === "running").length;
  const activeClient = selectedClient();
  const visibleClients = filteredClients();
  const tasks = scopedTasks();
  const messages = scopedMessages();

  $("stat-online").textContent = onlineCount;
  $("stat-clients").textContent = state.clients.length;
  $("stat-running").textContent = runningCount;
  $("stat-messages").textContent = state.messages.length;
  $("client-summary").textContent = `${onlineCount} online / ${state.clients.length} total`;
  $("task-summary").textContent = state.selectedClientId ? `Filtered by ${state.selectedClientId}` : "Latest 50 tasks";
  $("message-summary").textContent = state.selectedClientId ? `Filtered by ${state.selectedClientId}` : "Latest 50 messages";
  $("dispatch-hint").textContent = activeClient ? `Dispatching with ${activeClient.name || activeClient.id}` : "Random online client";
  $("selected-client-pill").textContent = activeClient ? activeClient.id : "No client selected";

  $("clients").innerHTML = visibleClients.length ? visibleClients.map((client) => `
    <article class="client-card ${client.id === state.selectedClientId ? "selected" : ""}" data-client-id="${escapeHtml(client.id)}">
      <div class="client-main">
        <span class="status-dot ${escapeHtml(client.status)}"></span>
        <div class="client-title">
          <strong>${escapeHtml(client.name || client.id)}</strong>
          <span>${escapeHtml(client.id)}</span>
        </div>
      </div>
      <div class="client-meta">
        <span>${escapeHtml(client.phone || "No phone")}</span>
        <span title="${escapeHtml(fmt(client.last_seen_at))}">${relativeTime(client.last_seen_at)}</span>
      </div>
      <div>${badge(client.status)}</div>
    </article>
  `).join("") : `<div class="empty-state">No clients match this filter.</div>`;

  $("send-client").innerHTML = `<option value="">Random online client</option>` + state.clients
    .filter((client) => client.status === "online")
    .map((client) => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name || client.id)}</option>`)
    .join("");
  $("send-client").value = activeClient?.status === "online" ? activeClient.id : "";

  $("tasks").innerHTML = tasks.length ? tasks.map((task) => `
    <article class="task-item">
      <div class="task-top">
        <span class="task-id" title="${escapeHtml(task.id)}">Task ${escapeHtml(shortId(task.id))}</span>
        ${badge(task.status)}
      </div>
      <div class="task-body">${escapeHtml(task.payload?.body || task.type || "Task")}</div>
      <div class="task-meta">
        <span>Client: ${escapeHtml(task.client_id || "-")}</span>
        <span>To: ${escapeHtml(task.target_phone || "-")}</span>
        <span title="${escapeHtml(fmt(task.updated_at))}">${relativeTime(task.updated_at)}</span>
      </div>
    </article>
  `).join("") : `<div class="empty-state">No tasks to show.</div>`;

  $("messages").innerHTML = messages.length ? messages.map((message) => `
    <article class="message">
      <header>
        <span class="message-source" title="${escapeHtml(message.sender || "")}">${escapeHtml(message.sender || "-")}</span>
        <span class="soft-pill">${escapeHtml(message.direction || "inbound")}</span>
      </header>
      <p>${escapeHtml(message.body || "")}</p>
      <div class="message-meta">
        <span>Client: ${escapeHtml(message.client_id)}</span>
        <span>Chat: ${escapeHtml(message.chat_id || "-")}</span>
        <span title="${escapeHtml(fmt(message.created_at))}">${relativeTime(message.created_at)}</span>
      </div>
    </article>
  `).join("") : `<div class="empty-state">No messages to show.</div>`;

  document.querySelectorAll(".filter-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.clientFilter);
  });
}

function setConnectionLabel(text) {
  $("connection-label").textContent = text;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

async function load() {
  if (!state.token) {
    setConnectionLabel("Enter API token to connect");
    render();
    return;
  }
  setConnectionLabel("Loading hub state");
  const [clients, tasks, messages] = await Promise.all([
    api("/api/clients"),
    api("/api/tasks?limit=50"),
    api("/api/messages?limit=50")
  ]);
  state.clients = clients.clients;
  state.tasks = tasks.tasks;
  state.messages = messages.messages;
  setConnectionLabel("Connected");
  render();
  connectSocket();
}

function connectSocket() {
  if (state.socket?.connected) return;
  state.socket?.disconnect();
  state.socket = io({ auth: { token: state.token } });
  state.socket.on("connect", () => setConnectionLabel("Realtime connected"));
  state.socket.on("disconnect", () => setConnectionLabel("Realtime disconnected"));
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

function bindEvents() {
  $("token-input").value = state.token;

  $("token-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    state.token = $("token-input").value.trim();
    localStorage.setItem("hubToken", state.token);
    await load().catch((error) => {
      setConnectionLabel("Connection failed");
      showToast(error.message);
    });
  });

  $("refresh").addEventListener("click", () => {
    load()
      .then(() => showToast("Hub state refreshed"))
      .catch((error) => showToast(error.message));
  });

  document.querySelectorAll(".filter-button").forEach((button) => {
    button.dataset.filter = button.id.replace("filter-", "");
    button.addEventListener("click", () => {
      state.clientFilter = button.dataset.filter;
      render();
    });
  });

  $("clients").addEventListener("click", (event) => {
    const card = event.target.closest(".client-card");
    if (!card) return;
    const id = card.dataset.clientId;
    state.selectedClientId = state.selectedClientId === id ? "" : id;
    render();
  });

  $("send-client").addEventListener("change", (event) => {
    state.selectedClientId = event.target.value;
    render();
  });

  $("send-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    const payload = {
      clientId: $("send-client").value || undefined,
      to: $("send-to").value.trim(),
      body: $("send-body").value
    };
    await api("/api/tasks/send-message", { method: "POST", body: JSON.stringify(payload) })
      .then(({ task }) => {
        state.tasks = [task, ...state.tasks.filter((item) => item.id !== task.id)];
        $("send-body").value = "";
        showToast("Task dispatched");
        render();
      })
      .catch((error) => showToast(error.message))
      .finally(() => {
        submit.disabled = false;
      });
  });
}

bindEvents();
render();
load().catch(() => setConnectionLabel("Connection failed"));
