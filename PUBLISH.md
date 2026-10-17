# 发布 dsh-interaction-optimize

这个包是**无构建步骤**的纯 JS DSH bundle：`index.js`（Host 半边：提示音文件、workspace changes 缓存、文件打开/应用列表路由）、`client.js`（浏览器 UI：增删胶囊、完成提示、提示音、划词注释、文件右键菜单）、`cordis.patch.yml`、locale、icon。发布 = 推到 npm，再可选地上架市场。

当前准备状态（`npm pack --dry-run` 已通过）：

- 包名 `dsh-interaction-optimize`，版本 `2.0.0`，npm 上仍可用（未占用）
- 发布内容 9 个文件、约 35 kB：
  `index.js`、`client.js`、`cordis.patch.yml`、`locale/{en,zh}.json`、`icon.svg`、`README.md`、`LICENSE`、`package.json`
- 没有 `postinstall`、没有构建产物、没有第三方运行时依赖

## 0. 一次性准备

1. npm 账号：<https://www.npmjs.com/signup>，并开启 2FA。
2. **发布必须用官方源** `https://registry.npmjs.org/`；本机 `~/.npmrc` 默认指向 npmmirror（只读镜像），不能发布。
3. 建议给这个插件单独建一个 git 仓库，推一份到 GitHub：方便别人从仓库安装，也方便市场展示。
4. 包名想改也可以再换；改名需要同步 `package.json` 的 `name`、`cordis.patch.yml`、`client.js` 的 `NS`/路由/事件名，然后再装一次本地插件。

## 1. 发布前检查

```bash
cd dsh-plugins/dsh-interaction-optimize
node --check index.js && node --check client.js
npm pack --dry-run
```

`package.json` 里这几项是 DSH 识别 bundle 的关键，别删：

- `dsh.bundle.patch` → `./cordis.patch.yml`
- `dsh.client` → `platform: web`、`immediately`、`inject`
- `exports["./client"]` → `./client.js`

## 2. 发布到 npm

```bash
npm login --registry https://registry.npmjs.org/
cd dsh-plugins/dsh-interaction-optimize
npm publish --registry https://registry.npmjs.org/
```

- 每次发布前把 `version` 加一（npm 不允许覆盖已发布版本）。
- 若改成 scoped 名字（如 `@bean_paste/dsh-interaction-optimize`），加 `--access public`。
- 国内镜像不能发布：npmmirror 只代理读取。

验证：

```bash
npm view dsh-interaction-optimize version
```

## 3. 别人怎么安装

- **DSH 插件页**：Plugins → 安装/添加 → 输入包名 `dsh-interaction-optimize`。
- **GitHub**：市场与插件管理都支持从 GitHub 仓库安装；把仓库地址给用户即可。
- **本地开发**：`plugin_manager` 的 `install_bundle` 指向本地目录（当前 Profile 就是这么装的，`link:` 到本仓库目录）。

## 4. 上架 DSH 插件市场（可选）

市场目录来自精选列表 **awesome-dsh-plugin**，不是 npm 搜索：

1. Fork + PR：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
2. 在列表里加一条：插件名（交互优化 / dsh-interaction-optimize）、一句话描述、GitHub 仓库、npm 包名。
3. 站点与市场自动收录，通常一天内生效。

不要往 dshmarket 仓库提插件条目（其 README 明确说明）。

## 5. 兼容性声明（可选）

市场优先读 `engines.dsh` 或同版本线的 `@deepseek-ai/dsh-*` peer 依赖来判断「与当前宿主是否匹配」；不声明也会保持可见，只是筛选时不会标出明确兼容。

```json
"engines": { "dsh": ">=0.2.1-rc.2" }
```

当前验证用的 DSH 是 `0.2.1-rc.2`；插件用到的槽位/服务（`shell.overlay`、`conversation.input.dock`、`plugins.row.config`、`sessions`、`workspaceChanges`、`sidebarRight`、`sessionController.openWorkspacePath`）都在这个版本上实测过。

## 6. 版本与更新

- 功能改动 → `version` 递增（semver）。改名算不兼容，已升到 `2.0.0`。
- 发布后打 git tag（`v2.0.0`），写一句 release note；市场会显示版本说明。
- 用户在市场里点「更新」即可拉到新版本；从压缩包/GitHub 安装的条目只认自己的来源。

## 7. 从 codex-like 迁移

旧包名 `codex-like` 不再更新。本机 Profile 已把依赖与 bundle 行改成 `dsh-interaction-optimize`；自定义提示音从 `~/.dsh/codex-like/` 自动迁移到 `~/.dsh/dsh-interaction-optimize/`，设置（cookie `codex_like`）保持不变。

## 8. 安全与信任

Host 半边只用 Node 内置模块（`node:fs` / `node:path` / `node:os` / `node:child_process`），浏览器半边只用宿主提供的 `react` 与模块表；没有外部网络请求，没有遥测，发布内容与仓库源码一致，便于审查。
