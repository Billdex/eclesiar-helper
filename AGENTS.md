# AGENTS.md

本文件给在本仓库工作的 AI 代理与协作者使用，只记录项目特有约定；通用工作原则沿用全局配置（`~/.dsh/AGENTS.md`）。

## 1. 项目定位

- 目标：为多人在线经济 / 政治模拟游戏 Eclesiar（<https://app.eclesiar.com/>）提供 Tampermonkey 用户脚本。
- 现状：**v0.1.0**，只完成外壳——悬浮球 + 可展开面板 + 功能注册表 + SPA 路由钩子；具体计算功能后续接入。
- 非官方工具：不修改游戏数据、不自动操作，遵守游戏规则。
- 文档：`README.md` 面向玩家（安装 / 扩展），官方 Wiki 为 <https://wiki.eclesiar.com/>。

## 2. 硬约束

1. **单文件交付**：唯一安装产物是 `eclesiar-helper.user.js`。不要引入构建链、包管理器或运行时依赖；确有需要先征得用户同意。
2. **UI 全在 Shadow DOM**：新增界面挂在 `dom.shadow` 内，样式写进 `STYLES`（`eh-` 前缀）。不要直接往游戏页面插 DOM / CSS。
3. **资源必须可回收**：监听器用 `on(...)` 注册；功能内的定时器、订阅用 `ctx.onDestroy(...)` 登记。新增资源时同步检查 `destroy()` 是否覆盖。
4. **不碰账号与隐私**：不读取或上报 Cookie、Token、账号信息；日志不打印玩家数据。计算只在本地进行。
5. **不做影响公平性的自动化**：不自动点击、提交表单、循环请求接口、多开或绕过验证；只做展示、计算与用户主动触发的辅助。
6. **扩展只走功能注册表**：新模块用 `features.register()`，不要改面板外壳或硬编码标签页。
7. **版本号三处同步**：metadata 的 `@version`、`const VERSION`、`README.md` 的「当前版本」。

## 3. 目录

```
eclesiar-helper/
├── eclesiar-helper.user.js   # 脚本本体（唯一安装产物）
├── dev/                      # 本地开发目录，已被 git 忽略（预览页 / 截图）
├── README.md                 # 给玩家看的安装 / 扩展文档
└── AGENTS.md
```

## 4. 常用命令

```bash
node --check eclesiar-helper.user.js   # 语法检查
open dev/preview.html                  # 本地预览（仅本机存在，dev/ 不入库）
open "dev/preview.html#closed"         # 只看收起状态
```

截图（无头 Chrome；入场动画未结束时，用 CDP 等渲染稳定再截）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --no-sandbox --disable-gpu --disable-breakpad \
  --user-data-dir="$(mktemp -d)" --window-size=1440,900 \
  --force-device-scale-factor=2 --virtual-time-budget=4000 \
  --screenshot="$PWD/dev/shot-open.png" "file://$PWD/dev/preview.html"
```

调试日志：游戏页地址后加 `?eh-debug=1`。

## 5. 代码组织

`eclesiar-helper.user.js` 内按以下顺序分节，新增代码放到对应区段，不要打乱：

1. 常量与工具
2. 状态
3. 样式（`STYLES`）
4. 外壳（`createShell` / 兜底样式）
5. 悬浮球（定位 / 拖拽 / 点击）
6. 面板（定位 / 开合 / 标签页）
7. 路由钩子
8. 对外 UI 控制（`publicUi`）
9. 内置功能（`overview` / `about`）
10. 启动与销毁
11. 公开 API

约定：

- 注释和用户可见文案用中文。
- 样式类名 `eh-` 前缀；几何位置允许 inline style，视觉样式一律进 `STYLES`。
- 键盘 / 焦点：Shadow DOM 内用 `dom.shadow.activeElement`，不要用 `document.activeElement`；`Esc` 只在事件路径命中插件时接管，避免抢游戏按键。
- 面板内容高度变化后调用 `ctx.ui.reposition()`，否则会沿用旧的高度缓存。

## 6. 新增一个功能

```js
EclesiarHelper.features.register({
  id: 'market-calc',
  title: '行情计算',
  order: 20,
  mount(pane, ctx) {
    pane.innerHTML = '<p class="eh-note">…</p>';
    const off = ctx.route.onChange((path) => ctx.log('route', path));
    ctx.onDestroy(off);
  }
});
```

- `pane` 是该功能的容器，首次激活时才 `mount`（懒加载）。
- `ctx` 提供：`storage`（自动按功能 id 加前缀）、`route`、`ui`、`onDestroy`、`log`、`shadow`、`id`、`version`。
- 复用 `eh-section` / `eh-h3` / `eh-kv` / `eh-note` / `eh-callout` / `eh-row` / `eh-btn` / `eh-links` 等类，保持视觉一致。

## 7. 测试清单

提交前至少：

1. `node --check`
2. 打开 `dev/preview.html`：悬浮球可拖、点击开合、`Alt+E`、`Esc`（焦点在面板内）、方向键切标签。
3. 改过定位 / 尺寸逻辑时，用 CDP 或 DevTools 把视口切到 360×600，确认球与面板都在视口内。
4. 改过生命周期时，控制台执行 `EclesiarHelper.destroy()`，确认宿主与 API 都消失。
5. 真实环境：Tampermonkey 安装后刷新 `app.eclesiar.com`，确认悬浮球出现、面板正常。

注意：无头 Chrome 长时间运行可能把页面标记为 `hidden`，此时不会派发 `resize`、`ResizeObserver` 和 `rAF` 回调，定时器也会被节流。测试尺寸逻辑时可手动 `window.dispatchEvent(new Event('resize'))`，或先把页面切到前台；这不是插件缺陷。

## 8. Git 约定

- 默认分支 `main`；提交信息用中文 + 类型前缀：`feat:` / `fix:` / `docs:` / `chore:`。
- 一次提交只做一件事；提交前 `git status` 确认没有 `.DS_Store`、临时脚本或无关杂物。
- `dev/` 已被 git 忽略；预览页与截图只在本机使用，不要强制加入版本库。
- 不提交任何账号信息、Cookie、Token 或游戏内隐私数据。

## 9. 发布

1. 修改 `@version` 与 `const VERSION`，同步 README 的「当前版本」。
2. 更新 README 的能力表 / 说明。
3. 把 `.user.js` 全文粘贴进 Tampermonkey（或拖入浏览器）覆盖旧版本。
