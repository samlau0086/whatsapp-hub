# WhatsApp Actor Hub

一个用于调度多台内网 WhatsApp client 的 actor hub。推荐部署方式是：Hub 放在公网 VPS，所有内网电脑上的 WhatsApp client agent 主动连出到 VPS Hub。VPS 不需要反向访问内网机器。

`whatsapp-web.js` 是 WhatsApp Web 的非官方 API，生产环境需要自行评估 WhatsApp 风控、封号、隐私和合规风险。

## 架构

```mermaid
flowchart LR
  app[Other web apps] -->|REST API over HTTPS| hub[WhatsApp Actor Hub on VPS]
  dashboard[Web console] -->|REST + Socket.IO| hub
  c1[LAN PC client agent A] -->|outbound Socket.IO over HTTPS| hub
  c2[LAN PC client agent B] -->|outbound Socket.IO over HTTPS| hub
  hub -->|task event on existing socket| c1
  hub -->|task event on existing socket| c2
  hub -->|webhook push| app
```

## 功能

- 动态注册、删除、查看 WhatsApp clients。
- 根据在线状态调度指定 client 或随机在线 client。
- 发送消息任务状态：`queued`、`running`、`succeeded`、`failed`。
- client 收到消息后上报 hub，支持按 client、sender、chat 查询消息历史。
- 记录 API 请求历史，包括路径、状态码、来源 IP、耗时和脱敏后的请求体。
- Webhook 推送 `message.created` 和 `task.updated`。
- Web 中控实时查看 clients、tasks、messages、API requests，并手动发起发送任务。
- Web 中控使用登录页和 session cookie，支持多用户、角色和权限管理。
- Web 后台可生成 API token、编辑 token 权限、禁用或 revoke token，不需要在构建时固定写死 API token。
- 集中聊天界面支持文本、emoji、图片、视频和文件发送。

## 本地开发

```bash
cp .env.example .env
npm install
npm run dev
```

打开 `http://localhost:3000`，输入 `.env` 中的 `HUB_API_TOKEN`。

## VPS 部署

VPS 上建议用 Docker Compose 运行 Hub，并用 Nginx/Caddy/Traefik 提供 HTTPS 反向代理。公网入口请使用 HTTPS，因为 agent 会长期保持 Socket.IO 连接，业务系统也会通过公网 API 调度任务。

VPS 上的 `.env` 示例：

```bash
PORT=3000
DATABASE_PATH=./data/hub.sqlite
UPLOAD_DIR=./data/uploads
HUB_API_TOKEN=replace-with-a-long-random-token
WEB_ADMIN_USERNAME=admin
WEB_ADMIN_PASSWORD=replace-with-a-long-random-admin-password
PUBLIC_BASE_URL=https://hub.example.com
TRUST_PROXY=true
HOST_BIND_ADDRESS=127.0.0.1
HOST_PORT=3000
```

启动：

```bash
docker compose up -d --build
```

## GitHub Actions 自动部署

仓库已包含 `.github/workflows/deploy-vps.yml`。推送到 `main` 或手动运行 workflow 时，GitHub Actions 会打包项目，通过 SSH 上传到 VPS，然后执行 `docker compose up -d --build --remove-orphans`。

在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions -> Repository secrets` 添加：

- `VPS_HOST`: VPS IP 或域名。
- `VPS_PORT`: SSH 端口，默认可填 `22`。
- `VPS_USER`: SSH 用户，例如 `root` 或 `deploy`。
- `VPS_SSH_PRIVATE_KEY`: GitHub Actions 用于登录 VPS 的私钥。
- `VPS_DEPLOY_PATH`: 部署目录，例如 `/opt/whatsapp-hub`。
- `VPS_ENV_FILE`: 生产环境 `.env` 的完整内容。

`VPS_ENV_FILE` 示例：

```bash
PORT=3000
DATABASE_PATH=./data/hub.sqlite
UPLOAD_DIR=./data/uploads
HUB_API_TOKEN=replace-with-a-long-random-token
WEB_ADMIN_USERNAME=admin
WEB_ADMIN_PASSWORD=replace-with-a-long-random-admin-password
PUBLIC_BASE_URL=https://hub.example.com
TRUST_PROXY=true
HOST_BIND_ADDRESS=127.0.0.1
HOST_PORT=3000
```

VPS 需要提前安装 Docker 和 Docker Compose，并允许上述 SSH 用户访问 Docker。首次部署前确认目录存在权限正常，或让 workflow 自动创建 `VPS_DEPLOY_PATH`。Actions 会把该 secret 写成 VPS 上的 `hub.env`，并只把 `HOST_BIND_ADDRESS`、`HOST_PORT`、`PORT` 提供给 Compose 做端口插值，因此 `HUB_API_TOKEN` 里可以包含 `$`。

VPS 镜像只安装 Hub 运行所需依赖，不安装 `whatsapp-web.js` 和 Puppeteer。内网电脑运行 agent 时使用普通 `npm install`，会安装这些 optional dependencies。

## Web 登录和权限

首次启动时，如果数据库里还没有用户，Hub 会使用环境变量创建初始管理员：

```bash
WEB_ADMIN_USERNAME=admin
WEB_ADMIN_PASSWORD=replace-with-a-long-random-admin-password
```

之后登录 `https://hub.example.com/login`，可以在 Web UI 的 User Management 面板里创建和删除用户。环境变量只用于首次初始化；已经创建用户后，修改环境变量不会覆盖数据库里的用户密码。

