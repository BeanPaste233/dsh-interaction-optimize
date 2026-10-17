# dsh-interaction-optimize

DeepSeek Harness Web UI 插件（原名 `codex-like`）：把 Codex 那种「本轮改动一目了然、结束有提醒、能直接批注」的交互带进 DSH。

1. **输入框上方的增删小方块**：显示本轮代码改动 `+新增` / `−删除` 以及改动文件数，回合运行中实时刷新（数据来自 Host 的 `workspace/changes` 记录）。
2. **回合完成提示框**：屏幕右下角卡片，标题说明结局（完成 / 失败 / 达上限），正文带上**本次回复的一小段内容**。
3. **系统通知**：窗口不可见/最小化时才用系统通知；窗口可见（即使没聚焦）一律用应用内卡片。系统通知的外观由操作系统决定，插件无法自定义。
4. **提示音**：内置两声短促上行音，也可以上传自己的音频文件。
5. **划词注释**：选中对话里的文字加评论，发送时随消息带给模型，已发送消息里折叠成「N 条注释」胶囊。
6. **文件右键菜单**：右键消息里的文件链接，用默认应用打开、显示文件位置，或用其他已注册应用打开。

## 配置

在 **插件页 → 交互优化 → 行「dsh-interaction-optimize」的配置按钮** 打开的配置页中调整：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| 输入框上方增删统计 | 开 | 输入框上方的 `+N` / `−M` / 文件数小方块 |
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
- **悬停胶囊**弹出文件清单（每个文件的 `+A -D`，可滚动，最多 30 个；二进制/过大文件标注说明），清单里的文件也可直接点击。
- **点击胶囊**打开右侧栏的「本轮改动」审批视图（与回合结束卡片同一个 `changes-review` 面板，自动选中第一个文件）；点击清单里的某一行则直接定位到该文件的 diff。
- 宽度与位置对齐输入框卡片（复用 DSH 的 composer 宽度变量与 dock 内边距），也可在配置页关掉整块统计。
- 数据源：Host 记录每条 `workspace/changes` 事件对应的 summary（`workspaceChanges.summary(sessionId, seq)`），Client 通过 `GET /dsh-interaction-optimize/changes?session=…` 轮询：
  - 回合运行中每 1.2 秒刷新一次；空闲时每 5 秒兜底刷新，保证回合刚结束才落盘的记录也能显示；
  - 新回合开始（Host 收到 `turn/start`）时清空上一条，避免显示上一轮的统计。
- 只统计文件改动（含二进制/超大文件的文件数，行数计 0）；没有改动时不显示。

## 划词注释（Codex 风格）

- 在对话区域选中文本 → 选区上方出现「添加到对话」。
  - 点击后弹出一个**胶囊输入框**（占位符「添加可选评论…」，右侧圆形 ✓）：**Enter 或 ✓ 保存 / Esc 或点外面取消**；评论可留空。
- 保存后：选区旁出现**蓝色数字徽标**（1、2…，点击展开注释列表），输入框上方出现左对齐的「N 条注释 ×」胶囊（× 一键清空）。
- **鼠标悬停**胶囊才展开明细：每条有「所选文本 / 用户评论」，右上角铅笔（编辑，重新打开胶囊输入框）与垃圾桶（删除）。
- 发送时（发送按钮或 Enter）把注释块追加进草稿后交给 DSH 原生发送，**不拦截、不二次提交**；发送后清空列表与数字徽标。
- 只有注释、草稿为空时也能发送：插件直接通过会话的 `prompt` 接口发送注释块，成功后清空草稿；失败则把注释块落到草稿里，再点一次发送即可。
- 草稿里已有文字时：插件先把注释块追加进草稿，再让原生发送继续。
- 已发送的消息里，注释块会被折叠成一个**「N 条注释」胶囊**（原始引用文字隐藏），点击胶囊展开引用与评论；模型仍然能看到完整注释内容（消息存储里保留）。多条注释之间用空行分隔，折叠后数量和明细都按条解析。
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

