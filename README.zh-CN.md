# pi-webui — 固定端口 Hub 之下的当前 Pi 会话浏览器伴侣

**中文** | [English](README.md)

> **推广申明**：本项目完全开源（MIT），遵循 [LINUX DO](https://linux.do) 社区的开源推广规则进行公开版面推广。感谢社区与各位佬友的意见与支持。

在浏览器里查看你终端中正在运行的那个 Pi 会话，并且让所有 Pi 会话共用一个固定端口。

本项目是对 [`narumiruna/pi-extensions/deprecated/pi-webui`](https://github.com/narumiruna/pi-extensions/tree/main/deprecated/pi-webui)（MIT，上游已归档）的移植，做了三处刻意的改动：

1. **不提供鉴权。** 会话服务器与 Hub 都只监听回环地址，直接打开 `http://127.0.0.1:43118/` 就能用。远程访问由使用者自己解决 —— 在 Hub 前面加上你自己的访问控制（例如 Cloudflare Zero Trust）。
2. **所有会话共用一个固定端口。** 一个小型 Hub 服务持有该端口，并根据请求把它转给页面的所属会话，因此 `/s/<sessionId>/` 就能寻址到某个会话。
3. **Hub 只做转发，绝不承载 agent。** Hub 不会打开、读取或写入任何 Pi 会话，它只在浏览器与已注册的会话之间转发 HTTP 与 Server-Sent Events。

## 为什么这种设计不会和终端打架

其他 Pi 网页界面跑的是一个*拥有会话*的服务器：它们自己构造 agent runtime，用 `SessionManager.open(...)` 打开已存在的会话文件，然后和终端里的 Pi 进程**同时**往同一份 `~/.pi/agent/sessions/*.jsonl` 里写。Pi 内核并不对会话文件加跨进程锁，于是 CLI 和服务器各自守着一份过期的内存视图，静默地越走越偏 —— 终端看不到浏览器轮次、浏览器显示回滚，一次重命名甚至能把会话钉死在一个废弃分支上。上游 `agegr/pi-web` 在自己源码里就点明了这件事（"two processes writing one JSONL is unsupported"），并把跨进程协调列为不做。

pi-webui 从结构上避开了这一整类问题：

- HTTP 服务器**跑在 Pi 进程内部**（`server.listen(0, "127.0.0.1")`），每个会话一个。
- 浏览器输入走 Pi 正常的输入通路（`pi.sendUserMessage(content, { deliverAs })`），与终端打字完全同级，因此终端和浏览器共享同一个 runtime、同一棵会话树、同一个写入者。
- 会话落盘由 Pi 内核负责；pi-webui 从不写会话文件。
- Hub 只做路由：它持有一份在线会话注册表、一个索引页和一套反向代理。

代价是功能范围：一个页面只对应一个会话，没有会话管理器、没有 shell、文件浏览器、git 界面和任务看板；页面也只在那个 Pi 会话存活期间可用。

## 环境要求

- **Node.js ≥ 22.18**（Hub 用 `bin/pi-webui-hub.mjs` 通过 Node 内置的类型擦除直接加载 TypeScript 源码，所以没有构建步骤）。实际测试环境是 Node 24/26。
- Pi Coding Agent；如果你要用图片流水线里的可选格式（PNG/JPEG/WebP/GIF/BMP/TIFF/HEIF/AVIF 由 sharp 处理），运行扩展的会话里需要有 `git`。

## 安装

### 1. 扩展

把本仓库加入 Pi 的包列表（和其他本地扩展的装法一致）：

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["/path/to/pi-webui"]
}
```

或者只临时跑一次：

```bash
pi -e /path/to/pi-webui
pi install /path/to/pi-webui      # 以包的形式永久安装
```

### 2. Hub（systemd 用户服务）

扩展永远不会自己拉 Hub：由一个受监管的服务持有固定端口，这样它能扛住 Pi 的重启与崩溃。`/webui hub` 会把下面这份 unit 里的绝对路径替换好打印出来：

```bash
mkdir -p ~/.config/systemd/user
# 把 `/webui hub` 打印的 unit 粘贴到 ~/.config/systemd/user/pi-webui-hub.service
systemctl --user daemon-reload
systemctl --user enable --now pi-webui-hub.service
systemctl --user status pi-webui-hub.service
```

unit 长这样。它只存在于 `~/.config/systemd/user/`，本仓库不附带任何 service 文件：

```ini
[Unit]
Description=pi-webui hub — fixed-port router for Pi session browser views
After=default.target

[Service]
Type=simple
ExecStart=/usr/bin/env node /path/to/pi-webui/bin/pi-webui-hub.mjs
Restart=on-failure
RestartSec=2
Environment=PI_WEBUI_PORT=43118
# Extra Host header names, needed only when a tunnel or reverse proxy fronts the hub.
Environment=PI_WEBUI_ALLOWED_HOSTS=pi.example.com
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

调试时可以在前台运行 Hub：

```bash
npm run hub            # 或者：pi-webui-hub --port 43118
```

## 使用

在终端里的 Pi 会话中：

| 命令 | 行为 |
| --- | --- |
| `/webui` | 当前状态菜单（打开、设置、状态、帮助） |
| `/webui open` | 把当前会话发布到 Hub，并打印它的链接 |
| `/webui hub` | 打印 systemd unit 与安装步骤 |
| `/webui status` | 服务器、Hub、链接、启动方式、图片上限、设置文件路径 |
| `/webui settings` | TUI 设置界面（对外只暴露 `startOnSessionStart` 一个开关） |
| `/webui init` | 创建默认配置文件，绝不覆盖已有内容 |
| `/webui help` | 命令与设置说明 |

然后打开打印出来的 URL，或者直接看索引页 <http://127.0.0.1:43118/>：

- `/` 列出所有在线会话（项目、模型、空闲/运行中、在线时长、路径），并通过 Server-Sent Events 就地刷新 —— 不重载页面，因此滚动位置和焦点都能保住。
- `/s/<sessionId>/` 是该会话的聊天页：对话记录、流式助手文本、工具活动、错误，以及一个可以发送文本与已清洗图片的输入框。
- 第一个打开该会话的标签页持有编辑租约；其他标签页保持可读，并明确标记为只读。
- Pi 空闲时输入框直接发送；Pi 工作时提供 **Queue next**（作为后续消息排队）与 **Steer**。

如果 Hub 没有运行，`/webui open` 会明确说明，并退回到一个临时端口上的会话内链接，因此没有这个服务时扩展依然可用。

## 安全模型

- **不提供鉴权是刻意设计。** 任何本地进程都可以通过 Hub 驱动已注册的会话，所以请把该端口视同于「能直接对着终端打字」。把它留在回环地址上。
- **Host 校验。** Hub 只回应 `127.0.0.1`、`localhost`、`::1`，以及 `PI_WEBUI_ALLOWED_HOSTS` 里列出的主机名；其他一律 `421`，这同时挡住了 DNS rebinding。
- **Origin 校验。** 会话级写操作必须携带会话自身的 Origin；Hub 在转发前把自己校验通过的浏览器 Origin 改写为会话 Origin，因此来自其他 Origin 的页面（包括你浏览器里某个恶意网页）会被 `403` 拒绝。
- **跨源的控制面写入被阻断。** `/_hub/register|heartbeat|unregister` 要求 JSON content type，跨源页面必须先发预检请求，而 Hub 从不回应预检，所以写操作发不出去。
- **页面带有严格 CSP**，并用每次响应生成的 nonce；会话页保留它自己的 nonce 策略（没有 CDN、没有远程服务、不使用浏览器存储）。
- **远程访问由你自己加。** 用带鉴权的隧道或反向代理（Cloudflare Zero Trust、SSH 隧道、mTLS……）挡在 Hub 前面，并把它的主机名加进 `PI_WEBUI_ALLOWED_HOSTS`。pi-webui 不会自己长出一套鉴权。

## 配置

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_WEBUI_PORT` | `43118` | Hub 固定端口（写在 unit 里） |
| `PI_WEBUI_HOST` | `127.0.0.1` | Hub 监听地址 |
| `PI_WEBUI_ALLOWED_HOSTS` | — | 逗号分隔的额外 `Host` 主机名（代理/隧道） |
| `PI_WEBUI_HUB_URL` | 由 `PI_WEBUI_PORT` 推导 | 扩展使用的 Hub 完整基地址 |
| `PI_WEBUI_HUB_QUIET` | — | `1` 降低 Hub 日志量 |

扩展设置只有一个全局文件：`<getAgentDir()>/pi-webui.json`（通常是 `~/.pi/agent/pi-webui.json`）：

```json
{
  "startOnSessionStart": false,
  "retainSentImages": false,
  "maxImages": 8,
  "maxImageBytes": 10485760,
  "maxBatchBytes": 41943040,
  "maxImagePixels": 50000000
}
```

`startOnSessionStart` 会在每次会话初始化（启动、reload、new、resume、fork）时自动发布会话，而不必等 `/webui open`。JSON 格式错误时文件会被原样保留、忽略并给出警告，绝不会被重写；`/webui status` 会报告生效值与它们的来源。

## 协议（给工具用）

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/_hub/hello` | `GET` | Hub 身份与协议版本 |
| `/_hub/sessions` | `GET` | 当前注册表（JSON） |
| `/_hub/events` | `GET` | 注册表快照的 SSE 流（`event: sessions`） |
| `/_hub/register` | `POST` | 注册会话（会话 id、回环端口、token、元数据） |
| `/_hub/heartbeat` | `POST` | 刷新注册与元数据 |
| `/_hub/unregister` | `POST` | 注销（尽力而为；条目也会自行过期） |
| `/s/<sessionId>/**` | 任意 | 去掉前缀后转发给所属会话 |

注册在大约 40 秒没有心跳后过期，但在宽限期内仍然可路由，因此短暂的停顿不会让已打开的标签页变白。Hub 重启后会被下一个心跳重新填充 —— 会话本身不需要重启。

## 开发

```bash
npm install
npm run verify      # biome check + 类型检查 + 195 个测试
npm run test        # vitest
npm run check       # 只跑 biome
npm run typecheck   # bundle 新鲜度 + tsc --noEmit
npm run build:web   # 用 esbuild 重建 src/web/app.{js,css}
npm run hub         # 前台运行 Hub
```

结构：`src/hub.ts`（路由器，由 Node 通过类型擦除直接执行）、`src/hub-client.ts`（注册/心跳）、`src/hub-protocol.ts`（共享契约）、`src/server.ts`（会话内服务器）、`src/runtime.ts`（Pi 集成）、`src/web/ui/*`（React 客户端，打包进 `src/web/app.js`）。

## 需要知道的行为

- 终端对话记录里，来自浏览器的消息会显示内部信封 `<pi-webui-input nonce="…">`；Pi 会在落盘之前、且在模型看到之前把它替换成真实文本，浏览器页面里也始终显示真实文本。这个信封的作用是：让你从浏览器粘贴进去的内部标记不会被其他扩展误认为真的控制标记，所以它是有意为之，而不是没清理干净的技术债。
- Hub 索引是*已注册*会话的实时视图；退出的 Pi 会话会在过期窗口内自动消失。
- 一个 Hub 服务一台机器上该用户的会话，且只在该回环接口上。
- `pi-webui.json` 的写入与 `/webui init` 通过锁文件串行化；保存进行中时不要手动编辑该文件。

## 许可

MIT。上游：`narumiruna/pi-extensions`（已归档的 `pi-webui`）；本分支保留原有实现与测试，并新增了 Hub、固定端口路由与无鉴权模型。