内置角色：

- `admin`: 查看所有数据、发送任务、删除 clients、管理 users。
- `operator`: 查看 clients/tasks/messages/API requests，并发送任务。
- `viewer`: 只读查看 clients/tasks/messages。

外部业务系统和内网 WhatsApp client agent 不使用 Web 用户登录，仍然使用 `HUB_API_TOKEN` 调用 `/api/*` 和连接 Socket.IO。

## API Token 管理

超级管理员登录 Web UI 后，可以在 API Tokens 面板生成动态 token。生成时只显示一次明文 token，请立即保存。

动态 token 支持以下权限：

- `agent:connect`: WhatsApp client agent 连接 Socket.IO。
- `clients:read`: 查询 clients。
- `clients:delete`: 删除 clients 和清理 client 数据。
- `tasks:read`: 查询任务。
- `tasks:send`: 创建发送任务。
- `tasks:assign`: 手动改派任务。
- `messages:read`: 查询消息和 chats。
- `requests:read`: 查询 API 请求记录。
- `webhooks:manage`: 管理 webhooks。
- `uploads:create`: 上传媒体附件。

`.env` 里的 `HUB_API_TOKEN` 仍作为 bootstrap/兼容 token 保留，拥有全部权限；正式业务系统建议改用 Web 后台生成的动态 token，并按需授予最小权限。

Nginx 反向代理示例，重点是保留 WebSocket upgrade：

```nginx
server {
  server_name hub.example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

## 内网 WhatsApp Client Agent

Agent 脚本位于 `agents/wwebjs-client/index.js`，通过 `npm run agent` 启动。每台运行 WhatsApp Web 的内网电脑都运行一个 agent。它只需要能访问 VPS 的 HTTPS 地址，不需要公网 IP，也不需要开放任何入站端口。

Agent 做的事情：

- 使用 `whatsapp-web.js` 启动 WhatsApp Web client。
- 首次运行在终端打印二维码，扫码后保存登录会话。
- 通过 Socket.IO 主动连接 VPS Hub。
- 向 Hub 注册 `CLIENT_ID`、名称、手机号和在线状态。
- 接收 Hub 下发的 `send-message` 任务。
- 把收到的 WhatsApp 消息、发送结果、任务失败原因回传到 Hub。

### 在内网电脑安装

内网电脑需要安装 Node.js LTS。然后获取本项目代码，可以直接 clone GitHub 仓库：

```bash
git clone https://github.com/samlau0086/whatsapp-hub.git
cd whatsapp-hub
npm install
```

如果只想部署 agent，也可以只复制这些文件和目录到内网电脑：

```text
package.json
agents/wwebjs-client/index.js
```

但推荐 clone 完整仓库，后续更新更方便。

### Agent 环境变量

在内网电脑的项目根目录创建 `.env`：

```bash
HUB_URL=https://ws.geekmt.com
CLIENT_ID=office-pc-01
CLIENT_NAME=Office PC 01
CLIENT_TOKEN=replace-with-the-same-value-as-HUB_API_TOKEN
WWEBJS_AUTH_DATA_PATH=./.wwebjs_auth
WWEBJS_CACHE_PATH=./.wwebjs_cache
CLIENT_PROXY_URL=
CLIENT_PROXY_USERNAME=
CLIENT_PROXY_PASSWORD=
PUPPETEER_HEADLESS=false
```

字段说明：

- `HUB_URL`: VPS Hub 公网地址，例如 `https://ws.geekmt.com`。
- `CLIENT_ID`: 当前内网电脑的唯一 ID。每台电脑必须不同，例如 `office-pc-01`、`store-pc-02`。
- `CLIENT_NAME`: Web 中控显示名称。
- `CLIENT_TOKEN`: 必须等于 VPS Hub 的 `HUB_API_TOKEN`。
- `WWEBJS_AUTH_DATA_PATH`: WhatsApp Web 登录态保存目录。必须持久化，不能每次启动换目录或删除。
- `WWEBJS_CACHE_PATH`: WhatsApp Web 版本缓存目录。
- `CLIENT_PROXY_URL`: 当前 client 使用的代理，例如 `http://127.0.0.1:7890`、`socks5://127.0.0.1:1080`。
- `CLIENT_PROXY_USERNAME`: 代理用户名，没有认证可留空。
- `CLIENT_PROXY_PASSWORD`: 代理密码，没有认证可留空。
- `PUPPETEER_HEADLESS`: 首次调试建议 `false`，稳定后可改为 `true`。