- 听当前主视图会话的持久化 `turn/end` 事件，只在三种结局提醒：
  - `completed` → 「本轮执行完成」（绿色对勾）+ 本次回复开头一小段
  - `error` → 「本轮执行失败」（红色叉号）+ 错误信息
  - `max-tokens` → 「本轮输出已达上限」（黄色感叹号）+ 本次回复开头一小段
- `aborted`（手动停止）、`interrupted`、`blocked` 不提醒。
- 兜底通道：拿不到事件源时用会话状态 `running` 由真变假提醒「本轮执行完成」。
- 提示框按「显示时长」停留后消失；悬停暂停计时；可手动关闭；页面切到后台时不倒计时。
- 回复摘录：本轮最后一条 `assistant/message` 的 `type:'text'` 块，压缩空白后截取 160 字符；回合开始时清空。
- 系统通知与提示框共用同一个事件与同样的标题/正文；通知本身静音（声音统一由提示音负责），点击通知会聚焦窗口。
- **系统通知的外观由 Windows/Electron 决定，插件改不了**；所以窗口可见（哪怕没聚焦）时不再弹系统通知，只显示应用内卡片。想彻底不要系统通知，把配置里的「系统通知」设为「关闭」。

### 与 dsh-pet 通知的关系

本 Profile 之前看到的「DSH 系统通知」实际来自 **dsh-pet**（`~/.dsh/dsh-pet/main-config.jsonc` 里的 `notificationsEnabled`），DSH 本体并不发完成通知。为了不重复弹两次，已把 `notificationsEnabled` 设为 `false`；dsh-pet 的「权限申请 / 用户选择」通知也会一并停掉，需要时把该值改回 `true` 即可恢复。

## 实现要点

| 部分 | 说明 |
| --- | --- |
| 增删小方块 | 注册到 `conversation.input.dock`（输入框上方通栏），`id` 为 `dsh-interaction-optimize-diff`，session 作用域拿到 `sessionId` 与 `useSessionStatus`。 |
| 点击胶囊 | `ctx.get('sidebarRight').openResource('dsh-resource://changes-review/session/<session>/<seq>/<turn>', { params: { index: 0 } })`。 |
| 数据来源 | Host 监听 `session/event` 的 `workspace/changes`，调用 `ctx.get('workspaceChanges').summary()` 缓存；`turn/start` 清空。 |
| Host 路由 | `/dsh-interaction-optimize` 前缀：`GET/PUT/DELETE /sound`、`GET /changes?session=…`、`POST /open`、`GET /apps?path=…`。 |
| 文件打开 | Host 优先走 `sessionController.openWorkspacePath`（原生、可显示窗口）；应用列表走注册表 `OpenWithList` + `App Paths`。 |
| 完成提示 | `shell.overlay` 槽位，`position: fixed; right: 20px; bottom: 20px`，浮层点击穿透。 |
| 系统通知 | 页面内 `new Notification(...)`（`silent: true`，点击聚焦窗口）；权限从配置页请求。 |
| 提示音 | 内置音用 Web Audio 合成；自定义音用 `new Audio('/dsh-interaction-optimize/sound?v=…')`。 |
| 当前会话 | 根级标准 Hook `useSessions` 找到 `retainedBy.mainView > 0` 的会话。 |
| 精确信号 | `ctx.get('sessions').binding(sessionId).eventSource` 的 `append` 变更里读取 `turn/end` 与 `assistant/message`。 |
| 配置界面 | 注册到 `plugins.row.config`，键位 `dsh-interaction-optimize#dsh-interaction-optimize`。 |
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
- 只提醒「主视图当前打开的会话」；后台会话完成时不提醒。
- 系统级通知沿用 DSH 自己的行为。
- 自定义音频最多 4 MB；浏览器后台播放音量可能被系统/浏览器压低。
- 兜底通道无法区分「完成」与「手动停止」，正常路径（事件源可用）下不会用到它。
- 「其他应用」列表来自系统登记的 OpenWithList；没有登记过的应用不会出现（可用系统「打开方式」自行登记）。
