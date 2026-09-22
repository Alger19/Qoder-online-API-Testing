# 本地 Agent 对话（Qoder Cloud Agents）

一个跑在本机的网页 demo：打开页面 → **自己填入个人访问令牌（PAT）** → 直接在网页上
**创建 Agent 和运行环境** → 开始对话。

整个流程对应用户文档里的 5 步：

| 文档里的步骤 | 在哪里发生 |
|---|---|
| step 1 配置 API（创建 Agent） | 页面上的「配置 → Agent」表单 |
| step 2 配置运行环境 | 页面上的「配置 → 运行环境」表单 |
| step 3 创建 session | 服务端，每轮对话自动处理 |
| step 4 发送消息 | 聊天输入框 |
| step 5 获取响应（SSE 流） | 服务端转成 5 个小事件推给页面 |

不依赖任何第三方库，只用 Node 标准库 + 一个静态 HTML。

```bash
cd qoder-chat
node server.js
# 打开 http://127.0.0.1:8787/
```

也可以直接双击 `public/index.html`（此时页面会去找 `127.0.0.1:8787` 上的本地服务）。

## 启动服务（重要）

页面是**纯静态 HTML**，它自己不会开服务 —— 必须先有人跑着 `server.js`，
页面才能连上 `127.0.0.1:8787`。**服务没跑的时候，页面就会提示「连不上本地服务」，
这不是 bug，是它没东西可连。**（跟 Node 版本无关，v22 / v25 都能跑。）

三种起法，按需要挑：

| 方式 | 怎么做 | 特点 |
|---|---|---|
| **常驻（推荐）** | 双击 `install-service.command` | 装成 macOS 后台服务，**开机自启、崩溃自动拉起**，以后打开页面直接用。取消：双击 `uninstall-service.command` |
| 双击启动 | 双击 `start.command` | 起服务 + 自动开浏览器。**那个终端窗口要留着**，关掉窗口服务就停 |
| 手动 | 终端里 `node server.js`（或 `npm start`） | 最原始，Ctrl+C 停止 |

装过常驻服务之后，`start.command` 会检测到服务已经在跑，只帮你打开页面，不会重复启动。

日志：常驻模式下写在 `logs/service.log`（错误在 `logs/service.error.log`）。

## 怎么用