启动 agent：

```bash
npm run agent
```

首次运行会在终端显示二维码，用手机 WhatsApp 扫码登录。扫码成功后，Web 中控的 Clients 列表应看到该 `CLIENT_ID` 在线。

### 保留 WhatsApp 登录态

Agent 使用 `whatsapp-web.js` 的 `LocalAuth` 保存登录态。默认保存到项目目录下：

```text
.wwebjs_auth/
.wwebjs_cache/
```

只要这两个目录保留、`CLIENT_ID` 不变、启动用户有读写权限，下一次启动通常不需要重新扫码。

如果你用 PM2、Windows 任务计划、服务管理器或从不同目录启动 agent，建议使用绝对路径：

```bash
WWEBJS_AUTH_DATA_PATH=C:/whatsapp-hub-data/auth
WWEBJS_CACHE_PATH=C:/whatsapp-hub-data/cache
```

不要把这些目录放进临时目录，也不要在更新代码时删除它们。每台内网电脑可以有自己的保存目录；同一台电脑上多个 client 也必须使用不同的 `CLIENT_ID`。

### 同一设备运行多个 clients

同一台设备可以运行多个 agent，但每个 agent 必须使用独立配置：

- 不同的 `CLIENT_ID`
- 不同的 `CLIENT_NAME`
- 不同的 `WWEBJS_AUTH_DATA_PATH`
- 不同的 `WWEBJS_CACHE_PATH`
- 如需隔离网络出口，配置不同的 `CLIENT_PROXY_URL`

示例一：

```bash
HUB_URL=https://ws.geekmt.com
CLIENT_ID=office-pc-01
CLIENT_NAME=Office PC 01
CLIENT_TOKEN=replace-with-the-same-value-as-HUB_API_TOKEN
WWEBJS_AUTH_DATA_PATH=C:/whatsapp-hub-data/office-pc-01/auth
WWEBJS_CACHE_PATH=C:/whatsapp-hub-data/office-pc-01/cache
CLIENT_PROXY_URL=socks5://127.0.0.1:1081
PUPPETEER_HEADLESS=false
```

示例二：

```bash
HUB_URL=https://ws.geekmt.com
CLIENT_ID=office-pc-02
CLIENT_NAME=Office PC 02
CLIENT_TOKEN=replace-with-the-same-value-as-HUB_API_TOKEN
WWEBJS_AUTH_DATA_PATH=C:/whatsapp-hub-data/office-pc-02/auth
WWEBJS_CACHE_PATH=C:/whatsapp-hub-data/office-pc-02/cache
CLIENT_PROXY_URL=http://127.0.0.1:7890
PUPPETEER_HEADLESS=false
```

如果代理需要账号密码：

```bash
CLIENT_PROXY_URL=http://proxy.example.com:8080
CLIENT_PROXY_USERNAME=my-user
CLIENT_PROXY_PASSWORD=my-password
```

代理由 Chromium/Puppeteer 使用，用于 WhatsApp Web 页面访问；Hub 的 Socket.IO 连接仍按系统网络直接连接 VPS。

### Windows 持续运行

开发测试可以直接保持 PowerShell 窗口运行：

```powershell
cd C:\path\to\whatsapp-hub
npm run agent
```

