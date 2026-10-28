# dsh-hotkey-enhance

> npm: **`@brantshi1/dsh-hotkey-enhance`**
[English](README.en.md) | 中文

DSH Desktop 的键盘增强插件：Codex 式的会话切换手感 + 一套 DSH 2.0.18 从未生效过的桌面键位。

> **仅适配 DSH Desktop。** 本插件绑定的每一个组合（`Ctrl+Tab`、`⌘N`、`⌘W`、`⌘D`、`⌘B`、`⌘,`）在真实浏览器里
> 都归浏览器所有——`Ctrl+Tab` 切标签页、`⌘N` 开新窗口、`⌘W` 关标签页、`⌘D` 加书签。因此插件在非 Electron
> 环境里**主动不安装任何监听器**，加载即惰性返回；在浏览器里使用不会有任何效果，也不会抢键。

## 为什么做这个

从 Codex 迁到 DSH 之后，最不习惯的是**切换会话的手感**：Codex 里按住 `Ctrl` 连点 `Tab`，会浮出最近会话列表，
松手才真正切过去；DSH 里没有这个能力，而且 Desktop 2.0.18 的 `desktop:*` 键位表整套失效（详见下节），
连 `⌘N` 都按不出来。这个插件就是补这两件事。

## 为什么绕过 DSH 的快捷键注册表

DSH Desktop 2.0.18 的客户端跑在 **`web` runtime**：

- `dsh-client-shortcuts` 的 `detectEnvironment()` 读 `document.documentElement.dataset.platform`，
  但**整个安装包里没有任何代码给这个属性赋值**（preload 只暴露了 `protocolVersion`，没有
  `dshDesktop.keyboard` 桥）。
- 于是所有命令的 `desktop:*` 默认键位全部失效，实际生效的是 `web:*` 那套
  （新会话 `Cmd+Alt+N`、搜会话 `Cmd+Alt+K`、加工作区 `Cmd+Alt+O`、侧栏 `Cmd+Alt+B`）。
- 更关键的是 `isWebBindingAllowed()`：web runtime 下注册表**主动拒绝**浏览器保留组合，只放行
  三个及以上修饰键、`Cmd+Alt+X` / `Cmd+Shift+X`、以及 `Cmd+,` `Cmd+\` `Ctrl+\`` `Cmd+/` 等少数键。
  `Cmd+N`、`Cmd+W`、`Cmd+D`、`Ctrl+Tab` **全部在白名单外**，注册时会抛
  `Unsupported Web shortcut: <id>`。

因此本插件不向注册表注册命令，而是直接在 `window` 捕获阶段监听 `keydown`——这也是社区插件
（`dsh-custom-hotkeys`、`dsh-file-finder`）面对同一限制时的做法。

副作用：这六条键**不会出现在 设置 → 通用 → 快捷键** 里（那是注册表的目录）。改键改由本插件自己的
卡片负责：**设置 → 通用 → 会话快捷键**。

## 提供什么

| 按键 | 动作 |
|---|---|
| `Cmd/Ctrl+N` | 新建会话 |
| `Cmd/Ctrl+W` | 关闭当前会话，回会话列表 |
| `Cmd/Ctrl+Shift+W` | 同上（macOS 原生菜单的 File → Close Window 也绑了 `Cmd+W`，这个键是备用） |
| `Cmd/Ctrl+D` | 置顶 / 取消置顶当前会话 |
| `Ctrl+Tab` | 打开最近会话浮窗；按住连按移动高亮，**松开才切换** |
| `Ctrl+Shift+Tab` | 同上，反向（从最旧的一项开始） |
| `Cmd+B` | 收起／展开左侧栏 |
| `Cmd+,` | 打开设置 |

八条全部可在 **设置 → 通用 → 会话快捷键** 里录制改键。

## 浮窗切换器（Ctrl+Tab）

按下 `Ctrl+Tab` 会弹出最近会话列表，而不是立刻切换：

