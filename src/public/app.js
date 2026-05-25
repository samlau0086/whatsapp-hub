const state = {
  language: localStorage.getItem("hubLanguage") || "en",
  theme: localStorage.getItem("hubTheme") || "light",
  user: null,
  roles: {},
  clients: [],
  tasks: [],
  messages: [],
  apiRequests: [],
  users: [],
  socket: null,
  clientFilter: "all",
  selectedClientId: ""
};

const $ = (id) => document.getElementById(id);
const fmt = (value) => value ? new Date(value).toLocaleString() : "-";

const i18n = {
  en: {
    loading: "Loading hub state",
    connected: "Signed in",
    connectionFailed: "Connection failed",
    metricOnline: "Online clients",
    metricClients: "Total clients",
    metricRunning: "Running tasks",
    metricMessages: "Messages cached",
    clients: "Clients",
    refresh: "Refresh",
    all: "All",
    online: "Online",
    offline: "Offline",
    sendMessage: "Send Message",
    client: "Client",
    phone: "Phone",
    message: "Message",
    dispatchTask: "Dispatch task",
    taskTimeline: "Task Timeline",
    messageStream: "Message Stream",
    apiRequests: "API Requests",
    logout: "Logout",
    userManagement: "User Management",
    rolesAccess: "Roles and access control",
    createUser: "Create user",
    randomClient: "Random online client",
    noClientSelected: "No client selected",
    noClients: "No clients match this filter.",
    noTasks: "No tasks to show.",
    noMessages: "No messages to show.",
    noRequests: "No API requests recorded yet.",
    noUsers: "No users.",
    noPhone: "No phone",
    removeClient: "Remove",
    clientRemoved: "Client removed",
    latestTasks: "Latest 50 tasks",
    latestMessages: "Latest 50 messages",
    recentApiCalls: "{count} recent API calls",
    onlineSummary: "{online} online / {total} total",
    filteredBy: "Filtered by {id}",
    dispatchingWith: "Dispatching with {name}",
    hubRefreshed: "Hub state refreshed",
    taskDispatched: "Task dispatched",
    taskLabel: "Task {id}",
    clientLabel: "Client: {value}",
    toLabel: "To: {value}",
    chatLabel: "Chat: {value}",
    messagePlaceholder: "Type message body",
    usernamePlaceholder: "Username",
    displayNamePlaceholder: "Display name",
    passwordPlaceholder: "Password",
    userCreated: "User created",
    userDeleted: "User deleted"
  },
  zh: {
    loading: "正在加载 Hub 状态",
    connected: "已登录",
    connectionFailed: "连接失败",
    metricOnline: "在线客户端",
    metricClients: "客户端总数",
    metricRunning: "运行中任务",
    metricMessages: "缓存消息",
    clients: "客户端",
    refresh: "刷新",
    all: "全部",
    online: "在线",
    offline: "离线",
    sendMessage: "发送消息",
    client: "客户端",
    phone: "手机号",
    message: "消息",
    dispatchTask: "派发任务",
    taskTimeline: "任务时间线",
    messageStream: "消息流",
    apiRequests: "API 请求记录",
    logout: "退出",
    userManagement: "用户管理",
    rolesAccess: "角色和访问控制",
    createUser: "创建用户",
    randomClient: "随机在线客户端",
    noClientSelected: "未选择客户端",
    noClients: "没有符合筛选条件的客户端。",
    noTasks: "暂无任务。",
    noMessages: "暂无消息。",
    noRequests: "暂无 API 请求记录。",
    noUsers: "暂无用户。",
    noPhone: "无手机号",
    removeClient: "移除",
    clientRemoved: "客户端已移除",
    latestTasks: "最近 50 条任务",
    latestMessages: "最近 50 条消息",
    recentApiCalls: "最近 {count} 条 API 调用",
    onlineSummary: "{online} 在线 / 共 {total}",
    filteredBy: "按 {id} 筛选",
    dispatchingWith: "将使用 {name} 派发",
    hubRefreshed: "Hub 状态已刷新",
    taskDispatched: "任务已派发",
    taskLabel: "任务 {id}",
    clientLabel: "客户端：{value}",
    toLabel: "发送至：{value}",
    chatLabel: "会话：{value}",
    messagePlaceholder: "输入消息内容",
    usernamePlaceholder: "用户名",
    displayNamePlaceholder: "显示名称",
    passwordPlaceholder: "密码",
    userCreated: "用户已创建",
    userDeleted: "用户已删除"
  }
};