生产环境建议使用进程管理器，例如 PM2：

```powershell
npm install -g pm2
pm2 start agents/wwebjs-client/index.js --name whatsapp-agent-office-pc-01
pm2 save
```

如果使用 PM2，请确保运行命令的目录里存在 `.env`，并且该 Windows 用户有权限读写 `WWEBJS_AUTH_DATA_PATH` 和 `WWEBJS_CACHE_PATH`。也可以显式指定工作目录：

```powershell
pm2 start agents/wwebjs-client/index.js --name whatsapp-agent-office-pc-01 --cwd C:\path\to\whatsapp-hub
```

### 测试连接

在内网电脑上先确认能访问 VPS Hub：

```bash
curl https://ws.geekmt.com/health
```

然后启动 agent。Hub Web 中控应该出现在线 client。也可以用 API 查看：

```bash
curl -H "x-hub-token: replace-with-the-same-value-as-HUB_API_TOKEN" https://ws.geekmt.com/api/clients
```

### 注意事项

- 每台内网电脑使用不同的 `CLIENT_ID`，否则后上线的连接会覆盖前一个同 ID client。
- 不要在 VPS 容器里运行 `npm run agent`。VPS 只运行 Hub，agent 应运行在实际登录 WhatsApp 的内网电脑上。
- 如果 WhatsApp 退出登录或二维码过期，重新运行 agent 并扫码。若每次都要求扫码，优先检查 `WWEBJS_AUTH_DATA_PATH` 是否固定、目录是否被删除、`CLIENT_ID` 是否变化、启动用户是否有权限。
- `whatsapp-web.js` 使用非官方 WhatsApp Web 接口，请控制发送频率，避免异常批量行为。

## API

所有 `/api/*` 请求都面向外部业务系统和 WhatsApp client agent，需要携带：

```http
x-hub-token: replace-with-a-long-random-token
```

示例中的域名请替换为你的 Hub 地址，例如 `https://ws.geekmt.com`。

### 创建发送任务

请求：

```bash
curl -X POST https://hub.example.com/api/tasks/send-message \
  -H "content-type: application/json" \
  -H "x-hub-token: replace-with-a-long-random-token" \
  -d "{\"to\":\"15551234567\",\"body\":\"hello from hub\",\"metadata\":{\"source\":\"crm\"}}"
```

调度规则：

- 如果目标手机号之前已有成功的 outbound 发送记录，优先使用上次给该手机号发送消息的 client。
- 如果该历史 client 当前离线，任务会保持 `queued`，等该 client 上线后自动发送。
- 如果没有历史 client，才使用请求里的 `clientId`。
- 如果没有历史 client 且没有传 `clientId`，随机选择一个在线 client。
- Web 后台或 API 可以手动把 queued 任务改派给其他 client。

```json
{
  "clientId": "office-pc-01",
  "to": "15551234567",
  "body": "hello from hub",
  "metadata": {
    "source": "crm"
  }
}
```

响应 `202 Accepted`：

```json
{
  "task": {
    "id": "9c52421c-7c6c-46c6-b88a-25f4d3aa8a52",
    "type": "send-message",
    "status": "running",
    "client_id": "office-pc-01",
    "target_phone": "15551234567",
    "payload": {
      "to": "15551234567",
      "body": "hello from hub",
      "metadata": {
        "source": "crm"
      }
    },
    "result": null,
    "error": null,
    "created_at": "2026-05-24T10:00:00.000Z",
    "updated_at": "2026-05-24T10:00:00.100Z",
    "completed_at": null
  }
}
```

如果命中历史 client 但该 client 离线，响应里的任务会是 `queued`：

```json
{
  "task": {
    "id": "7a4926da-26bb-4f90-8d1c-3f3ad84b6db4",
    "type": "send-message",
    "status": "queued",
    "client_id": "office-pc-01",
    "target_phone": "15551234567",
    "payload": {
      "to": "15551234567",
      "body": "hello from hub",
      "metadata": {},
      "routing": {
        "reason": "sticky-target-client",
        "requestedClientId": null,
        "stickyClientId": "office-pc-01"
      }
    },
    "result": null,
    "error": "waiting for client office-pc-01 to come online",
    "created_at": "2026-05-24T10:00:00.000Z",
    "updated_at": "2026-05-24T10:00:00.100Z",
    "completed_at": null
  }
}
```

常见错误：

