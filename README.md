# Eclesiar 助手（Eclesiar Helper）

一个为 [Eclesiar](https://app.eclesiar.com/)（多人在线经济 / 政治模拟游戏）准备的油猴（Tampermonkey）辅助脚本。

当前版本 **v0.1.0**：常驻悬浮球 + 可展开面板。业务功能以「功能（feature）」形式注册接入，外壳无需改动。

> 非官方工具，与 Eclesiar 官方无关。请遵守游戏规则。

---

## 已实现

| 能力 | 说明 |
| --- | --- |
| 悬浮球 | 可拖拽；松手后按视口比例记忆位置，窗口缩放不失位；点击开合面板 |
| 面板 | 跟随悬浮球自动定位（会左右翻转避免出屏）；标题栏可拖动，双击恢复自动跟随 |
| 样式隔离 | 整体挂在 Shadow DOM 内，游戏样式不会污染插件，插件也不会污染游戏 |
| 标签页 | 由功能注册表动态生成，支持横向滚动与键盘左右切换（标签获得焦点时） |
| 内置页面 | 「概览」（实时路由 / 页面标题 / 视口 / 时钟）、「关于」（快捷键、链接、重置入口） |
| 快捷键 | `Alt + E` 开关面板；`Esc` 仅在焦点位于插件内时收起，不干扰游戏自己的 Esc 行为 |
| 尺寸自适应 | 窗口缩放、设备旋转、切回标签页时都会重新约束悬浮球与面板，避免出屏 |
| SPA 路由钩子 | 包装 `history.pushState / replaceState` + `popstate / hashchange`，功能可订阅路由变化 |
| 自愈挂载 | 游戏是单页应用，若宿主容器被意外移除会自动重新挂载 |
| 状态持久化 | 悬浮球位置、面板固定位置、上次所在标签页；仅存于浏览器 `localStorage` |
| 完整回收 | `window.EclesiarHelper.destroy()` 移除 DOM、监听器、定时器与 history 补丁 |

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）。
2. 打开管理面板 → 「添加新脚本」→ 清空模板，粘贴 `eclesiar-helper.user.js` 的全文 → 保存。
   - 也可以直接把 `.user.js` 文件拖进浏览器窗口，按提示安装。
3. 打开 <https://app.eclesiar.com/> 并刷新，右下角出现金色悬浮球即生效。

脚本只匹配 `https://app.eclesiar.com/*`，不会在官网、Wiki 或其它站点运行。

调试日志：在游戏页面地址后加 `?eh-debug=1`，控制台会输出插件日志。

## 目录结构

```
eclesiar-helper/
├── eclesiar-helper.user.js   # 用户脚本本体（唯一需要安装的文件）
├── README.md                 # 安装、功能与设计说明
└── AGENTS.md                 # 项目内的代理协作约定
```

单文件、零依赖、无构建步骤：改完脚本刷新游戏页面即可生效。本地开发用的 `dev/`（预览页与截图）已被 git 忽略，不随仓库分发。

## 如何新增一个功能

每个功能就是一个带 `id / title / mount` 的对象，注册后会自动出现在标签栏里，首次点开时才执行 `mount`（懒加载）：

```js
window.EclesiarHelper.features.register({
  id: 'market-calc',
  title: '行情计算',
  order: 20,                       // 越小越靠前，默认 100
  mount(pane, ctx) {
    pane.innerHTML = '<p class="eh-note">在这里渲染你的界面</p>';

    // 订阅 SPA 路由变化
    const off = ctx.route.onChange((path) => {
      ctx.log('路由变化：', path);
    });

    // 定时器、监听器等清理逻辑交给框架回收
    ctx.onDestroy(off);
  }
});
```

`ctx`（功能上下文）提供：

| 字段 | 说明 |
| --- | --- |
| `ctx.id` / `ctx.version` | 当前功能 id、插件版本 |
| `ctx.shadow` | ShadowRoot，需要挂载自定义样式时可用 |
| `ctx.ui` | `open() / close() / toggle() / isOpen() / resetBall() / resetPanel()` |
| `ctx.ui.reposition()` | 功能内容高度变化后调用，重新测量并保持顶部位置 |
| `ctx.storage` | 按功能自动加前缀的 `get / set / remove`，互不串键 |
| `ctx.route` | `current`（当前路径）与 `onChange(fn)`，返回取消订阅函数 |
| `ctx.onDestroy(fn)` | 注册清理回调，`destroy()` 或卸载时执行 |
| `ctx.log(...)` | 带功能前缀的调试日志 |

面板内可复用的样式类（均在 Shadow DOM 内）：

`eh-section`、`eh-h3`、`eh-kv`、`eh-note`、`eh-callout`、`eh-row`、`eh-btn`、`eh-btn--ghost`、`eh-links`、`eh-mono`、`eh-empty`。

控制台也可直接调用：

```js
EclesiarHelper.ui.toggle();
EclesiarHelper.ui.open();
EclesiarHelper.features.list();
EclesiarHelper.route.current;
EclesiarHelper.destroy();
```

## 设计说明

- **为什么用 Shadow DOM**：游戏是 Vite 打包的 React 单页应用，全局 CSS 变量、`button` 重置、字体规则都很常见。Shadow DOM 能彻底隔离两边样式，插件 UI 不受游戏改版影响；样式表优先用 `adoptedStyleSheets` 注入，规避站点 CSP 对内联 `<style>` 的限制。若浏览器不支持构造样式表、回退的 `<style>` 又被 CSP 拦截，会检测到并写入一段最小内联样式（CSSOM 不受 `style-src` 限制），保证入口仍可见可点，同时在控制台告警。
- **为什么单文件无构建**：油猴的安装体验就是「一份文本」，引入打包器会让每次改动都要构建、复制，反而增加维护成本。脚本内部已按「外壳 / 悬浮球 / 面板 / 路由 / 功能」分节，便于定位与修改。
- **挂载点**：宿主是 `body` 下 0×0 的 `position: fixed` 容器，不占布局、不挡点击（子元素单独开启 `pointer-events`）。
- **尺寸与位置**：悬浮球位置按视口比例保存，缩放后按比例还原；面板未固定时跟随悬浮球，固定后保留绝对位置。窗口缩放、`ResizeObserver`、`visibilitychange` 三路都会触发重新约束——后台标签页里浏览器可能暂停 `resize` 事件与渲染回调，回到前台会立即校正。
- **不主动抓取游戏数据**：当前只做容器与交互，不请求任何游戏接口；只读解析应优先使用页面已有的 DOM 或官方接口，避免高频轮询。
- **已知边界**：如果游戏日后给 `body` 加 `transform / filter`，`position: fixed` 的参照系会改变，届时需要调整挂载策略；目前游戏未使用这类样式。

## 许可

MIT。仅供学习与个人辅助使用。
