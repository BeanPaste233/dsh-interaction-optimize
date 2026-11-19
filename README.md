# dsh-interaction-optimize

DeepSeek Harness Web UI 插件（原名 `codex-like`）：把 Codex 那种「本轮改动一目了然、结束有提醒、能直接批注」的交互带进 DSH。

1. **输入框上方的增删小方块**：显示本轮代码改动 `+新增` / `−删除` 以及改动文件数，回合运行中实时刷新（Host 在 `turn/start` 留 git 基线现算；回合结束后改用 DSH 的 `workspace/changes` 记录）。
2. **回合完成提示框**：屏幕右下角卡片，标题说明结局（完成 / 失败 / 达上限），正文带上**本次回复的一小段内容**。
3. **系统通知**：窗口不可见/最小化时才用系统通知；窗口可见（即使没聚焦）一律用应用内卡片。系统通知的外观由操作系统决定，插件无法自定义。
4. **提示音**：内置两声短促上行音，也可以上传自己的音频文件。
5. **划词注释**：选中对话里的文字加评论，发送时随消息带给模型，已发送消息里折叠成「N 条注释」胶囊。
6. **文件右键菜单**：右键消息里的文件链接，用默认应用打开、显示文件位置，或用其他已注册应用打开。
7. **Codex 深链**：消息里出现 `codex://threads/<id>` 时，模型可以调用 `codex_thread` 工具读取本机该线程的最近对话，再基于内容回答。
8. **Codex 链接提示**：在输入框里粘贴链接时，上方显示「线程名 + 工作目录」；对话里的链接会显示成蓝色。

## 配置

在 **插件页 → 交互优化 → 行「dsh-interaction-optimize」的配置按钮** 打开的配置页中调整：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| 输入框上方增删统计 | 开 | 输入框上方的 `+N` / `−M` / 文件数小方块，点击在右侧栏看 diff |
| 回合结束后停留时间 | 10 秒 | 胶囊在本轮结束后继续显示多久：3 / 5 / 10 / 30 / 60 秒，或「一直显示」保留到下一轮开始 |
| 划词注释 | 开 | 选中对话文字加评论、发送时随消息带给模型；关掉后不显示划词菜单、待发送胶囊与已发送折叠胶囊 |
| 文件右键菜单 | 开 | 对话里右键文件链接的菜单（打开 / 显示位置 / 其他应用） |
| 应用内提示框 | 开 | 右下角卡片（含回复摘录），旁边有「预览提示框」按钮 |
| 系统通知 | 仅窗口不可见时 | `关闭` / `仅窗口不可见时` / `每次完成都弹出`；需要点「启用系统通知」授权一次 |
| 显示时长 | 6 秒 | 3 / 5 / 6 / 8 / 12 / 20 / 30 秒，或「一直显示」 |
| 提示音 | 开 | 回合完成时播放，有「试听」按钮 |
| 自定义提示音 | 内置 | 选择「内置提示音」或「自定义音频」；「选择音频文件…」会立即上传并切换到自定义 |

- 支持 wav / mp3 / ogg / m4a / webm，单文件 ≤ 4 MB。
- 自定义音频保存在 **`<DSH_HOME>/dsh-interaction-optimize/sound.<ext>`**（旧目录 `codex-like` 会在首次加载时自动迁移），由 Host 半边通过 `GET /dsh-interaction-optimize/sound` 提供（带 Range 支持）。
- 播放失败（文件损坏、Host 路由不可用等）会自动回退到内置提示音。
- 配置本身（开关、音源、文件名、显示时长）保存在站点第一方 cookie（`codex_like`，沿用旧键以保留已有设置）并镜像到 `localStorage`。

## 增删统计

- 输入框上方**居中**显示一枚圆角胶囊：`N 个文件已更改 +A -D`（文件名数量、绿色新增、红色删除，千分位分隔）。
- 回合结束后按设置里的「停留时间」继续显示，到点自动隐藏；下一轮开始会重新出现。
- **悬停胶囊**弹出文件清单（每个文件的 `+A -D`，可滚动，最多 30 个；二进制/过大文件标注说明），清单里的文件也可直接点击。
- **点击胶囊**在**右侧栏**打开改动视图，自动选中第一个文件；点击清单里的某一行则直接定位到该文件：
  - **回合进行中**：打开插件注册的右侧栏标签「本轮改动」（上方文件清单、下方该文件的 unified diff，运行中带呼吸点、可刷新，回合结束后也可继续查看这一轮）；
  - **回合结束后**：仍走右侧栏的原生 `changes-review`「本轮改动」视图。
  - 若当前组合里没有右侧栏（极少见），自动退回插件内的浮层面板。