1. 在 [Qoder 控制台](https://qoder.cn) 进入 **设置 → 个人访问令牌**，创建一个 PAT（以 `pt-` 开头）。
2. 打开页面，把 PAT 粘进输入框。
3. 选对 **服务区域**（中国站 / 国际站）——令牌和区域是绑定的，选错会被判为无效。
4. 点「连接」。

连接之后分两种情况：

- **账号里已经有 Agent 和运行环境** —— 顶部出现两个下拉框，默认选第一个，直接聊。
- **账号是空的** —— 配置面板会自动弹出来，告诉你缺什么。填好表单创建即可，
  不用再跳到控制台。创建的资源会自动被选为当前使用的那个。

之后随时可以点顶部的「配置」回去增删 Agent / 运行环境。

### 给 Agent 传文件（附件）

输入框右边的**「附件」**按钮，或者直接把文件**拖进对话区**。

| 文件类型 | 怎么给 Agent |
|---|---|
| 图片（PNG / JPEG / WEBP / GIF） | 上传到你的账号，消息里以 `image` 块引用 —— Agent 真的「看」得到这张图 |
| 文本文件（txt / md / csv / json / 代码 / 配置…） | 读出正文，作为文本一起发过去 |
| 其它（PDF / docx / zip / 音视频…） | **发不了**。上游的消息内容只接受 `text` 和 `image` 两种块，没有别的引用机制 |

上限：单文件 20 MB、文本 2 MB、一次最多 5 个。选完后输入框上方会出现附件条，
可以单独移除，也会标明是「图片」还是「正文」。附件列表只存在于页面内存里，刷新即清空。

### Agent 生成的文件：自动保存到 `downloads/`

Agent 在运行环境里产出的文件，**那一轮回答结束的瞬间就自动写到项目的 `downloads/` 子目录**，
不用你点任何东西。页面上的文件卡片会告诉你落到了哪（例如 `downloads/summary.md`），
想再要一份也可以点「下载」。

前提是 Agent 启用了 **`DeliverArtifacts`** 工具 —— 这是 Qoder 用来「交付产物」的工具，
只有经它交付的文件才会进入文件列表（`metadata.source = DeliverArtifacts`）。
在「配置 → Agent」的表单里勾上它。

几个实现上的点：

- **不会重复保存。** `downloads/.saved.json` 记着已经写过的文件 id，同一个文件在后续
  轮次里再出现也不会又存一份。同名文件会自动加序号（`report-2.md`），不覆盖。
- **文件名不能逃出目录。** 路径分隔符会被替换掉，落点固定落在 `downloads/` 里。
- **上游给的是签名临时链接**（对象存储，约 1 小时过期），而那个存储域名**不发 CORS 头**，
  浏览器没法直接下。所以由本机服务取签名链接、拿到内容再转发（页面点「下载」时走的是
  同一个代理，响应带上 `Content-Disposition: attachment` 强制「另存为」）。
- 文件按 `scope.id` 归属于产生它的那个会话，服务端据此只处理**本轮**的文件。
- 保存目录可以用环境变量 `DOWNLOAD_DIR` 改（测试套件就是靠它写到临时目录的）。

### 创建 Agent 表单

| 字段 | 说明 |
|---|---|
| 名称 | 必填 |
| 描述 | 可选 |
| 系统提示词 | 留空就用文档里的默认提示词 |
| 模型 | 来自真实的模型清单接口，显示倍率与是否免费 |
| 推理档位 | 只有该模型支持时才出现（`low` / `medium` / `high` / `xhigh` / `max`） |
| 上下文窗口 | 只有该模型支持的档位（200k / 400k / 1000k） |
| 启用的工具 | 文档里那 11 个工具，默认全选 |

「按文档默认值填入」会一键填成文档 step 1 的原始配置。

### 创建运行环境表单

名称 + 网络策略（`不受限` / `受限` / `仅允许指定主机`）。选「仅允许指定主机」时
会出现主机输入框，每行一个。

## 令牌是怎么处理的

这是整个设计的重点：**令牌永远不进浏览器页面**。

```
浏览器页面                     本机服务 (127.0.0.1:8787)              Qoder API
─────────────                  ────────────────────────              ─────────
输入 PAT  ───────────────────▶  持有令牌，只在内存里
                                (勾选「记住」才写入 .token，权限 0600)
   ◀──────────────  只回掩码 pt-HT6…f1f5
发消息    ───────────────────▶  用令牌去调上游 ──────────────────▶
   ◀─────  ready/note/delta/error/done  ◀──────────────────────────
```

具体做法：

- 页面里没有令牌、没有 session id、没有上游地址。所有请求都走一个统一的路径构造函数，
  只认 `/api/ask`（对话）和 `/api/health`、`/api/catalog`、`/api/connect`、`/api/disconnect`、
  `/api/select`、`/api/reset`、`/api/agents`、`/api/environments`、`/api/environments/archive`、
  `/api/files`、`/api/files/download`、`/api/upload`。
- 上游的事件格式挺杂（`session.status_running`、`span.model_request_end`、
  `agent.message`、`: heartbeat` …），全部由服务端翻译成五个事件
  （`ready` / `note` / `delta` / `error` / `done`）。上游改版只需要改服务端。
- 上游对**同一次**状态跃迁会同时发 `session.status_running` 和
  `session.thread_status_running`，两条都映射到同一句提示，所以服务端会把
  连续的重复 `note` 折叠掉，避免状态栏闪两下同一个字。
- 令牌默认只存在内存里，**服务重启即失效**。勾选「记住这台机器」才会写入 `.token`
  （已加进 `.gitignore`，权限 `0600`），点「断开」会把它删掉。
- 服务只监听 `127.0.0.1`，并且校验 `Origin`：只接受本机页面（含直接打开文件时的 `null`），
  其他来源一律 `403`。这样别的网站没法借你的额度。
- 页面不写 `localStorage`；`sessionStorage` 里只放一个随机的会话编号，用来区分标签页。

## 目录结构

```
qoder-chat/
├── server.js                 # 本机服务：持有令牌、翻译上游协议、管理会话与资源
├── public/index.html         # 前端页面：令牌输入 + 配置面板 + 对话界面（单文件，无依赖）
├── start.command             # 双击启动（起服务 + 自动开浏览器）
├── install-service.command   # 双击装成开机自启的常驻服务
├── uninstall-service.command # 双击卸载常驻服务
├── package.json              # 只有一个 npm start，方便终端启动
├── downloads/                # Agent 交付的文件自动落到这里（含 .saved.json 去重记录）
├── .env                      # 端口 / 超时等配置（不含令牌，令牌由页面输入）
├── .gitignore
└── test/
    ├── mock-upstream.js      # 假的 Qoder API，用来确定性地测各种分支
    ├── run-tests.js          # 150 项：协议、创建/删除/归档、文件上传/回传/落盘、鉴权、超时、安全边界
    ├── verify-ui.js          # 131 项：真实浏览器 + file:// 打开，真点按钮（含真点下载、真选附件）
    └── verify-real.js        # 打真实上游的完整流程（需要你自己的令牌，用完自动清理）
```

## 配置

改 `.env`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 本机监听端口 |
| `TURN_TIMEOUT_MS` | `120000` | 单轮最长静默时间。超过就放弃这一轮并说明原因 |
| `QODER_PAT` | 空 | **留空**——留空时页面会要求你输入。填了就会跳过输入 |
| `QODER_API_BASE_OVERRIDE` | 空 | 仅测试用，强制指向别的上游，会覆盖区域选择 |

> 注意：上游文档里的 `QODER_API_BASE_URL` 在这里**故意不生效**——区域由页面下拉框决定，
> 如果也认这个变量，区域选择就会被静默覆盖。

`TURN_TIMEOUT_MS` 会通过 `/api/health` 告诉页面，页面自己的超时总是比它多 20 秒。
所以你调大它，页面会跟着放宽，不会出现「服务还在等、页面先掐断」。

## 测试

```bash
node test/run-tests.js      # 协议层（对着 mock 上游，不需要真实令牌）
node test/verify-ui.js      # 真实 Chromium，从 file:// 打开页面
                            # 需要 playwright：见下方 NODE_PATH
QODER_PAT=pt-… node test/verify-real.js    # 打真实上游，跑完自动删掉自己创建的东西
```

`verify-ui.js` 依赖 Playwright 提供的 Chromium，运行示例：

```bash
NODE_PATH=/Users/algerzhao/.workbuddy/binaries/node/workspace/node_modules node test/verify-ui.js
```

`verify-real.js` 会**在你的账号里真的创建**一个 Agent 和一个运行环境（名字带时间戳，
描述里写明是验证用的），跑完再删掉，并复查账号是否恢复原样。想留着就加 `KEEP=1`。

覆盖到的分支：空账号引导、创建成功、上游校验错误透传、删除、归档（被会话占用时）、
切换资源、上游静默超时、上游过载重试、令牌被拒 / 区域选错、409 会话占用、
本地服务没启动、外域来源、非法请求体、**Agent 产出文件的自动回传与下载**
（含「点了下载页面不能被导航走」这条，因为跨源 `<a download>` 是不生效的，
一旦服务端漏掉 `Content-Disposition`，点击就会把页面顶掉）。

## 已知情况

- **上游有时会排队。** 模型繁忙时上游会一直回 `session.error` + `retrying`
  （错误码 `10605`），一轮可能要等几十秒甚至几分钟才出结果。这时页面会显示
  「模型繁忙，正在重试」，等不到就按超时处理并说明原因。等一会儿再发即可。
- 一轮回答目前是**整段返回**的（上游发一条完整的 `agent.message`，不是逐字流）。
  服务端已经同时支持 `*_delta` 增量事件，如果上游以后改成流式，前端不用动。
- **模型清单接口不在文档里。** 文档没写 `/api/v1/cloud/models`，但上游确实提供，
  创建 Agent 的下拉框就靠它——否则只能让用户手猜模型 id。上游若哪天去掉它，
  「模型」下拉会退化为空，需要改回手工填写。
- **工具清单是写死的。** 上游没有枚举工具集的接口（`/tools`、`/toolsets` 都是 404），
  所以 `server.js` 里的 `TOOLSET_TOOLS` 是文档 step 1 那份列表。上游加工具要手动同步。
- **文件接口也不在文档里。** `/api/v1/cloud/files`（列表）、
  `/api/v1/cloud/files/<id>/content`（返回签名 URL）、以及**同一路径的 `POST`**
  （上传，`multipart/form-data`，字段名就叫 `file`）都没有写进 API 指南，是探测出来的。
  文件能出现的前提是 Agent 带 `DeliverArtifacts` 工具。
- **消息内容只支持 `text` 和 `image` 两种块。** 这是上游自己报的：
  `content[0].type "file" is not supported. Allowed: text, image.`
  而 `image` 块的 `source` 有两种形态 —— `{type:"file", file_id:"…"}` 和
  `{type:"base64", media_type:"image/png", data:"…"}`，且**只认 PNG/JPEG/WEBP/GIF**
  （原文：`Only PNG/JPEG/WEBP/GIF are allowed in image blocks.`）。
  所以**非图片文件没有任何引用机制**，只能把正文内联进 `text` 块 —— 这也是 PDF、
  docx、压缩包发不出去的根本原因，不是没做，是上游不支持。
- **文件列表的过滤参数一律无效。** `session_id`、`scope`、`scope_id`、`order`、
  `starting_after` 全试过，返回内容和不带参数时**一模一样**。所以「只显示本轮会话的
  文件」是在服务端按 `scope.id` 自己过滤的，不是上游给的。等文件攒多了要注意：
  现在**只取第一页**（响应里有 `has_more` / `next_page`，但我们没有翻页）。
- **文件是账号级的。** 列表返回该账号下的所有文件，不按 Agent 或运行环境区分，
  只能靠 `scope.id` 归属到某个会话。
- **运行环境可能删不掉，只能归档。** 只要还有任意一个对话 session 引用着它，上游就会
  返回 409 并建议归档，原文是
  `Environment 'env_…' is in use and cannot be deleted: 1 session still reference it. Archive the environment instead.`
  页面不会假装成功，而是把原因和会话数摆出来，并给一个「改为归档」按钮
  （`POST /api/environments/archive`）。归档后它不再出现在列表里，记录仍保留。
- **会话会一直累积。** 每次对话都会在上游新建一个 session（上游目前不自动清理）。
  这也是上面那个 409 的由来——你刚聊过的环境，立刻是删不掉的。
- **卡住的会话连自己也删不掉。** 上游过载时中断的那一轮，session 会停在
  `rescheduling`，此时删它会回 `Version or state conflict.`（409），连带它引用的环境
  也删不掉。等上游恢复后它才会落定。`verify-real.js` 的清理逻辑会重试三次，
  实在不行就退回归档，并把情况原样打印出来。
- 「删除」是**真的**删掉你账号里的资源，不能撤销。页面会先弹确认框。