function t(key, values = {}) {
  const template = i18n[state.language]?.[key] || i18n.en[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
}

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
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

function can(permission) {
  return state.user?.permissions?.includes(permission);
}

function selectedClient() {
  return state.clients.find((client) => client.id === state.selectedClientId);
}

function filteredClients() {
  if (state.clientFilter === "online") return state.clients.filter((client) => client.status === "online");
  if (state.clientFilter === "offline") return state.clients.filter((client) => client.status !== "online");
  return state.clients;
}

function scopedTasks() {
  return state.selectedClientId ? state.tasks.filter((task) => task.client_id === state.selectedClientId) : state.tasks;
}

function scopedMessages() {
  return state.selectedClientId ? state.messages.filter((message) => message.client_id === state.selectedClientId) : state.messages;
}

function render() {
  const onlineCount = state.clients.filter((client) => client.status === "online").length;
  const runningCount = state.tasks.filter((task) => task.status === "running").length;
  const activeClient = selectedClient();
  const visibleClients = filteredClients();
  const tasks = scopedTasks();
  const messages = scopedMessages();

  applyLanguage();
  $("current-user").textContent = state.user?.display_name || state.user?.username || "-";
  $("current-role").textContent = state.user?.role || "-";
  $("stat-online").textContent = onlineCount;
  $("stat-clients").textContent = state.clients.length;
  $("stat-running").textContent = runningCount;
  $("stat-messages").textContent = state.messages.length;
  $("client-summary").textContent = t("onlineSummary", { online: onlineCount, total: state.clients.length });
  $("task-summary").textContent = state.selectedClientId ? t("filteredBy", { id: state.selectedClientId }) : t("latestTasks");
  $("message-summary").textContent = state.selectedClientId ? t("filteredBy", { id: state.selectedClientId }) : t("latestMessages");
  $("request-summary").textContent = t("recentApiCalls", { count: state.apiRequests.length });
  $("dispatch-hint").textContent = activeClient ? t("dispatchingWith", { name: activeClient.name || activeClient.id }) : t("randomClient");
  $("selected-client-pill").textContent = activeClient ? activeClient.id : t("noClientSelected");

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
        <span>${escapeHtml(client.phone || t("noPhone"))}</span>
        <span title="${escapeHtml(fmt(client.last_seen_at))}">${relativeTime(client.last_seen_at)}</span>
      </div>
      <div class="client-actions">
        ${badge(client.status)}
        ${can("clients:delete") ? `<button class="ghost-button danger-button" type="button" data-remove-client="${escapeHtml(client.id)}">${escapeHtml(t("removeClient"))}</button>` : ""}
      </div>
    </article>
  `).join("") : `<div class="empty-state">${escapeHtml(t("noClients"))}</div>`;

  $("send-client").innerHTML = `<option value="">${escapeHtml(t("randomClient"))}</option>` + state.clients
    .filter((client) => client.status === "online")
    .map((client) => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name || client.id)}</option>`)
    .join("");
  $("send-client").value = activeClient?.status === "online" ? activeClient.id : "";

  $("tasks").innerHTML = tasks.length ? tasks.map((task) => `
    <article class="task-item">
      <div class="task-top">
        <span class="task-id" title="${escapeHtml(task.id)}">${escapeHtml(t("taskLabel", { id: shortId(task.id) }))}</span>
        ${badge(task.status)}
      </div>
      <div class="task-body">${escapeHtml(task.payload?.body || task.type || "Task")}</div>
      <div class="task-meta">
        <span>${escapeHtml(t("clientLabel", { value: task.client_id || "-" }))}</span>
        <span>${escapeHtml(t("toLabel", { value: task.target_phone || "-" }))}</span>
        <span title="${escapeHtml(fmt(task.updated_at))}">${relativeTime(task.updated_at)}</span>
      </div>
      ${can("tasks:send") ? `
        <div class="task-reassign">
          <select data-assign-select="${escapeHtml(task.id)}">
            ${state.clients.map((client) => `<option value="${escapeHtml(client.id)}" ${client.id === task.client_id ? "selected" : ""}>${escapeHtml(client.name || client.id)} (${escapeHtml(client.status)})</option>`).join("")}
          </select>
          <button class="ghost-button" type="button" data-assign-task="${escapeHtml(task.id)}">Assign</button>
        </div>
      ` : ""}
    </article>
  `).join("") : `<div class="empty-state">${escapeHtml(t("noTasks"))}</div>`;

  $("messages").innerHTML = messages.length ? messages.map((message) => `
    <article class="message">
      <header>
        <span class="message-source" title="${escapeHtml(message.sender || "")}">${escapeHtml(message.sender || "-")}</span>
        <span class="soft-pill">${escapeHtml(message.direction || "inbound")}</span>
      </header>
      <p>${escapeHtml(message.body || "")}</p>
      <div class="message-meta">
        <span>${escapeHtml(t("clientLabel", { value: message.client_id }))}</span>
        <span>${escapeHtml(t("chatLabel", { value: message.chat_id || "-" }))}</span>
        <span title="${escapeHtml(fmt(message.created_at))}">${relativeTime(message.created_at)}</span>
      </div>
    </article>
  `).join("") : `<div class="empty-state">${escapeHtml(t("noMessages"))}</div>`;

  $("requests").innerHTML = state.apiRequests.length ? state.apiRequests.map((request) => `
    <article class="request-item">
      <div class="request-top">
        <strong>${escapeHtml(request.method)}</strong>
        <span class="badge ${statusClass(request.status_code)}">${escapeHtml(String(request.status_code))}</span>
      </div>
      <div class="request-path" title="${escapeHtml(request.path)}">${escapeHtml(request.path)}</div>
      <div class="request-meta">
        <span>${escapeHtml(request.response_time_ms)}ms</span>
        <span>${escapeHtml(request.client_ip || "-")}</span>
        <span title="${escapeHtml(fmt(request.created_at))}">${relativeTime(request.created_at)}</span>
      </div>
    </article>
  `).join("") : `<div class="empty-state">${escapeHtml(t("noRequests"))}</div>`;

  $("users-panel").hidden = !can("users:manage");
  $("users").innerHTML = state.users.length ? state.users.map((user) => `
    <article class="user-item">
      <div>
        <strong>${escapeHtml(user.display_name || user.username)}</strong>
        <span>${escapeHtml(user.username)} / ${escapeHtml(user.role)}</span>
      </div>
      <span class="badge ${user.enabled ? "status-ok" : "status-warn"}">${user.enabled ? "enabled" : "disabled"}</span>
      <button class="ghost-button" type="button" data-delete-user="${escapeHtml(user.id)}">Delete</button>
    </article>
  `).join("") : `<div class="empty-state">${escapeHtml(t("noUsers"))}</div>`;

  $("send-form").querySelector("button[type='submit']").disabled = !can("tasks:send");
  document.querySelectorAll(".filter-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.clientFilter);
  });
}