```
┌────────────────────────────────┐
│ 最近会话                        │
│   当前会话            当前  1m  │   ← 真实当前会话，带「当前」徽标
│ ▸ 两分钟前                    2m │   ← 高亮行，从「下一个」开始
│   一小时前的会话              1h │
│                                │
│ 松开 ⌃ 切换 · Tab 继续选 · Esc   │
└────────────────────────────────┘
```

| 动作 | 结果 |
|---|---|
| `Ctrl+Tab` | 打开浮窗，高亮落在「下一个」会话 |
| **松开 `Tab`（Ctrl 仍按住）** | **浮窗保留**，不切换——`Tab` 是可以反复点的「下一项」按钮 |
| 再点 `Tab` | 高亮下移一格，到底回卷 |
| 按住 `Tab` | 自动重复，逐行走 |
| **松开 `Ctrl`** | **提交**：切到高亮行并关闭浮窗 |
| `Esc` | 取消，不切换 |
| 窗口失焦 / 页面隐藏 / 30s 无任何事件 | 取消（仅作 keyup 丢失的兜底，正常使用不会触发） |

实现要点：

- 浮窗挂在 `shell.overlay` 插槽，`pointer-events: none`，**不抢焦点**——否则 keyup 收不到。
- 候选列表在**打开瞬间快照**，避免后台会话刷新顺序导致高亮行游走。
- 浮窗打开期间，其余会话快捷键暂时被抑制（否则 `Cmd+N` 会在预览中途插会话）。
- 列表上限 9 条；过滤规则与之前一致（跳过 `blank`、归档、`origin: "subagent"`）。
- 每行显示：标题 · 「当前」徽标 · 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前）。

## 两条「让位」规则

`⌘B` 与 `⌘,` 在正常版 DSH 里本该由注册表负责（`desktop:macos` 默认值就是它们）。当前 Desktop 跑在 `web`
runtime，这两个默认值不生效，插件才接管：

| 键 | 实现 | 为什么这么做 |
|---|---|---|
| `⌘B` | 直接调 `ctx.layout.toggleSidebar()` | Web 白名单不允许单修饰键，注册表装不下这条；与系统自带 `⌘⌥B` 调用同一个方法 |
| `⌘,` | 从 `ctx.shortcuts.catalog` 读出 `settings.open` 的**当前**绑定，合成 `keydown` 派发 | 不硬编码组合：你在设置里改过它的键，这里自动跟随；若它本来就绑在你的组合上，插件不接管，避免开两次设置 |

两条都只在 `web` runtime 生效；`desktop` runtime 会把它们原样让给注册表。
改键时会先查注册表：**与内置命令冲突的组合会被拒绝**并提示占用者 id。

## 改键与持久化

设置 → 通用 底部有一张「会话快捷键」卡片：

- 每一行显示 动作 / 当前键 / `修改` / `恢复`
- 点 `修改` 后按下新组合即保存，`Esc` 取消
- 组合必须至少包含一个 `Ctrl`／`Alt`／`⌘`；与其它行重复会被拒绝并提示
- `全部恢复默认` 一键回到出厂键位

键位存在 `localStorage` 的 `dsh.sessionkeys.bindings.v1`（同一 Electron 分区，重启保留），
结构为 `{ version: 1, bindings: { <动作>: "<修饰键>+<code>" } }`，例如
`{"close":"Meta+KeyW","cycle":"Ctrl+Tab"}`。损坏或不可读时自动回落到默认值。

只在命中组合时 `preventDefault()` + `stopPropagation()`；未命中一律放行，不干扰输入框、终端、内嵌页面。

## 语义细节

- **「最近会话」按 `sessions.list` 的 `updatedAt` 倒序**，`updatedAt` 相同时用快照 `ids` 的原始顺序兜底，
  保证连续按键时轮转顺序稳定。