- 宽度与位置对齐输入框卡片（复用 DSH 的 composer 宽度变量与 dock 内边距），也可在配置页关掉整块统计。
- 数据源分两层：
  - **回合进行中（实时）**：DSH 只在「回合即将结束」时才记录 `workspace/changes`，所以插件自己在 `turn/start` 用 `git stash create`（不改变工作区、不动 stash 列表）留一份基线，之后直接对比工作区算增量；未跟踪的新文件按新增行统计。
  - **回合结束后**：Host 记录 `workspace/changes` 对应的 summary（`workspaceChanges.summary(sessionId, seq)`），优先于实时数据。
- Client 通过 `GET /dsh-interaction-optimize/changes?session=…` 刷新：回合运行中每 1.2 秒一次、空闲 5 秒兜底；另外订阅会话 `eventSource`，在 `tool/result` / `turn/start` / `turn/end` 后立即补拉一次，所以文件一改就能看到。
- 实时 diff 由 `GET /dsh-interaction-optimize/live-diff?session=…&path=…` 提供（单文件 ≤ 200 KB，超出截断）。
- 只统计文件改动（含二进制/超大文件的文件数，行数计 0）；没有改动时不显示。
- 实时模式依赖 git：**非 git 目录**下没有基线，胶囊仍在回合结束后按 DSH 记录显示。

## 划词注释（Codex 风格）

- 在对话区域选中文本 → 选区上方出现「添加到对话」。
  - 点击后弹出一个**胶囊输入框**（占位符「添加可选评论…」，右侧圆形 ✓）：**Enter 或 ✓ 保存 / Esc 或点外面取消**；评论可留空。
- 保存后：选区旁出现**蓝色数字徽标**（1、2…，点击展开注释列表），输入框上方出现左对齐的「N 条注释 ×」胶囊（× 一键清空）。
- **鼠标悬停**胶囊才展开明细：每条有「所选文本 / 用户评论」，右上角铅笔（编辑，重新打开胶囊输入框）与垃圾桶（删除）。
- 发送时（发送按钮或 Enter）把注释块追加进草稿后交给 DSH 原生发送，**不拦截、不二次提交**；发送后清空列表与数字徽标。
- 只有注释、草稿为空时也能发送：插件直接通过会话的 `prompt` 接口发送注释块，成功后清空草稿；失败则把注释块落到草稿里，再点一次发送即可。
- 草稿里已有文字时：插件先把注释块追加进草稿，再让原生发送继续。
- 已发送的消息里，注释块会被折叠成一个**「N 条注释」胶囊**（浮层优先显示在胶囊上方，在浮层内滚动不会关闭它）（按文本标记定位、用 DOM Range 删除整段，不依赖具体消息结构）（原始引用文字隐藏），点击胶囊展开引用与评论；模型仍然能看到完整注释内容（消息存储里保留）。多条注释之间用空行分隔，折叠后数量和明细都按条解析。
- 切换会话会清空待发送注释（注释属于写它的那段对话）。

> 原先安装的 `dsh-plugin-text-quote` 与本功能重复（会出现两套划词菜单、双重注入），已在 Profile 中停用；想换回它就在插件页重新启用。

## 文件右键菜单

- 在对话里**右键文件链接**（消息里的文件 chip 或 Markdown 文件链接）弹出菜单：
  - 「用默认应用打开」→ Host 原生打开（`sessionController.openWorkspacePath`，与内置「在应用中打开」同一机制）
  - 「显示文件位置」→ 同上，`action: 'reveal'`（Explorer `/select,` 选中该文件）
  - 「其他应用打开…」→ 从注册表 `OpenWithList` 列出该文件类型注册的应用（如 VS Code / Typora / Chrome），选中后以 `exe + 文件` 启动
- 路径取链接的 `title` / `href`，相对路径按当前会话的 `cwd` 解析成绝对路径后交给 Host；外链（http/mailto 等）不接管。
- 打开动作由本插件的 Host 路由 `/dsh-interaction-optimize/open`、`/dsh-interaction-optimize/apps` 执行；文件不存在或应用启动失败时返回明确错误。
- 配置页「文件右键菜单」可整体关闭，改完立即生效。

## 完成提示

- Host 监听**所有会话**的持久化 `turn/end`（后台会话也算），只在三种结局提醒：
  - `completed` → 「本轮执行完成」（绿色对勾）+ 本次回复开头一小段
  - `error` → 「本轮执行失败」（红色叉号）+ 错误信息
  - `max-tokens` → 「本轮输出已达上限」（黄色感叹号）+ 本次回复开头一小段