```json
{
  "error": "no online clients available"
}
```

### 上传并发送媒体消息

先上传附件。支持图片、视频和普通文件，单文件默认最大 50 MB：

```bash
curl -X POST https://hub.example.com/api/uploads \
  -H "x-hub-token: replace-with-a-long-random-token" \
  -F "file=@./invoice.pdf"
```

响应：

```json
{
  "file": {
    "id": "f3a1d28db4d94b6b9e9c0f0b4e5a7d23",
    "originalName": "invoice.pdf",
    "mimeType": "application/pdf",
    "size": 245760,
    "path": "data/uploads/f3a1d28db4d94b6b9e9c0f0b4e5a7d23",
    "url": "/uploads/f3a1d28db4d94b6b9e9c0f0b4e5a7d23"
  }
}
```

然后把响应里的 `file` 放进发送任务的 `media` 字段：

```bash
curl -X POST https://hub.example.com/api/tasks/send-message \
  -H "content-type: application/json" \
  -H "x-hub-token: replace-with-a-long-random-token" \
  -d "{\"to\":\"15551234567\",\"body\":\"please check this file\",\"media\":{\"url\":\"/uploads/f3a1d28db4d94b6b9e9c0f0b4e5a7d23\",\"originalName\":\"invoice.pdf\",\"mimeType\":\"application/pdf\",\"sendAsDocument\":true}}"
```

图片或视频可以不传 `sendAsDocument`，文件建议传 `true`：

```json
{
  "to": "15551234567",
  "body": "photo caption",
  "media": {
    "url": "/uploads/f3a1d28db4d94b6b9e9c0f0b4e5a7d23",
    "originalName": "photo.jpg",
    "mimeType": "image/jpeg",
    "sendAsDocument": false
  }
}
```

### 查询 clients

请求：

```bash
curl -H "x-hub-token: replace-with-a-long-random-token" https://hub.example.com/api/clients
```

响应：

```json
{
  "clients": [
    {
      "id": "office-pc-01",
      "name": "Office PC 01",
      "phone": "15551234567",
      "status": "online",
      "metadata": {
        "platform": "whatsapp-web.js",
        "pushname": "Sales"
      },
      "created_at": "2026-05-24T09:50:00.000Z",
      "updated_at": "2026-05-24T10:00:15.000Z",
      "last_seen_at": "2026-05-24T10:00:15.000Z"
    }
  ]
}
```

查询单个 client：

```bash
curl -H "x-hub-token: replace-with-a-long-random-token" https://hub.example.com/api/clients/office-pc-01
```

响应：

```json
{
  "client": {
    "id": "office-pc-01",
    "name": "Office PC 01",
    "phone": "15551234567",
    "status": "online",
    "metadata": {
      "platform": "whatsapp-web.js"
    },
    "created_at": "2026-05-24T09:50:00.000Z",
    "updated_at": "2026-05-24T10:00:15.000Z",
    "last_seen_at": "2026-05-24T10:00:15.000Z"
  }
}
```

### 查询任务

请求：

```bash
curl -H "x-hub-token: replace-with-a-long-random-token" https://hub.example.com/api/tasks
curl -H "x-hub-token: replace-with-a-long-random-token" https://hub.example.com/api/tasks/<task-id>
```

支持查询参数：

- `clientId`: 只看某个 client 的任务。
- `status`: 只看某个状态，例如 `running`、`succeeded`、`failed`。
- `limit`: 返回数量，最大 500。

列表响应：

```json
{
  "tasks": [
    {
      "id": "9c52421c-7c6c-46c6-b88a-25f4d3aa8a52",
      "type": "send-message",
      "status": "succeeded",
      "client_id": "office-pc-01",
      "target_phone": "15551234567",
      "payload": {
        "to": "15551234567",
        "body": "hello from hub",
        "metadata": {
          "source": "crm"
        }
      },
      "result": {
        "messageId": "true_15551234567@c.us_ABCDEF",
        "chatId": "15551234567@c.us"
      },
      "error": null,
      "created_at": "2026-05-24T10:00:00.000Z",
      "updated_at": "2026-05-24T10:00:03.000Z",
      "completed_at": "2026-05-24T10:00:03.000Z"
    }
  ]
}
```

单条响应：

