# LAN Mesh Chat

局域网去中心化聊天（独立项目，与 fbControl 并列）。无中心服务端：发现邻居、点对点私聊、建群邀请、群聊，以及图片 / 文件直传。

应用图标：`build/icon.ico`（Windows 桌面 / 任务栏 / 安装包）、`build/icon.png`、`src/ui/icon.png`（窗口图标）。

## 端口

| 用途 | 端口 |
|------|------|
| HTTP 发现 / 邀请 / 文件拉取 | `17901` |
| WebSocket 消息 mesh | `17902` |

与 fbControl（17890 / 17891）不冲突，可同时运行。

## 功能

- **群聊**：建群 → 邀请需同意 → 群内文字 gossip
- **点对点私聊**：邻居列表点「私聊」，消息单播，不向第三方 gossip
- **图片**：聊天窗「图片」按钮、粘贴图片；气泡内联预览，点击放大
- **文件**：聊天窗「文件」按钮；WS 信令 + HTTP 直拉，落盘到本机 `userData/media`

## 开发运行

```bash
cd d:\work\lan-mesh-chat
npm install
npm start
```

## 打包（可打两个独立包）

本机可同时安装 / 运行两套，端口与数据目录互不冲突：

| 命令 | 产品名 | 端口 | 说明 |
|------|--------|------|------|
| `npm run dist` | LAN Mesh Chat | 17901 / 17902 | 默认包 |
| `npm run dist:alt` | LAN Mesh Chat Alt | 17911 / 17912 | 第二套，可并存 |
| `npm run dist:all` | 两个都打 | — | 依次产出 |

产物在 `release/`（含 NSIS 安装包与 portable 免安装版）。  
不同 `appId` / 产品名 → Windows 下各自独立的用户数据目录。

### 本机双实例试用

两个窗口需隔离用户数据目录，且第二实例端口偏移（避免抢 17901/17902）：

```bash
# 终端 1 — 端口 17901 / 17902
npm start

# 终端 2 — 端口 17911 / 17912，独立 userData
npm run dev:alt
```

1. 两边分别设置花名并保存  
2. 点「扫描局域网」：主实例「额外 HTTP 端口」填 `17911`  
3. 邻居旁点「私聊」互发文字 / 图片 / 文件；或「新建群」邀请入群  

## 双机试用

1. 两台电脑同一局域网，防火墙放行 TCP `17901`、`17902`  
2. 各自 `npm start`，设置花名  
3. 扫描 → 私聊或建群 → 发消息 / 图片 / 文件  

## 协议摘要

- `GET /hello` — 发现  
- `POST /invite` — 邀请入群（返回 `inviteId`，立即返回）  
- `GET /invite-status?inviteId=` — 轮询同意/拒绝  
- `GET /file/:transferId` — 点对点拉取文件字节  
- `WS :17902/mesh` — `hello` / `chat` / `sync` / `group-meta` / `file-offer` / `file-ack`  

私聊会话 id 为确定性 `dm-{sortedClientIds}`；媒体消息 `kind` 为 `image` 或 `file`。

## 后续

- 断点续传 / 更大文件流式写入  
- 与 fbControl 合并或共享发现层  