- `aborted`（手动停止）、`interrupted`、`blocked` 不提醒。
- 数据通道：Host 把每条完成的回合写进内存队列，Client 每秒拉取 `GET /dsh-interaction-optimize/completions?after=<id>`；因此切到别的会话、甚至页面上不是这条对话时也能收到提醒，点击卡片会跳回对应会话。
- 提示框按「显示时长」停留后消失；悬停暂停计时；可手动关闭；页面切到后台时不倒计时。
- **点击提示框**（或点击系统通知）会回到这条回合所在的对话：聚焦窗口、必要时切回该会话，并把对话滚到最新消息；预览提示框只关闭不跳转。
- 回复摘录：本轮最后一条 `assistant/message` 的 `type:'text'` 块，压缩空白后截取 160 字符；回合开始时清空。
- 系统通知与提示框共用同一个事件与同样的标题/正文；通知本身静音（声音统一由提示音负责），点击通知同样回到该对话并聚焦窗口。
- **系统通知的外观由 Windows/Electron 决定，插件改不了**；所以窗口可见（哪怕没聚焦）时不再弹系统通知，只显示应用内卡片。想彻底不要系统通知，把配置里的「系统通知」设为「关闭」。

### 与 dsh-pet 通知的关系

本 Profile 之前看到的「DSH 系统通知」实际来自 **dsh-pet**（`~/.dsh/dsh-pet/main-config.jsonc` 里的 `notificationsEnabled`），DSH 本体并不发完成通知。为了不重复弹两次，已把 `notificationsEnabled` 设为 `false`；dsh-pet 的「权限申请 / 用户选择」通知也会一并停掉，需要时把该值改回 `true` 即可恢复。

## Codex 深链

- 消息里出现 `codex://threads/<id>` 时，模型可以调用 `codex_thread` 工具读取**本机** Codex 的该线程：工作目录、创建时间，以及最近的用户/助手消息。
- 数据优先走 **Codex 官方 app-server**：启动 `codex app-server`，用 JSON-RPC `initialize` + `thread/read` 读取线程（标题、目录、创建时间、全部条目），只投影用户与助手正文，不包含 reasoning、工具调用与开发者上下文。
- app-server 不可用时回退到本机 rollout 文件 `~/.codex/sessions/…/rollout-<时间>-<id>.jsonl`（`.jsonl.zst` 自动解压），所以没装 Codex 桌面版但留有会话文件时仍可读。
- 单次最多 20 条消息（可传 `max_messages` 到 50）、8000 字符；超出会截断并标记 `truncated`。
- 本机找不到时（例如链接来自另一台设备）返回 `ok:false, reason:not-found`；模型会直接说明「本机没有这个线程」，不会声称能打开 Codex。
- 输入框里出现链接时，输入框上方会出现 chip：`Codex 线程 · <标题> · <工作目录>`，标题来自 Codex 本地目录库 `~/.codex/sqlite/codex.db` 的 `local_thread_catalog.display_title`（读不到时回退到该线程第一条用户消息）；本机没有的线程显示「本机没有这个线程」。
- 对话里的链接会被染成蓝色（`--dsw-alias-link`），但不可点击；不注册 `codex://` 协议，也不会打开 Codex。

## 实现要点