```json
{
  "task": {
    "id": "9c52421c-7c6c-46c6-b88a-25f4d3aa8a52",
    "type": "send-message",
    "status": "succeeded",
    "client_id": "office-pc-01",
    "target_phone": "15551234567",
    "payload": {
      "to": "15551234567",
      "body": "hello from hub",
      "metadata": {}
    },
    "result": {
      "messageId": "true_15551234567@c.us_ABCDEF",
      "chatId": "15551234567@c.us"
    },
    "error": null,
    "created_at": "2026-05-24T10:00:00.000Z",
    "updated_at": "2026-05-24T10:00:03.000Z",
    "completed_at": "2026-05-24T10:00:03.000Z"
  }
}
```

### 查询消息

请求：

```bash
curl -H "x-hub-token: replace-with-a-long-random-token" "https://hub.example.com/api/messages?clientId=office-pc-01&limit=100"
curl -H "x-hub-token: replace-with-a-long-random-token" "https://hub.example.com/api/messages?targetPhone=15551234567&limit=100"
curl -H "x-hub-token: replace-with-a-long-random-token" "https://hub.example.com/api/clients/office-pc-01/messages"
```

支持查询参数：

- `clientId`: client ID。
- `targetPhone`: 目标手机号，会匹配 `sender`、`recipient` 和 `chat_id`。
- `sender`: 发件人。
- `chatId`: WhatsApp chat ID。
- `limit`: 返回数量，最大 500。

响应：

```json
{
  "messages": [
    {
      "id": "8f2fd5ed-0928-4ef9-9f57-57cb7fb359d1",
      "external_id": "false_15557654321@c.us_123456",
      "client_id": "office-pc-01",
      "direction": "inbound",
      "chat_id": "15557654321@c.us",
      "sender": "15557654321@c.us",
      "recipient": "15551234567@c.us",
      "body": "hi",
      "message_type": "chat",
      "payload": {
        "from": "15557654321@c.us",
        "to": "15551234567@c.us",
        "hasMedia": false,
        "type": "chat"
      },
      "created_at": "2026-05-24T10:02:00.000Z",
      "received_at": "2026-05-24T10:02:01.000Z"
    }
  ]
}
```

### 手动改派任务

请求：

```bash
curl -X PATCH https://hub.example.com/api/tasks/7a4926da-26bb-4f90-8d1c-3f3ad84b6db4/assign \
  -H "content-type: application/json" \
  -H "x-hub-token: replace-with-a-long-random-token" \
  -d "{\"clientId\":\"backup-pc-01\"}"
```

响应：

```json
{
  "task": {
    "id": "7a4926da-26bb-4f90-8d1c-3f3ad84b6db4",
    "type": "send-message",
    "status": "running",
    "client_id": "backup-pc-01",
    "target_phone": "15551234567",
    "payload": {
      "to": "15551234567",
      "body": "hello from hub",
      "metadata": {}
    },
    "result": null,
    "error": null,
    "created_at": "2026-05-24T10:00:00.000Z",
    "updated_at": "2026-05-24T10:03:00.000Z",
    "completed_at": null
  }
}
```

### 查询 API 请求记录

请求：

```bash
curl -H "x-hub-token: replace-with-a-long-random-token" "https://hub.example.com/api/requests?limit=100"
curl -H "x-hub-token: replace-with-a-long-random-token" "https://hub.example.com/api/requests?statusCode=500"
```

响应：

```json
{
  "requests": [
    {
      "id": "cce7b6ad-42c5-4dd3-912f-830f7a7517d1",
      "method": "POST",
      "path": "/api/tasks/send-message",
      "status_code": 202,
      "client_ip": "203.0.113.10",
      "user_agent": "curl/8.0.1",
      "request_body": {
        "to": "15551234567",
        "body": "hello from hub"
      },
      "response_time_ms": 18,
      "created_at": "2026-05-24T10:00:00.000Z"
    }
  ]
}
```

### 注册 webhook

请求：

```bash
curl -X POST https://hub.example.com/api/webhooks \
  -H "content-type: application/json" \
  -H "x-hub-token: replace-with-a-long-random-token" \
  -d "{\"url\":\"https://example.com/whatsapp-events\",\"events\":[\"message.created\",\"task.updated\"],\"secret\":\"shared-secret\"}"
```

响应：

```json
{
  "webhook": {
    "id": "5b9c2e53-94d4-4477-9f4d-f68765478204",
    "url": "https://example.com/whatsapp-events",
    "events": [
      "message.created",
      "task.updated"
    ],
    "secret": "shared-secret",
    "enabled": true,
    "created_at": "2026-05-24T10:05:00.000Z",
    "updated_at": "2026-05-24T10:05:00.000Z"
  }
}
```