- **候选过滤**：跳过 `blank` 会话、已归档会话、`origin === "subagent"` 的子会话
  ——`Ctrl+Tab` 永远不会跳进 Agent Teams 的成员会话。
- **当前会话判定**：优先读 `uiWorkspace.mainReference.sessionId`（权威引用），读不到再回退到
  `retainedBy.mainView > 0` 的投影。
- **`Cmd+W` 两级**：主视图有会话 → `uiWorkspace.clearMain()` 回列表；已在列表 → 不消费事件，
  让原生菜单/窗口处理。
- **`Cmd+D` 是 toggle**：用 `workspaces.list.pinnedSessionIds` 判断当前状态，走
  `uiWorkspace.pinSession()` / `unpinSession()`。
- `session.new`（`Cmd+N`）在 `web` runtime 下原本是 `Cmd+Alt+N`，本插件用自己的处理器补上 `Cmd+N`；
  若将来 DSH 修好 `data-platform` / 键盘桥，使 `desktop:*` 生效，本插件会与内置 `session.new` 撞键，
  届时需要**只在 `web` runtime 下启用 `Cmd+N`**（`apply` 里已有 `runtime` 可判断）。

## 安装

```bash
dsh plugin --profile desktop add @brantshi1/dsh-hotkey-enhance
```

然后重启 DSH Desktop。**设置 → 通用** 底部应出现「桌面快捷键」一节。

从源码装（本地开发用，改动即时生效）：

```bash
dsh plugin --profile desktop add /path/to/dsh-hotkey-enhance
```

## 卸载

```bash
dsh plugin --profile desktop remove @brantshi1/dsh-hotkey-enhance
```

手动回滚：从 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles`
里删掉该包名，在 profile 目录执行一次 `pnpm install`，然后重启。

已录制的键位保存在 `localStorage`（`dsh.sessionkeys.bindings.v1`），卸载不会清除；重装后仍在。

## 验证

离线行为测试（假 `window` + 假 `localStorage` + 假 React + 假 cordis ctx，**62 条断言**，覆盖按键映射、
候选过滤、`mainReference` 优先级、`Cmd+W` 列表态不消费、输入法/修饰键忽略、监听器释放、录制改键、
`Esc` 取消、重复/弱组合拒绝、单条与全部恢复、持久化跨重载，以及浮窗的轻点/按住/回卷/反向/
Esc/先松 Ctrl/失焦/看门狗/预览期间抑制/快照冻结/单候选用例）：

```bash
pnpm test      # 等价于 node tests/hotkey-enhance.test.mjs
```

调试真实按键：把 `lib/client.js` 里的 `DEBUG` 改成 `true`，每条命中的按键会以
`[dsh-hotkey-enhance] ...` 写进
`~/Library/Application Support/DSH Desktop/logs/dsh-<date>.error.log`（renderer console 会被桌面壳捕获）。

## 已知边界

- 因为绕过注册表，这六条键不会出现在 DSH 原生快捷键目录里，也没有原生目录的冲突检测。
- 持久化用的是 `localStorage`，不是 profile 的 host 配置。要改成 host 配置（`ctx.configForms`）
  需要给宿主侧补 `Config`（schemastery）并让插件目录能解析 `@deepseek-ai/schemastery`，且要重启。
- macOS 上 `Cmd+W` 可能与原生 File → Close Window 菜单加速键竞争。当前实测渲染进程能收到该按键
  （日志里出现过 `keydown primary+W`），行为正确；若某天菜单先手，用 `Cmd+Shift+W` 或改安装包去掉
  菜单加速键。
- 浮窗用 `z-index: 2147483000` 固定在顶层；若某个模态层更高，浮窗会被遮住（此时仍能松手切换，只是看不见）。
- `Cmd+1..9` 未实现：侧栏可见顺序算在 `ui-workspace` 的 React 层，外部插件读不到
  （`groupExpansion` / `orderBy` / 手动排序都不在服务面）。要做对，需要上游把可见顺序发布成状态。