function applyLanguage() {
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  $("send-body").placeholder = t("messagePlaceholder");
  $("user-username").placeholder = t("usernamePlaceholder");
  $("user-display-name").placeholder = t("displayNamePlaceholder");
  $("user-password").placeholder = t("passwordPlaceholder");
  $("lang-en").classList.toggle("active", state.language === "en");
  $("lang-zh").classList.toggle("active", state.language === "zh");
  $("theme-light").textContent = state.language === "zh" ? "浅色" : "Light";
  $("theme-dark").textContent = state.language === "zh" ? "深色" : "Dark";
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $("theme-light").classList.toggle("active", state.theme === "light");
  $("theme-dark").classList.toggle("active", state.theme === "dark");
}

function statusClass(statusCode) {
  if (statusCode >= 500) return "status-error";
  if (statusCode >= 400) return "status-warn";
  return "status-ok";
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
  setConnectionLabel(t("loading"));
  const me = await api("/admin/api/me").catch((error) => {
    if (error.message === "unauthenticated") window.location.href = "/login";
    throw error;
  });
  state.user = me.user;
  state.roles = me.roles;

  const [clients, tasks, messages, requests, users] = await Promise.all([
    can("clients:read") ? api("/admin/api/clients") : Promise.resolve({ clients: [] }),
    can("tasks:read") ? api("/admin/api/tasks?limit=50") : Promise.resolve({ tasks: [] }),
    can("messages:read") ? api("/admin/api/messages?limit=50") : Promise.resolve({ messages: [] }),
    can("requests:read") ? api("/admin/api/requests?limit=50") : Promise.resolve({ requests: [] }),
    can("users:manage") ? api("/admin/api/users") : Promise.resolve({ users: [] })
  ]);
  state.clients = clients.clients;
  state.tasks = tasks.tasks;
  state.messages = messages.messages;
  state.apiRequests = requests.requests;
  state.users = users.users;
  setConnectionLabel(t("connected"));
  render();
  connectSocket();
}