查询 webhook：

```bash
curl -H "x-hub-token: replace-with-a-long-random-token" https://hub.example.com/api/webhooks
```

响应：

```json
{
  "webhooks": [
    {
      "id": "5b9c2e53-94d4-4477-9f4d-f68765478204",
      "url": "https://example.com/whatsapp-events",
      "events": [
        "message.created",
        "task.updated"
      ],
      "secret": "shared-secret",
      "enabled": true,
      "created_at": "2026-05-24T10:05:00.000Z",
      "updated_at": "2026-05-24T10:05:00.000Z"
    }
  ]
}
```

删除 webhook：

```bash
curl -X DELETE \
  -H "x-hub-token: replace-with-a-long-random-token" \
  https://hub.example.com/api/webhooks/5b9c2e53-94d4-4477-9f4d-f68765478204
```

响应：

```json
{
  "ok": true
}
```

## 关键环境变量

Hub:

- `PORT`: 容器内 Hub 端口，默认 `3000`。
- `HOST_BIND_ADDRESS`: VPS 绑定地址。使用 Nginx 反代时建议 `127.0.0.1`。
- `HOST_PORT`: VPS 绑定端口。如果 `3000` 已被占用，可以改成 `3001`，并让 Nginx 反代到对应端口。
- `DATABASE_PATH`: SQLite 文件位置，默认 `./data/hub.sqlite`。
- `UPLOAD_DIR`: Web 后台上传附件保存目录，默认 `./data/uploads`。
- `HUB_API_TOKEN`: API 和 Socket.IO 认证 token。
- `WEB_ADMIN_USERNAME`: 首次初始化 Web 管理员用户名。
- `WEB_ADMIN_PASSWORD`: 首次初始化 Web 管理员密码。
- `PUBLIC_BASE_URL`: Hub 对外访问地址，例如 `https://hub.example.com`。
- `TRUST_PROXY`: 使用 Nginx/Caddy 等反向代理时设为 `true`。
- `CLIENT_OFFLINE_AFTER_MS`: 心跳超时后标记离线，默认 45 秒。

Agent:

- `HUB_URL`: VPS Hub 地址，例如 `https://hub.example.com`。
- `CLIENT_ID`: client 唯一 ID。
- `CLIENT_NAME`: 中控显示名称。
- `CLIENT_TOKEN`: 连接 hub 的 token，应与 `HUB_API_TOKEN` 一致。
- `WWEBJS_AUTH_DATA_PATH`: WhatsApp Web 登录态保存目录。
- `WWEBJS_CACHE_PATH`: WhatsApp Web 缓存目录。
- `CLIENT_PROXY_URL`: WhatsApp Web 访问代理。
- `CLIENT_PROXY_USERNAME`: 代理用户名。
- `CLIENT_PROXY_PASSWORD`: 代理密码。
- `PUPPETEER_HEADLESS`: 是否无头运行 Chromium。

## Web 后台新增 Client 部署

超级管理员或具备 client 管理权限的用户可以在 Web 中控的 Clients 面板点击 `New client`：

1. 填写 `client id`、`client name`、认证目录、缓存目录、代理等参数。
2. 保存后 Hub 会预注册一个 offline client，并生成该 client 专用的 agent token。
3. 页面会显示个性化部署说明，内网电脑只需要下载：
   - `/agent/package.json`
   - `/agent/wwebjs-client.js`
   - 生成的 `.env`

这样内网电脑无需下载整个 hub 项目代码。生成的 token 只在创建后显示在部署说明中；若丢失，建议重新创建 client 配置或生成新的 agent token。

部署说明中的 token 默认只包含：

- `agent:connect`
- `uploads:create`

也就是只允许 WhatsApp client agent 连接 Hub 和下载待发送媒体文件，不授予外部业务 API 的读写权限。

## 后续可扩展点

- 将 SQLite 替换为 Postgres/MySQL，并加入多 hub 实例共享状态。
- 为不同业务系统和 client 增加独立 API key、权限范围、限流和审计。
- 支持媒体消息下载、对象存储、消息去重和重试队列。
- 增加任务优先级、按手机号绑定固定 client、失败自动切换 client。
- Webhook 使用 HMAC 签名替代当前简单 shared secret header。
