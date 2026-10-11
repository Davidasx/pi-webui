# pi-webui — 固定端口 Hub 之下的当前 Pi 会话浏览器伴侣

**中文** | [English](README.md)

> **推广申明**：本项目完全开源（MIT），遵循 [LINUX DO](https://linux.do) 社区的开源推广规则进行公开版面推广。感谢社区与各位佬友的意见与支持。

在浏览器里查看你终端中正在运行的那个 Pi 会话，并且让所有 Pi 会话共用一个固定端口。

本项目是对 [`narumiruna/pi-extensions/deprecated/pi-webui`](https://github.com/narumiruna/pi-extensions/tree/main/deprecated/pi-webui)（MIT，上游已归档）的移植，做了五处刻意的改动：

1. **不提供鉴权。** 会话服务器与 Hub 都只监听回环地址，直接打开 `http://127.0.0.1:43118/` 就能用。远程访问由使用者自己解决 —— 在 Hub 前面加上你自己的访问控制（例如 Cloudflare Zero Trust）。
2. **所有会话共用一个固定端口。** Hub 持有该端口，用 `/?session=<sessionId>` 这种和 `agegr/pi-web` 一致的地址寻址会话；每个 Pi 会话只向 Hub 保持一条 WebSocket，Pi 进程内不再监听任何端口。
3. **Hub 只做转发，绝不承载 agent。** Hub 不会打开、读取或写入任何 Pi 会话，它只在浏览器与已注册的会话之间转发 HTTP 与 Server-Sent Events。
4. **界面改动只需重启 Hub。** 页面与打包产物由 Hub 提供，改界面不用逐个重载 Pi 会话。
5. **页面就是 agegr/pi-web 自己的前端，逐字节复制。** 组件、样式、侧栏、面板以及它们调用的 API 路由都来自上游，所以你看到的是那个界面本身，而不是仿制品；`src/web/pi-web/PORTING.md` 说明了如何保持副本同步。

## 为什么这种设计不会和终端打架

其他 Pi 网页界面跑的是一个*拥有会话*的服务器：它们自己构造 agent runtime，用 `SessionManager.open(...)` 打开已存在的会话文件，然后和终端里的 Pi 进程**同时**往同一份 `~/.pi/agent/sessions/*.jsonl` 里写。Pi 内核并不对会话文件加跨进程锁，于是 CLI 和服务器各自守着一份过期的内存视图，静默地越走越偏 —— 终端看不到浏览器轮次、浏览器显示回滚，一次重命名甚至能把会话钉死在一个废弃分支上。上游 `agegr/pi-web` 在自己源码里就点明了这件事（"two processes writing one JSONL is unsupported"），并把跨进程协调列为不做。

pi-webui 从结构上避开了这一整类问题：

- 每个会话的 API 都由**它自己所在的 Pi 进程**应答：Hub 通过该会话的 WebSocket 把浏览器的请求转发进去，Pi 进程不再监听任何端口。
- 浏览器输入走 Pi 正常的输入通路（`pi.sendUserMessage(content, { deliverAs })`），与终端打字完全同级，因此终端和浏览器共享同一个 runtime、同一棵会话树、同一个写入者。
- 会话落盘由 Pi 内核负责；pi-webui 从不写会话文件。
- Hub 只做路由：它持有一份在线会话注册表、一个索引页和一套反向代理。

页面本身就是上游的：会话侧栏、聊天界面、文件浏览器与查看器、git 状态与 diff、技能、模型、插件、MCP 与设置，全部由从上游复制的路由在本机上应答。刻意不做的，是需要第二个 agent 进程的事情：从浏览器新建会话、fork 一个没在运行的会话、以及终端面板。页面只在该 Pi 会话存活期间可用。

## 环境要求

- **Node.js ≥ 22.18**（Hub 用 `bin/pi-webui-hub.mjs` 通过 Node 内置的类型擦除直接加载 TypeScript 源码，所以没有构建步骤）。实际测试环境是 Node 24/26。
- Pi Coding Agent；扩展本身除 Node 与 Pi 之外不需要别的依赖。

## 安装

### 1. 扩展

从 GitHub 安装：

```bash
pi install git:github.com/Davidasx/pi-webui
```

或者临时加载本地目录跑一次，不写入任何安装记录：

```bash
pi -e /path/to/pi-webui
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
# 端口、绑定地址与允许的 Host 名字都在 ~/.pi/agent/pi-webui.json：
#   { "hub": { "port": 43118, "allowedHosts": ["pi.example.com"] } }
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
| `/webui status` | 服务器、Hub、链接、启动方式、设置文件路径 |
| `/webui settings` | TUI 设置界面（对外只暴露 `startOnSessionStart` 一个开关） |
| `/webui init` | 创建默认配置文件，绝不覆盖已有内容 |
| `/webui help` | 命令与设置说明 |

然后打开打印出来的 URL，或者直接看索引页 <http://127.0.0.1:43118/>：

- `/` 列出所有在线会话（项目、模型、空闲/运行中、在线时长、路径），并通过 Server-Sent Events 就地刷新 —— 不重载页面，因此滚动位置和焦点都能保住。
- `/?session=<sessionId>` 是该会话的聊天页（URL 形态与 `agegr/pi-web` 一致）：对话记录、流式助手文本、可折叠的工具卡片、思考块、错误，以及一个可以发送文本与已清洗图片的输入框。
- 顶栏就是 Pi 自己的控制项：**模型**（本会话可用的全部模型，带过滤）、**推理强度**、**上下文占用**、**激活/全部工具数**、**压缩**，以及连接状态。每一项都走 Pi 的接口，不是网页专属的替代品。
- **斜杠命令可用。** 在输入框敲 `/` 会列出扩展命令（`/webui …`）、技能命令、提示模板，以及本页实现的内置命令（`/compact`、`/name`、`/thinking`）。注册命令由 Pi 自己派发，绝不会作为普通文本发给模型；浏览器跑不了的内置命令会明确说明，而不是悄悄当消息发出去。
- 第一个打开该会话的标签页持有编辑租约；其他标签页保持可读，并明确标记为只读。
- Pi 空闲时输入框直接发送；Pi 工作时提供 **Queue next**（作为后续消息排队）与 **Steer**。

如果 Hub 没有运行，`/webui open` 会明确说明；会话会继续重试，Hub 一恢复页面就能打开，中途不需要重启任何会话。

## 安全模型

- **不提供鉴权是刻意设计。** 任何本地进程都可以通过 Hub 驱动已注册的会话，所以请把该端口视同于「能直接对着终端打字」。把它留在回环地址上。
- **Host 校验。** Hub 只回应 `127.0.0.1`、`localhost`、`::1`，以及配置文件里 `hub.allowedHosts` 列出的主机名；其他一律 `421`，这同时挡住了 DNS rebinding。
- **Origin 校验。** 会话级写操作必须携带会话自己的 Origin；Hub 只有在用自身 Host 核对通过后，才把该 Origin 放进隧道请求，因此来自其他 Origin 的页面（包括你浏览器里某个恶意网页）会被 `403` 拒绝。
- **通道只在本机、且 Host 必须被 Hub 接受。** 只有本机进程能建立通道，Host 不在允许列表里的升级请求会被拒绝；因此会话只能经 Hub 访问，靠猜端口是进不来的。
- **页面带有严格 CSP**，并用每次响应生成的 nonce；会话页保留它自己的 nonce 策略（没有 CDN、没有远程服务、不使用浏览器存储）。
- **远程访问由你自己加。** 用带鉴权的隧道或反向代理（Cloudflare Zero Trust、SSH 隧道、mTLS……）挡在 Hub 前面，并把它的主机名写进配置文件里的 `hub.allowedHosts`。pi-webui 不会自己长出一套鉴权。

## 配置

**没有任何 `pi-webui` 环境变量。** 一个文件同时是 Hub 服务和扩展的唯一事实来源：

```text
$PI_CODING_AGENT_DIR/pi-webui.json      # 未设置时是 ~/.pi/agent/pi-webui.json
```

```json
{
  "startOnSessionStart": false,
  "hub": {
    "port": 43118,
    "allowedHosts": ["pi.example.com"]
  }
}
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `hub.port` | `43118` | Hub 服务监听、扩展连接的端口 |
| `hub.allowedHosts` | 仅回环 | 额外回应的 `Host` 名字（隧道或反向代理） |
| `startOnSessionStart` | `false` | 每次会话初始化时自动发布会话 |

Hub 只绑 `127.0.0.1`，暴露出去是隧道的事，不是配置项。两个进程读同一个文件的同一套规则，所以改 `hub.port` 既不用改 systemd unit，也不需要 `daemon-reload`：写好文件，重启服务即可：

```bash
systemctl --user restart pi-webui-hub.service
```

正在运行的会话会自己跟过去：扩展在一次心跳失败后会重新读这个文件。`/webui status` 会打印生效端口、来源和文件路径；`/webui settings` 可以直接改端口。

调试时 Hub 另外接受 `--port <port>` 与 `--host <host>`，只对那一次运行生效。扩展永远读文件，所以临时的 `--port` 只适合配合 Hub 启动时打印的直连 URL 使用。

`startOnSessionStart` 会在每次会话初始化（启动、reload、new、resume、fork）时自动发布会话，而不必等 `/webui open`。JSON 格式错误，或 `hub` 的类型不对时，文件会被原样保留、忽略并给出警告；`/webui status` 会报告生效值与文件路径。扩展在写入前严格校验（识别到的字段非法会把菜单导向修复流程），Hub 则在日志里报告问题并以默认端口启动，而不是拒绝运行。


## 协议（给工具用）

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/_hub/hello` | `GET` | Hub 身份与协议版本 |
| `/_hub/sessions` | `GET` | 当前注册表（JSON） |
| `/_hub/events` | `GET` | 注册表快照的 SSE 流（`event: sessions`） |
| `/_hub/channel` | WebSocket | 扩展拨入的通道（协议 2） |
| `/?session=<sessionId>` | `GET` | 应用外壳；页面自己从 query string 取会话 id |
| `/app.{js,css}` | `GET` | UI bundle，Hub 只提供这一份，所有会话共用 |
| `/api/session/<sessionId>/**` | 任意 | 经通道转发给所属会话 |
| `/s/<sessionId>/…` | — | 旧链接：跳转到 `/?session=<sessionId>` |

通道同时承载 JSON 控制帧与二进制正文（请求与响应各一份），因此一条连接既能跑被转发的 SSE 流，也能传图片上传。三个值得知道的后果：

- **会话只是在连接期间被列出。** 没有心跳、没有注册：连上即出现，断开后在 30 秒宽限期内标为"重连中"（这样 Hub 重启不会把已打开的标签页变白），随后被遗忘。
- **Hub 重启会自行恢复**：扩展重拨回来即可，别的什么都不用改 —— 端口与通道地址来自同一个配置文件。
- **没有通道的会话会得到"正在重连"的页面**，而不是代理错误；它还会把请求排队几秒，等扩展回来。

## 界面

界面（配色、Markdown 规则、工具卡片、思考块、输入框）移植自
[`agegr/pi-web`](https://github.com/agegr/pi-web)（MIT）。共享的只是外观：数据仍来自本会话自己的扩展，
经 Hub 送达。

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

## 放在反向代理或隧道后面

页面的实时性靠 Server-Sent Events，而 Cloudflare 的边缘对它并不完全可靠：已知会缓冲 `text/event-stream`（事件延迟到达，或等到连接关闭才一次性到达），并且会把空闲约 100 秒的流切断。Hub 与前端都按「这些都不该让页面变旧」来设计：

- 空闲的流每 15 秒发一条 keep-alive 注释（索引流与会话流都是 15 秒），既保温也避开空闲切断；EventSource 在断开后 2 秒重连。
- Hub 每 3 秒推一次会话快照，哪怕没有任何变化，这样浏览器端才能区分「安静」和「死了」。
- 索引流静默 8 秒后，索引页会退化为每 3 秒轮询一次 `/_hub/sessions`，并在端口旁边显示 `polling`；事件恢复后自动回到 `live`。
- 会话页同理：流上 5 秒没有数据时，它改用普通请求拉一次完整快照，所以被缓冲的流不会让正在进行的回合看起来卡死。

如果隧道下面流式仍然不正常，按通常有效的顺序排查：

1. 用**命名隧道**，别用快速隧道（`trycloudflare.com`）：快速隧道对 `GET` 流是故意缓冲的。
2. 确认响应没有被压缩。页面本身已经发了 `Cache-Control: no-store` 和 `X-Accel-Buffering: no`，但如果你为该主机名开了 Brotli/压缩，需要加一条 Configuration Rule 关掉它。
3. 装在 **Cloudflare Access** 后面时，`CF_Authorization` cookie 必须能到达 `/_hub/events` 请求 —— 正常浏览器会话下没问题。如果你改用 service token 或纯 header 策略，页面能打开，但事件流会 403，此时只有轮询兜底在维持更新。
4. 如果长时间流式是硬需求，就把 TLS 终结在流式正常的地方（普通反向代理，或只把 Hub 走灰云主机名）。

## 需要知道的行为

- 终端对话记录里，来自浏览器的消息会显示内部信封 `<pi-webui-input nonce="…">`；Pi 会在落盘之前、且在模型看到之前把它替换成真实文本，浏览器页面里也始终显示真实文本。这个信封的作用是：让你从浏览器粘贴进去的内部标记不会被其他扩展误认为真的控制标记，所以它是有意为之，而不是没清理干净的技术债。
- Hub 索引是*已注册*会话的实时视图；退出的 Pi 会话会在过期窗口内自动消失。
- 一个 Hub 服务一台机器上该用户的会话，且只在该回环接口上。
- `pi-webui.json` 的写入与 `/webui init` 通过锁文件串行化；保存进行中时不要手动编辑该文件。

## 许可

MIT。上游：`narumiruna/pi-extensions`（已归档的 `pi-webui`）；本分支保留原有实现与测试，并新增了 Hub、固定端口路由与无鉴权模型。