function connectSocket() {
  if (state.socket?.connected) return;
  state.socket?.disconnect();
  state.socket = io({ withCredentials: true });
  state.socket.on("connect", () => setConnectionLabel(t("connected")));
  state.socket.on("disconnect", () => setConnectionLabel(t("connectionFailed")));
  state.socket.on("connect_error", () => setConnectionLabel(t("connectionFailed")));
  state.socket.on("client:updated", (client) => {
    if (!can("clients:read")) return;
    state.clients = [client, ...state.clients.filter((item) => item.id !== client.id)];
    render();
  });
  state.socket.on("task:updated", (task) => {
    if (!can("tasks:read")) return;
    state.tasks = [task, ...state.tasks.filter((item) => item.id !== task.id)].slice(0, 50);
    render();
  });
  state.socket.on("message:created", (message) => {
    if (!can("messages:read")) return;
    state.messages = [message, ...state.messages.filter((item) => item.id !== message.id)].slice(0, 50);
    render();
  });
}

async function logout() {
  await api("/auth/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login";
}

async function createUser(event) {
  event.preventDefault();
  const payload = {
    username: $("user-username").value.trim(),
    displayName: $("user-display-name").value.trim(),
    password: $("user-password").value,
    role: $("user-role").value,
    enabled: true
  };
  await api("/admin/api/users", { method: "POST", body: JSON.stringify(payload) })
    .then(async () => {
      $("user-form").reset();
      state.users = (await api("/admin/api/users")).users;
      showToast(t("userCreated"));
      render();
    })
    .catch((error) => showToast(error.message));
}

function bindEvents() {
  $("logout").addEventListener("click", logout);
  $("user-form").addEventListener("submit", createUser);
  $("users").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete-user]");
    if (!button) return;
    await api(`/admin/api/users/${button.dataset.deleteUser}`, { method: "DELETE" })
      .then(async () => {
        state.users = (await api("/admin/api/users")).users;
        showToast(t("userDeleted"));
        render();
      })
      .catch((error) => showToast(error.message));
  });

  $("refresh").addEventListener("click", () => {
    load()
      .then(() => showToast(t("hubRefreshed")))
      .catch((error) => showToast(error.message));
  });

  $("lang-en").addEventListener("click", () => setLanguage("en"));
  $("lang-zh").addEventListener("click", () => setLanguage("zh"));
  $("theme-light").addEventListener("click", () => setTheme("light"));
  $("theme-dark").addEventListener("click", () => setTheme("dark"));

  document.querySelectorAll(".filter-button").forEach((button) => {
    button.dataset.filter = button.id.replace("filter-", "");
    button.addEventListener("click", () => {
      state.clientFilter = button.dataset.filter;
      render();
    });
  });

  $("clients").addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-client]");
    if (removeButton) {
      event.stopPropagation();
      removeClient(removeButton.dataset.removeClient);
      return;
    }
    const card = event.target.closest(".client-card");
    if (!card) return;
    const id = card.dataset.clientId;
    state.selectedClientId = state.selectedClientId === id ? "" : id;
    render();
  });

  $("tasks").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-assign-task]");
    if (!button) return;
    const taskId = button.dataset.assignTask;
    const select = document.querySelector(`[data-assign-select="${CSS.escape(taskId)}"]`);
    const clientId = select?.value;
    if (!clientId) return;
    button.disabled = true;
    await api(`/admin/api/tasks/${taskId}/assign`, {
      method: "PATCH",
      body: JSON.stringify({ clientId })
    })
      .then(({ task }) => {
        state.tasks = [task, ...state.tasks.filter((item) => item.id !== task.id)].slice(0, 50);
        showToast("Task assigned");
        render();
      })
      .catch((error) => showToast(error.message))
      .finally(() => {
        button.disabled = false;
      });
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
    await api("/admin/api/tasks/send-message", { method: "POST", body: JSON.stringify(payload) })
      .then(({ task }) => {
        state.tasks = [task, ...state.tasks.filter((item) => item.id !== task.id)];
        $("send-body").value = "";
        showToast(t("taskDispatched"));
        render();
      })
      .catch((error) => showToast(error.message))
      .finally(() => {
        submit.disabled = false;
      });
  });
}

async function removeClient(clientId) {
  await api(`/admin/api/clients/${clientId}`, { method: "DELETE" })
    .then(() => {
      state.clients = state.clients.filter((client) => client.id !== clientId);
      state.tasks = state.tasks.filter((task) => task.client_id !== clientId);
      state.messages = state.messages.filter((message) => message.client_id !== clientId);
      if (state.selectedClientId === clientId) state.selectedClientId = "";
      showToast(t("clientRemoved"));
      render();
    })
    .catch((error) => showToast(error.message));
}

function setLanguage(language) {
  state.language = language;
  localStorage.setItem("hubLanguage", language);
  render();
}

function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem("hubTheme", theme);
  applyTheme();
}

bindEvents();
applyLanguage();
applyTheme();
render();
load().catch((error) => {
  setConnectionLabel(t("connectionFailed"));
  showToast(error.message);
});