| 部分 | 说明 |
| --- | --- |
| 增删小方块 | 注册到 `conversation.input.dock`（输入框上方通栏），`id` 为 `dsh-interaction-optimize-diff`，session 作用域拿到 `sessionId` 与 `useSessionStatus`。 |
| 点击胶囊 | 实时（回合进行中）：`ctx.get('sidebarRight').openTab('dsh-interaction-optimize-live')`，该标签类型注册在 `ctx.sidebarRightTabs`、正文注册在 `sidebar.right.pane.tab`（key 为 `dsh-interaction-optimize/live-changes`）；没有右侧栏时退回内联 `LiveDiffPanel`。回合结束后：`openResource('dsh-resource://changes-review/session/<session>/<seq>/<turn>')`。 |
| 数据来源 | Host 监听 `session/event`：`turn/start` 时留 git 基线（`git stash create` → 回退 HEAD，另记未跟踪文件集），`workspace/changes` 时缓存 `ctx.get('workspaceChanges').summary()`；实时 summary 用 `git diff --numstat -z` 现算并缓存 450 ms。 |
| Codex 深链 | `ctx.tools.register()` 注册 `codex_thread`（工具定义手写 JSON Schema，不导入官方包）；`ctx.systemPrompt.section()` 注册策略段，提示模型看到链接先读线程。 |
| 线程读取 | 官方协议：发现 `codex.exe`（WindowsApps 执行别名 / PATH / `Get-AppxPackage`）后，`spawn` 一个 `codex app-server`，串行发送 `initialize` 与 `thread/read`（20 秒超时），读取后立即结束进程。 |
| 离线回退 | app-server 不可用时，由 UUIDv7 前缀推出日期目录定位 rollout 文件，必要时递归扫描；`.jsonl.zst` 用 `zlib.zstdDecompressSync` 解压，解析 `session_meta` 与 `response_item:message`。 |
| 链接提示 | `GET /codex-info?id=…` 返回标题/目录/创建时间（`local_thread_catalog` 优先，rollout 兜底）；`CodexLinkDock` 读草稿里的首个链接并展示 chip，`installCodexLinkStyler` 用 DOM 遍历把消息里的链接染蓝。 |
| 访问控制 | 每个路由先调用 `ctx.get('connection').requestRejection(req)`，Host/Origin 不符或无有效浏览器会话时直接返回 401/403，和 DSH 自身路由一致。 |
| Host 路由 | `/dsh-interaction-optimize` 前缀：`GET/PUT/DELETE /sound`、`GET /changes?session=…`、`GET /live-diff?session=…&path=…`、`POST /open`、`GET /apps?path=…`。 |
| 文件打开 | Host 优先走 `sessionController.openWorkspacePath`（原生、可显示窗口）；应用列表走注册表 `OpenWithList` + `App Paths`。拒绝 UNC/设备路径；默认打开拒绝可执行/脚本扩展名；`application` 只允许系统为该扩展名登记过的应用。 |
| 完成提示 | `shell.overlay` 槽位，`position: fixed; right: 20px; bottom: 20px`，浮层点击穿透。 |
| 系统通知 | 页面内 `new Notification(...)`（`silent: true`，点击聚焦窗口）；权限从配置页请求。 |
| 提示音 | 内置音用 Web Audio 合成；自定义音用 `new Audio('/dsh-interaction-optimize/sound?v=…')`。 |
| 当前会话 | 根级标准 Hook `useSessions` 找到 `retainedBy.mainView > 0` 的会话。 |
| 完成信号 | Host 记录所有会话的 `turn/end`（含回复摘录）到内存队列，Client 每秒用游标拉取 `GET /completions?after=…`，因此切走会话也能提醒。 |
| 配置界面 | 注册到 `plugins.row.config`，键位 `dsh-interaction-optimize#dsh-interaction-optimize`。 |
| 配色 | 全部使用 DSH 主题令牌（`--dsw-alias-*`、`--dsw-specific-input-major`、`--dsw-menu-surface-fill`、`--dsw-shadow-lv*`），深浅色模式随宿主自动切换，无写死颜色。 |
| 文案 | `ctx.locale` 命名空间 `dsh-interaction-optimize`，中英双字典。 |

## 目录

```
dsh-interaction-optimize/
├── package.json        # dsh.bundle.patch + dsh.client(web) 声明
├── cordis.patch.yml    # 插入 Host 行 dsh-interaction-optimize
├── index.js            # Host 半边：提示音存取、workspace changes 缓存、文件打开/应用列表路由
├── client.js           # 浏览器半边：增删小方块 + 完成提示 + 提示音 + 划词注释 + 文件右键菜单 + 配置页
├── locale/en.json      # 插件管理页显示用元数据（英文）
├── locale/zh.json      # 插件管理页显示用元数据（中文）
└── icon.svg            # 原创图标
```

## 安装

本地目录 bundle，通过 Plugin Manager 安装（`plugin_manager` 的 `install_bundle`，target 指向本目录绝对路径）。
安装后 Profile 链接该目录；**Host 半边改动需要一次 Profile 重组或重启 DSH 才生效**（插件管理页关/开一次即可），浏览器半边刷新页面即可加载。

## 已知限制

- 增删统计只覆盖 Host 记录到的文件改动；没有 git 基线时按文件工具的实际写入计数。
- 系统级通知沿用 DSH 自己的行为。
- 自定义音频最多 4 MB；浏览器后台播放音量可能被系统/浏览器压低。
- 兜底通道无法区分「完成」与「手动停止」，正常路径（事件源可用）下不会用到它。
- 「其他应用」列表来自系统登记的 OpenWithList；没有登记过的应用不会出现（可用系统「打开方式」自行登记）。
- 可执行与脚本类文件（`.exe`、`.bat`、`.ps1`、`.lnk`、`.scf` 等）不会被「用默认应用打开」直接运行；需要时请选「其他应用打开…」。
- 所有 Host 路由都要求 DSH 的 Host/Origin 校验与有效浏览器会话；跨站页面无法调用。
