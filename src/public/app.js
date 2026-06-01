const state = {
  language: localStorage.getItem("hubLanguage") || "en",
  theme: localStorage.getItem("hubTheme") || "light",
  user: null,
  roles: {},
  clients: [],
  tasks: [],
  messages: [],
  chats: [],
  apiRequests: [],
  users: [],
  apiTokens: [],
  apiTokenPermissions: [],
  clientConfigs: [],
  clientDeployment: null,
  deploymentTab: "env",
  editingClientConfigId: "",
  socket: null,
  refreshTimer: null,
  clientFilter: "all",
  selectedClientId: "",
  selectedChatId: "",
  editingChatMapping: false
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
    centralChat: "Central Chat",
    send: "Send",
    selectClient: "Select a client",
    selectChat: "Choose a client and chat",
    noChats: "No chats for this client.",
    noChatSelected: "No chat selected",
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
    centralChat: "集中聊天",
    send: "发送",
    selectClient: "选择客户端",
    selectChat: "请选择客户端和会话",
    noChats: "此客户端暂无会话。",
    noChatSelected: "未选择会话",
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
    cache: "no-store",
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

function clientConfigFor(clientId) {
  return state.clientConfigs.find((config) => config.client_id === clientId);
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

function selectedChat() {
  return state.chats.find((chat) => chat.chat_id === state.selectedChatId);
}

function render() {
  const onlineCount = state.clients.filter((client) => client.status === "online").length;
  const runningCount = state.tasks.filter((task) => task.status === "running").length;
  const activeClient = selectedClient();
  const activeChat = selectedChat();
  const visibleClients = filteredClients();
  const tasks = scopedTasks();
  const messages = scopedMessages();
  const activeChatMessages = state.selectedChatId
    ? state.messages.filter((message) => message.client_id === state.selectedClientId && message.chat_id === state.selectedChatId)
    : [];

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
  $("chat-summary").textContent = activeClient ? activeClient.id : t("selectClient");
  renderActiveChatHeader(activeChat);
  $("active-chat-subtitle").textContent = activeClient ? activeClient.name || activeClient.id : t("selectChat");
  const createClientButton = $("toggle-client-create");
  if (createClientButton) createClientButton.hidden = !can("clients:delete");
  renderDeploymentGuide();

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
        ${clientConfigFor(client.id) ? `<button class="icon-button" type="button" title="Deployment guide" data-client-deployment="${escapeHtml(client.id)}">&lt;/&gt;</button>` : ""}
        ${can("clients:delete") ? `<button class="ghost-button danger-button" type="button" data-remove-client="${escapeHtml(client.id)}">${escapeHtml(t("removeClient"))}</button>` : ""}
      </div>
    </article>
  `).join("") : `<div class="empty-state">${escapeHtml(t("noClients"))}</div>`;

  $("send-client").innerHTML = `<option value="">${escapeHtml(t("randomClient"))}</option>` + state.clients
    .filter((client) => client.status === "online")
    .map((client) => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name || client.id)}</option>`)
    .join("");
  $("send-client").value = activeClient?.status === "online" ? activeClient.id : "";

  $("chat-list").innerHTML = state.chats.length ? state.chats.map((chat) => `
    <article class="chat-item ${chat.chat_id === state.selectedChatId ? "active" : ""}" data-chat-id="${escapeHtml(chat.chat_id)}">
      <strong>${escapeHtml(chat.conversation_key || chat.contact_phone || chat.chat_id)}</strong>
      <span>${escapeHtml(chat.last_body || "")}</span>
      <span>${escapeHtml(String(chat.message_count))} messages / ${relativeTime(chat.last_message_at)}</span>
    </article>
  `).join("") : `<div class="empty-state">${escapeHtml(activeClient ? t("noChats") : t("selectClient"))}</div>`;

  $("chat-messages").innerHTML = activeChatMessages.length ? activeChatMessages.map((message) => `
    <article class="chat-bubble ${escapeHtml(message.direction || "inbound")}">
      <p>${escapeHtml(message.body || "")}</p>
      <span>${escapeHtml(message.sender || "-")} / ${escapeHtml(fmt(message.created_at))}</span>
    </article>
  `).join("") : `<div class="empty-state">${escapeHtml(t("selectChat"))}</div>`;

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
        <span>${escapeHtml(t("chatLabel", { value: message.conversation_key || message.contact_phone || message.chat_id || "-" }))}</span>
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
      <select data-user-role="${escapeHtml(user.id)}">
        ${Object.keys(state.roles).map((role) => `<option value="${escapeHtml(role)}" ${role === user.role ? "selected" : ""}>${escapeHtml(role)}</option>`).join("")}
      </select>
      <input type="password" data-user-password="${escapeHtml(user.id)}" placeholder="New password" />
      <button class="ghost-button" type="button" data-reset-password="${escapeHtml(user.id)}">Set password</button>
      <button class="ghost-button" type="button" data-toggle-user="${escapeHtml(user.id)}">${user.enabled ? "Disable" : "Enable"}</button>
      <button class="ghost-button" type="button" data-delete-user="${escapeHtml(user.id)}">Delete</button>
    </article>
  `).join("") : `<div class="empty-state">${escapeHtml(t("noUsers"))}</div>`;

  $("tokens-panel").hidden = !can("api_tokens:manage");
  $("token-create-permissions").innerHTML = state.apiTokenPermissions.map((permission) => `
    <label>
      <input type="checkbox" data-create-token-permission value="${escapeHtml(permission)}" checked />
      ${escapeHtml(permission)}
    </label>
  `).join("");
  $("api-tokens").innerHTML = state.apiTokens.length ? state.apiTokens.map((token) => `
    <article class="token-item">
      <div class="token-summary">
        <strong>${escapeHtml(token.name)}</strong>
        <span>${escapeHtml(token.id)} / ${token.enabled ? "enabled" : "disabled"}</span>
        <span>last used: ${escapeHtml(token.last_used_at ? fmt(token.last_used_at) : "-")}</span>
      </div>
      <div class="permission-grid">
        ${state.apiTokenPermissions.map((permission) => `
          <label>
            <input type="checkbox" data-token-permission="${escapeHtml(token.id)}" value="${escapeHtml(permission)}" ${token.permissions.includes(permission) ? "checked" : ""} ${token.revoked_at ? "disabled" : ""} />
            ${escapeHtml(permission)}
          </label>
        `).join("")}
      </div>
      <div class="token-actions">
        <button class="ghost-button" type="button" data-save-token="${escapeHtml(token.id)}">Save</button>
        <button class="ghost-button danger-button" type="button" data-revoke-token="${escapeHtml(token.id)}">Revoke</button>
      </div>
    </article>
  `).join("") : `<div class="empty-state">No API tokens.</div>`;

  $("send-form").querySelector("button[type='submit']").disabled = !can("tasks:send");
  document.querySelectorAll(".filter-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.clientFilter);
  });
}

function renderActiveChatHeader(activeChat) {
  const title = $("active-chat-title");
  if (!title) return;
  const display = activeChat?.conversation_key || activeChat?.contact_phone || state.selectedChatId || t("noChatSelected");
  if (!state.selectedChatId || !state.editingChatMapping) {
    title.innerHTML = `<span class="chat-title-text" title="${escapeHtml(state.selectedChatId || "")}">${escapeHtml(display)}</span>`;
    return;
  }
  const currentPhone = activeChat?.contact_phone || (/^\d+$/.test(activeChat?.conversation_key || "") ? activeChat.conversation_key : "");
  title.innerHTML = `
    <span class="chat-mapping-editor">
      <input id="chat-phone-editor" inputmode="tel" placeholder="Phone number" value="${escapeHtml(currentPhone)}" />
      <button class="icon-button" type="button" title="OK" data-save-chat-mapping>OK</button>
      <button class="ghost-button" type="button" data-cancel-chat-mapping>Cancel</button>
    </span>
  `;
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

function renderDeploymentGuide() {
  const container = $("client-deployment");
  if (!container) return;
  if (!state.clientDeployment) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  const clientId = deploymentClientId(state.clientDeployment);
  const blocks = {
    env: {
      label: ".env",
      filename: `${clientId}.env`,
      content: state.clientDeployment.env,
      note: "Save this file as .env in the same folder as the agent script."
    },
    linux: {
      label: "Linux / macOS",
      filename: `${clientId}-install.sh`,
      content: state.clientDeployment.linux,
      note: `Download and run: chmod +x ${clientId}-install.sh && ./${clientId}-install.sh`
    },
    windowsBat: {
      label: "Windows BAT",
      filename: `${clientId}-install.bat`,
      content: state.clientDeployment.windowsBat || state.clientDeployment.windowsPowerShell || "",
      note: `First run: double-click ${clientId}-install.bat. It will create start-agent.bat in the agent folder. Later runs: double-click start-agent.bat.`
    }
  };
  const activeBlock = blocks[state.deploymentTab] || blocks.env;
  container.hidden = false;
  container.innerHTML = `
    <div class="deployment-head">
      <strong>Client deployment</strong>
      <button class="ghost-button" type="button" data-copy-deployment>Copy Linux guide</button>
    </div>
    <p>Download the .env file and the script for your OS, put them in the same folder, then run the script on the internal-network computer. The script checks Node.js/npm first and installs them when a supported package manager is available. When WhatsApp asks for login, open whatsapp-qr-latest.png in the agent folder and scan it.</p>
    ${deploymentConfigSummary(state.clientDeployment.config)}
    <div class="deployment-tabs" role="tablist">
      ${Object.entries(blocks).map(([key, block]) => `
        <button class="deployment-tab ${state.deploymentTab === key ? "active" : ""}" type="button" data-deployment-tab="${escapeHtml(key)}">${escapeHtml(block.label)}</button>
      `).join("")}
    </div>
    <div class="run-notes"><span>${escapeHtml(activeBlock.note)}</span></div>
    ${deploymentCodeBlock(activeBlock.label, state.deploymentTab, activeBlock.filename, activeBlock.content)}
  `;
}

function deploymentConfigSummary(config = {}) {
  if (!config) return "";
  const rows = [
    ["Client ID", config.clientId],
    ["Client name", config.clientName],
    ["Hub URL", config.hubUrl],
    ["Auth path", config.authDataPath],
    ["Cache path", config.cachePath],
    ["Proxy", config.proxyUrl || "disabled"]
  ];
  return `
    <div class="deployment-config">
      ${rows.map(([label, value]) => `
        <div>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value || "-")}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function deploymentCodeBlock(label, key, filename, content) {
  return `
    <section class="deployment-code">
      <div class="deployment-code-head">
        <label>${escapeHtml(label)}</label>
        <button class="icon-button" type="button" title="Download ${escapeHtml(label)}" data-download-deployment="${escapeHtml(key)}" data-download-filename="${escapeHtml(filename)}">DL</button>
      </div>
      <pre>${escapeHtml(content || "")}</pre>
    </section>
  `;
}

function deploymentClientId(deployment) {
  const match = String(deployment?.env || "").match(/^CLIENT_ID="?([^"\n]+)"?/m);
  return (match?.[1] || "whatsapp-client").replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openClientModal({ mode = "create", deployment = null, clientConfig = null } = {}) {
  if (!$("client-modal")) return;
  state.clientDeployment = deployment;
  state.deploymentTab = "env";
  state.editingClientConfigId = mode === "view" || mode === "edit" ? clientConfig?.id || "" : "";
  $("client-modal-title").textContent = mode === "create" ? "New WhatsApp Client" : "Client Deployment";
  $("client-create-form").hidden = mode === "view";
  if ($("client-edit-actions")) $("client-edit-actions").hidden = mode !== "view";
  $("client-modal").hidden = false;
  if (mode === "create") {
    state.clientDeployment = null;
    state.editingClientConfigId = "";
    setClientFormDefaults();
    $("new-client-id").focus();
  } else if (clientConfig) {
    fillClientForm(clientConfig, deployment);
  }
  renderDeploymentGuide();
}

function closeClientModal() {
  if (!$("client-modal")) return;
  $("client-modal").hidden = true;
  state.clientDeployment = null;
  state.editingClientConfigId = "";
  if ($("client-edit-actions")) $("client-edit-actions").hidden = true;
  renderDeploymentGuide();
}

function setClientFormDefaults() {
  if (!$("new-client-hub-url")) return;
  $("client-create-form")?.reset();
  $("new-client-id").disabled = false;
  $("new-client-id").value = "";
  $("new-client-name").value = "";
  $("new-client-hub-url").value = window.location.origin;
  $("new-client-auth-path").value = "";
  $("new-client-cache-path").value = "";
  $("new-client-proxy-url").value = "";
  $("new-client-proxy-username").value = "";
  $("new-client-proxy-password").value = "";
  $("new-client-headless").checked = true;
}

function fillClientForm(clientConfig = {}, deployment = null) {
  const resolved = deployment?.config || {};
  $("new-client-id").value = clientConfig.client_id || resolved.clientId || "";
  $("new-client-id").disabled = true;
  $("new-client-name").value = clientConfig.name || resolved.clientName || "";
  $("new-client-hub-url").value = clientConfig.hub_url || resolved.hubUrl || window.location.origin;
  $("new-client-auth-path").value = clientConfig.auth_data_path || resolved.authDataPath || "";
  $("new-client-cache-path").value = clientConfig.cache_path || resolved.cachePath || "";
  $("new-client-proxy-url").value = clientConfig.proxy_url || resolved.proxyUrl || "";
  $("new-client-proxy-username").value = clientConfig.proxy_username || resolved.proxyUsername || "";
  $("new-client-proxy-password").value = clientConfig.proxy_password || resolved.proxyPassword || "";
  $("new-client-headless").checked = clientConfig.headless ?? resolved.headless ?? true;
}

async function load() {
  setConnectionLabel(t("loading"));
  const me = await api("/admin/api/me").catch((error) => {
    if (error.message === "unauthenticated") window.location.href = "/login";
    throw error;
  });
  state.user = me.user;
  state.roles = me.roles;
  state.apiTokenPermissions = me.apiPermissions || [];

  const [clients, tasks, messages, chats, requests, users, tokens, clientConfigs] = await Promise.all([
    can("clients:read") ? api("/admin/api/clients") : Promise.resolve({ clients: [] }),
    can("tasks:read") ? api("/admin/api/tasks?limit=50") : Promise.resolve({ tasks: [] }),
    can("messages:read") ? api("/admin/api/messages?limit=50") : Promise.resolve({ messages: [] }),
    can("messages:read") && state.selectedClientId ? api(`/admin/api/chats?clientId=${encodeURIComponent(state.selectedClientId)}&limit=100`) : Promise.resolve({ chats: [] }),
    can("requests:read") ? api("/admin/api/requests?limit=50") : Promise.resolve({ requests: [] }),
    can("users:manage") ? api("/admin/api/users") : Promise.resolve({ users: [] }),
    can("api_tokens:manage") ? api("/admin/api/tokens") : Promise.resolve({ tokens: [], permissions: [] }),
    can("clients:read") ? api("/admin/api/client-configs") : Promise.resolve({ clientConfigs: [] })
  ]);
  state.clients = clients.clients;
  state.tasks = tasks.tasks;
  state.messages = messages.messages;
  state.chats = chats.chats;
  state.apiRequests = requests.requests;
  state.users = users.users;
  state.apiTokens = tokens.tokens;
  state.apiTokenPermissions = tokens.permissions || state.apiTokenPermissions;
  state.clientConfigs = clientConfigs.clientConfigs;
  setConnectionLabel(t("connected"));
  render();
  connectSocket();
  scheduleStateRefresh();
}

async function refreshHubState() {
  const [clients, tasks, messages, chats, requests, clientConfigs] = await Promise.all([
    can("clients:read") ? api("/admin/api/clients") : Promise.resolve({ clients: [] }),
    can("tasks:read") ? api("/admin/api/tasks?limit=50") : Promise.resolve({ tasks: [] }),
    can("messages:read") ? api("/admin/api/messages?limit=50") : Promise.resolve({ messages: [] }),
    can("messages:read") && state.selectedClientId ? api(`/admin/api/chats?clientId=${encodeURIComponent(state.selectedClientId)}&limit=100`) : Promise.resolve({ chats: [] }),
    can("requests:read") ? api("/admin/api/requests?limit=50") : Promise.resolve({ requests: [] }),
    can("clients:read") ? api("/admin/api/client-configs") : Promise.resolve({ clientConfigs: [] })
  ]);
  state.clients = clients.clients;
  state.tasks = tasks.tasks;
  state.messages = messages.messages;
  state.chats = chats.chats;
  state.apiRequests = requests.requests;
  state.clientConfigs = clientConfigs.clientConfigs;
  render();
}

function scheduleStateRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      refreshHubState().catch(() => {});
    }
  }, 10_000);
}

function connectSocket() {
  if (state.socket?.connected) return;
  state.socket?.disconnect();
  state.socket = io({ withCredentials: true });
  state.socket.on("connect", () => {
    setConnectionLabel(t("connected"));
    refreshHubState().catch((error) => showToast(error.message));
  });
  state.socket.on("disconnect", () => setConnectionLabel(t("connectionFailed")));
  state.socket.on("connect_error", () => setConnectionLabel(t("connectionFailed")));
  state.socket.on("client:updated", (client) => {
    if (!can("clients:read") || !client?.id) return;
    state.clients = [client, ...state.clients.filter((item) => item.id !== client.id)];
    render();
  });
  state.socket.on("client:deleted", ({ id }) => {
    if (!can("clients:read") || !id) return;
    removeClientFromState(id);
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
    if (message.client_id === state.selectedClientId) refreshChats();
    render();
  });
}

async function refreshChats() {
  if (!can("messages:read") || !state.selectedClientId) {
    state.chats = [];
    return;
  }
  state.chats = (await api(`/admin/api/chats?clientId=${encodeURIComponent(state.selectedClientId)}&limit=100`)).chats;
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

async function createApiToken(event) {
  event.preventDefault();
  const name = $("token-name").value.trim();
  if (!name) return;
  const permissions = Array.from(document.querySelectorAll("[data-create-token-permission]:checked")).map((input) => input.value);
  if (!permissions.length) {
    showToast("Select at least one permission");
    return;
  }
  await api("/admin/api/tokens", {
    method: "POST",
    body: JSON.stringify({
      name,
      permissions
    })
    })
    .then(async ({ secret }) => {
      $("token-create-form").reset();
      $("token-secret").hidden = false;
      $("token-secret").innerHTML = `
        <span>Copy this token now. It will not be shown again.</span>
        <div class="token-secret-row">
          <input id="generated-token-value" value="${escapeHtml(secret)}" readonly />
          <button class="ghost-button" type="button" data-copy-generated-token>Copy</button>
        </div>
      `;
      const tokenData = await api("/admin/api/tokens");
      state.apiTokens = tokenData.tokens;
      state.apiTokenPermissions = tokenData.permissions;
      render();
    })
    .catch((error) => showToast(error.message));
}

async function createClientConfig(event) {
  event.preventDefault();
  const clientId = $("new-client-id").value.trim();
  const payload = {
    clientId,
    name: $("new-client-name").value.trim() || clientId,
    hubUrl: $("new-client-hub-url").value.trim() || window.location.origin,
    authDataPath: $("new-client-auth-path").value.trim() || `./.wwebjs_auth_${clientId}`,
    cachePath: $("new-client-cache-path").value.trim() || `./.wwebjs_cache_${clientId}`,
    proxyUrl: $("new-client-proxy-url").value.trim(),
    proxyUsername: $("new-client-proxy-username").value.trim(),
    proxyPassword: $("new-client-proxy-password").value,
    headless: $("new-client-headless").checked
  };
  const isEditing = Boolean(state.editingClientConfigId);
  const path = isEditing ? `/admin/api/client-configs/${state.editingClientConfigId}` : "/admin/api/client-configs";
  await api(path, {
    method: isEditing ? "PATCH" : "POST",
    body: JSON.stringify(payload)
  })
    .then(async ({ clientConfig, deployment }) => {
      if (!isEditing) {
        $("client-create-form").reset();
        $("new-client-headless").checked = true;
      }
      state.clientDeployment = deployment;
      state.clientConfigs = [clientConfig, ...state.clientConfigs.filter((item) => item.id !== clientConfig.id)];
      state.clients = (await api("/admin/api/clients")).clients;
      fillClientForm(clientConfig, deployment);
      state.editingClientConfigId = clientConfig.id;
      showToast(isEditing ? "Client config updated" : "Client config saved");
      $("client-modal-title").textContent = "Client Deployment";
      $("client-create-form").hidden = true;
      if ($("client-edit-actions")) $("client-edit-actions").hidden = false;
      render();
    })
    .catch((error) => showToast(error.message));
}

async function showClientDeployment(clientId) {
  const clientConfig = clientConfigFor(clientId);
  if (!clientConfig) return;
  await api(`/admin/api/client-configs/${clientConfig.id}/deployment`)
    .then(({ clientConfig: editableConfig, deployment }) => {
      openClientModal({ mode: "view", deployment, clientConfig: editableConfig });
    })
    .catch((error) => showToast(error.message));
}

function bindEvents() {
  $("logout").addEventListener("click", logout);
  $("user-form").addEventListener("submit", createUser);
  $("token-create-form").addEventListener("submit", createApiToken);
  $("toggle-client-create")?.addEventListener("click", () => {
    if ($("client-modal")) openClientModal({ mode: "create" });
  });
  $("edit-client-config")?.addEventListener("click", () => {
    const clientConfig = state.clientConfigs.find((item) => item.id === state.editingClientConfigId);
    if (!clientConfig) return;
    $("client-create-form").hidden = false;
    $("client-edit-actions").hidden = true;
    $("client-modal-title").textContent = "Edit Client Deployment";
    fillClientForm(clientConfig, state.clientDeployment);
  });
  $("cancel-client-edit")?.addEventListener("click", () => {
    if (state.clientDeployment) {
      $("client-create-form").hidden = true;
      $("client-edit-actions").hidden = false;
      $("client-modal-title").textContent = "Client Deployment";
      renderDeploymentGuide();
      return;
    }
    closeClientModal();
  });
  document.querySelectorAll("[data-close-client-modal]").forEach((node) => {
    node.addEventListener("click", closeClientModal);
  });
  $("new-client-id")?.addEventListener("input", () => {
    const clientId = $("new-client-id").value.trim();
    if (!$("new-client-name").value.trim()) $("new-client-name").placeholder = clientId ? clientId : "Office PC 01";
    $("new-client-auth-path").placeholder = clientId ? `./.wwebjs_auth_${clientId}` : "./.wwebjs_auth_office-pc-01";
    $("new-client-cache-path").placeholder = clientId ? `./.wwebjs_cache_${clientId}` : "./.wwebjs_cache_office-pc-01";
  });
  $("client-deployment")?.addEventListener("click", async (event) => {
    const tab = event.target.closest("[data-deployment-tab]");
    if (tab) {
      state.deploymentTab = tab.dataset.deploymentTab;
      renderDeploymentGuide();
      return;
    }
    const download = event.target.closest("[data-download-deployment]");
    if (download && state.clientDeployment) {
      const key = download.dataset.downloadDeployment;
      downloadTextFile(download.dataset.downloadFilename, state.clientDeployment[key]);
      showToast("File downloaded");
      return;
    }
    const copy = event.target.closest("[data-copy-deployment]");
    if (!copy || !state.clientDeployment) return;
    await navigator.clipboard?.writeText(state.clientDeployment.linux).catch(() => {});
    showToast("Deployment guide copied");
  });
  $("client-create-form")?.addEventListener("submit", createClientConfig);
  $("token-secret").addEventListener("click", async (event) => {
    const copy = event.target.closest("[data-copy-generated-token]");
    if (!copy) return;
    const input = $("generated-token-value");
    input.select();
    await navigator.clipboard?.writeText(input.value).catch(() => document.execCommand("copy"));
    showToast("Token copied");
  });
  $("users").addEventListener("click", async (event) => {
    const resetPassword = event.target.closest("[data-reset-password]");
    if (resetPassword) {
      const input = document.querySelector(`[data-user-password="${CSS.escape(resetPassword.dataset.resetPassword)}"]`);
      const password = input?.value || "";
      if (!password) return;
      await api(`/admin/api/users/${resetPassword.dataset.resetPassword}`, {
        method: "PATCH",
        body: JSON.stringify({ password })
      })
        .then(() => {
          input.value = "";
          showToast("Password updated");
        })
        .catch((error) => showToast(error.message));
      return;
    }
    const toggle = event.target.closest("[data-toggle-user]");
    if (toggle) {
      const user = state.users.find((item) => item.id === toggle.dataset.toggleUser);
      if (!user) return;
      await api(`/admin/api/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !user.enabled })
      })
        .then(async () => {
          state.users = (await api("/admin/api/users")).users;
          render();
        })
        .catch((error) => showToast(error.message));
      return;
    }
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

  $("users").addEventListener("change", async (event) => {
    const roleSelect = event.target.closest("[data-user-role]");
    if (!roleSelect) return;
    await api(`/admin/api/users/${roleSelect.dataset.userRole}`, {
      method: "PATCH",
      body: JSON.stringify({ role: roleSelect.value })
    })
      .then(async () => {
        state.users = (await api("/admin/api/users")).users;
        render();
      })
      .catch((error) => showToast(error.message));
  });

  $("api-tokens").addEventListener("click", async (event) => {
    const save = event.target.closest("[data-save-token]");
    if (save) {
      const tokenId = save.dataset.saveToken;
      const permissions = Array.from(document.querySelectorAll(`[data-token-permission="${CSS.escape(tokenId)}"]:checked`)).map((input) => input.value);
      await api(`/admin/api/tokens/${tokenId}`, {
        method: "PATCH",
        body: JSON.stringify({ permissions })
      })
        .then(async () => {
          const tokenData = await api("/admin/api/tokens");
          state.apiTokens = tokenData.tokens;
          render();
        })
        .catch((error) => showToast(error.message));
      return;
    }
    const revoke = event.target.closest("[data-revoke-token]");
    if (revoke) {
      await api(`/admin/api/tokens/${revoke.dataset.revokeToken}/revoke`, { method: "POST" })
        .then(async () => {
          const tokenData = await api("/admin/api/tokens");
          state.apiTokens = tokenData.tokens;
          render();
        })
        .catch((error) => showToast(error.message));
    }
  });

  $("refresh").addEventListener("click", () => {
    refreshHubState()
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
    const deploymentButton = event.target.closest("[data-client-deployment]");
    if (deploymentButton) {
      event.stopPropagation();
      showClientDeployment(deploymentButton.dataset.clientDeployment);
      return;
    }
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
    state.selectedChatId = "";
    state.editingChatMapping = false;
    refreshChats().then(render).catch((error) => showToast(error.message));
  });

  $("chat-list").addEventListener("click", async (event) => {
    const item = event.target.closest("[data-chat-id]");
    if (!item) return;
    state.selectedChatId = item.dataset.chatId;
    state.editingChatMapping = false;
    const messages = await api(`/admin/api/messages?clientId=${encodeURIComponent(state.selectedClientId)}&chatId=${encodeURIComponent(state.selectedChatId)}&limit=100`);
    state.messages = [
      ...messages.messages,
      ...state.messages.filter((message) => message.client_id !== state.selectedClientId || message.chat_id !== state.selectedChatId)
    ].slice(0, 200);
    render();
  });

  $("active-chat-title").addEventListener("dblclick", () => {
    if (!state.selectedClientId || !state.selectedChatId) return;
    state.editingChatMapping = true;
    render();
    $("chat-phone-editor")?.focus();
  });

  $("active-chat-title").addEventListener("click", async (event) => {
    const saveButton = event.target.closest("[data-save-chat-mapping]");
    if (saveButton) {
      await saveChatMapping();
      return;
    }
    const cancelButton = event.target.closest("[data-cancel-chat-mapping]");
    if (cancelButton) {
      state.editingChatMapping = false;
      render();
    }
  });

  $("active-chat-title").addEventListener("keydown", async (event) => {
    if (event.target.id !== "chat-phone-editor") return;
    if (event.key === "Enter") {
      event.preventDefault();
      await saveChatMapping();
    }
    if (event.key === "Escape") {
      state.editingChatMapping = false;
      render();
    }
  });

  $("chat-send-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.selectedClientId || !state.selectedChatId) return;
    const body = $("chat-send-body").value.trim();
    const file = $("chat-file").files[0];
    if (!body && !file) return;
    const media = file ? await uploadChatFile(file) : null;
    await api("/admin/api/tasks/send-message", {
      method: "POST",
      body: JSON.stringify({
        clientId: state.selectedClientId,
        to: state.selectedChatId,
        chatId: state.selectedChatId,
        body,
        media
      })
    })
      .then(({ task }) => {
        state.tasks = [task, ...state.tasks.filter((item) => item.id !== task.id)].slice(0, 50);
        $("chat-send-body").value = "";
        $("chat-file").value = "";
        showToast(t("taskDispatched"));
        render();
      })
      .catch((error) => showToast(error.message));
  });

  document.querySelectorAll("[data-emoji]").forEach((button) => {
    button.addEventListener("click", () => {
      $("chat-send-body").value += button.dataset.emoji;
      $("chat-send-body").focus();
    });
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

async function uploadChatFile(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/admin/api/uploads", {
    method: "POST",
    credentials: "same-origin",
    body: form
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body.file;
}

async function saveChatMapping() {
  const input = $("chat-phone-editor");
  const phone = input?.value.trim();
  if (!phone || !state.selectedClientId || !state.selectedChatId) return;
  await api("/admin/api/contact-mappings", {
    method: "PUT",
    body: JSON.stringify({
      clientId: state.selectedClientId,
      phone,
      chatId: state.selectedChatId
    })
  })
    .then(async () => {
      state.editingChatMapping = false;
      await refreshChats();
      const messages = await api(`/admin/api/messages?clientId=${encodeURIComponent(state.selectedClientId)}&chatId=${encodeURIComponent(state.selectedChatId)}&limit=100`);
      state.messages = [
        ...messages.messages,
        ...state.messages.filter((message) => message.client_id !== state.selectedClientId || message.chat_id !== state.selectedChatId)
      ].slice(0, 200);
      showToast("Phone mapping updated");
      render();
    })
    .catch((error) => showToast(error.message));
}

async function removeClient(clientId) {
  await api(`/admin/api/clients/${clientId}/data`, { method: "DELETE" })
    .then(() => {
      removeClientFromState(clientId);
      showToast(t("clientRemoved"));
      render();
    })
    .catch((error) => showToast(error.message));
}

function removeClientFromState(clientId) {
  state.clients = state.clients.filter((client) => client.id !== clientId);
  state.clientConfigs = state.clientConfigs.filter((config) => config.client_id !== clientId);
  state.tasks = state.tasks.filter((task) => task.client_id !== clientId);
  state.messages = state.messages.filter((message) => message.client_id !== clientId);
  state.chats = state.chats.filter((chat) => chat.client_id !== clientId);
  if (state.selectedClientId === clientId) {
    state.selectedClientId = "";
    state.selectedChatId = "";
    state.chats = [];
  }
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
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.user) {
    refreshHubState().catch(() => {});
  }
});
load().catch((error) => {
  setConnectionLabel(t("connectionFailed"));
  showToast(error.message);
});
