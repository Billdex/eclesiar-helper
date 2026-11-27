# AGENTS.md

本文件面向在本仓库工作的 AI 代理与协作者，只记录项目特有约定；通用工作原则沿用全局配置（`~/.dsh/AGENTS.md`）。

**文档分工**：`README.md` 面向玩家，只保留安装、更新与「功能一览」，不写实现细节与逐页操作说明；本文件面向开发者（约束、结构、口径、验收）。README 描述玩家能看到什么，具体规则与验收以本文 §2.3 与 §8 为准。

## 1. 项目概览

- 目标：为多人在线经济 / 政治模拟游戏 Eclesiar（<https://app.eclesiar.com/>）提供 Tampermonkey 用户脚本。
- 非官方工具：只读公开行情、只在本地计算；不写游戏数据、不自动下单。
- 分发：GitHub 仓库 + jsDelivr。唯一安装产物是 `eclesiar-helper.user.js`，`eclesiar-helper.meta.js` 只供油猴检查更新。
- 技术背景：游戏是 Vite + React + React Router 单页应用（`window.__reactRouterVersion`），页内跳转必须遵守 §5 的 `route.goto` 规则。
- 当前版本以脚本 `@version` 为准（README 首部的「当前版本 **vX.Y.Z**」必须同步）；发版流程见 §7。

## 2. 模块与数据

### 2.1 模块

| 模块 | 位置 | 说明 |
| --- | --- | --- |
| `fx` | 面板「汇率」 | 全球法币挂单 → 买卖最优价与目标额度加权均价；置顶国籍国 / 所在国汇率 |
| `goods` | 面板「市场」 | 各国市场成品 / 原材料折算黄金；采购 / 销售两种口径；流亡政府单列 |
| `business` | 面板「工商」 | 子面板注册表 `registerBusinessPane()`，现有「工业」「税费」 |
| `about` | 面板「设置」 | 专用 API 密钥、功能开关（市场页金价 / 地区入口 / 自动比价）、版本检查、快捷键、链接、重置 |
| `marketBadge` | 游戏商品市场页 | 列表起价、「实收金额」旁追加折算金价（只读节点） |
| `regionJump` | 游戏商品市场页 | 「你当前不在该国家」横幅下追加该国地区按钮 |
| `marketJump` | 跳转落地后 | 消费 `sessionStorage` 意图，点一次游戏自己的分类 / 品质筛选 |
| `goodsAuto` | 设置页「功能开关」 | 默认关闭；开启后启动预抓行情，供市场页不打开面板也能比价 |

各模块的口径、排序与展示规则见 §2.3；README 只保留面向玩家的功能概览。

### 2.2 共享数据源

| 数据源 | 内容 | 缓存 | 使用方 |
| --- | --- | --- | --- |
| `fxFeed` | 全球法币挂单；国家清单、税率与工资法 | 行情 10 分钟；国家清单一次；税率页面内缓存 | 汇率、商品销售、税费、`marketBadge` |
| `goodsSnapshot` → `goodsFeed` | 各国市场行情，抓完 `publish` 给 `goodsFeed` | 10 分钟（`GOODS_CACHE_MS`） | 市场页、`goodsAuto`、`marketBadge` |
| `regionFeed` | 国家 → 地区清单，并发共享同一请求 | 5 分钟 | 市场页领土检查、`regionJump`、工业 |
| `playerFeed` | 国籍 id 与所在国 id（只这两个字段） | 2 分钟，失败冷却 60 秒 | 汇率置顶、商品销售、税费高亮、`marketBadge` |

- 行情请求统一走 `market.call`（负责并发、凭据与错误分类），不要自己 `fetch`。
- 账号信息固定 `POST /account/getuser`（`{ login: true }`，见 §3 第 5 条）。
- 领土接口 `GET /country/regions?country_id=…` 只发 GET（同地址 POST 会 404），`call` 要传 `noMethodRetry`；返回无 `data` 或空数组都表示已失去全部领土，需传 `allowEmpty` 才不当成坏载荷。

### 2.3 口径与展示规则

- **汇率**：价格单位统一为「黄金 / 1 单位法币」。买入 = 花黄金买法币，取卖单（asks）最低价；卖出 = 卖法币换黄金，取买单（bids）最高价。目标额度（默认 10，`fx:mode` 记黄金 / 法币口径）从最优档逐档吃单，给出成交量加权均价：吃满多档才在行尾补「均价」；吃不满时徽标换成成交均价并标「深度不足」。一轮数据到齐后按买入均价升序重排，缺失或失败的行排最后；加载中不排序。
- **商品采购**：取该国市场最低卖单价 × `rateFor`（买币最优价），不叠加进口税。
- **商品销售**：最低卖单价 ×（1 − 增值税 − 进口税）× `sellRateFor`；本国免进口税，读不到国籍时两项都扣；按税后收入降序。缺税率按 0 估算、缺买单、买盘连 1 件都吃不下都要单独标注。
- **税费折金**：`sellRateFor` 优先，缺买单退回 `rateFor`；两个方向都没有则为 `null`，按折金列排序时永远最后。最低工资税金 = 工资税 ÷ 100 × 税前最低工资 × 汇率。
- **工业综合排序**：先按「工业区 + 资源产区 + 物产」凑齐的项数分档，同级按（工业区 + 资源产区 + 物产加成）×（1 − 污染%）降序，再按地区名。物产 5% / 15% / 30% 折算 0.5 / 1.5 / 3 分。手动排序只提供综合 / 物产 / 污染 / NPC。
- **税费综合排序**：增值税 + 进口税升序 → 最低工资税金（折金）升序 → 进口税 → 国名，同值兜底方向固定。
- **流亡政府**：`GET /country/regions` 无 `data` 或空数组 = 已失去全部领土；商品与税费把它从主列表剔除、单列到最底部，名次显示 `—`、不抢「最优」高亮。查不到领土时按「有领土」处理。
- **市场页标注**：列表行 = 起价 × `rateFor`；上架表单 = 实收金额 × `sellRateFor`，币种取 `playerFeed.countryId`；「比全球最低贵多少」取 `goodsFeed.bestGold()`（跳过流亡政府与缺汇率的国家），差额不足 0.5% 显示「最低」。
- **置顶 / 高亮**：「汇率」置顶国籍与所在国两行（同币合并，不在全局列表重复）；「市场」与「税费」只在列表内高亮（本国 / 当前位置），不置顶、不参与排序。

## 3. 硬约束

1. **单文件交付**：唯一安装产物是 `eclesiar-helper.user.js`。不要引入构建链、包管理器或运行时依赖，确有需要先征得用户同意。`eclesiar-helper.meta.js` 只放元数据（供油猴 `@updateURL` 拉版本号），不是安装产物，头部信息必须与主脚本一致。

2. **插件自己的 UI 一律在 Shadow DOM 内**：新增界面挂在 `dom.shadow` 内，样式写进 `STYLES`（类名 `eh-` 前缀），几何位置可用 inline style；页面级注入只走第 3 条的白名单。

3. **页面级注入仅限白名单**（目前只有 `marketBadge` 与 `regionJump`），且必须同时满足：
   - 只在对应页面 / 提示存在时挂载，离开页面立即整块移除；
   - 只追加插件自己的只读节点，不改游戏原有节点、文本、按钮与事件，不接管点击；
   - 样式内联或在该节点的 Shadow DOM 内，不注入全局 CSS；
   - 受面板开关控制，`destroy()` 必须清干净。
   新增任何页面级注入，先在本节登记再写代码。

4. **资源必须可回收**：监听器用 `on(...)` 注册；功能内的定时器、订阅用 `ctx.onDestroy(...)` 登记。新增资源时同步检查 `destroy()` 是否覆盖。

5. **数据与隐私**：不读取 Cookie 值，不上报任何数据，日志不打印玩家数据。允许读取的范围只有：
   - 登录 JWT：只从游戏发往 `api.eclesiar.com` 的请求头里捕获，仅存内存，不落盘、不打印、不上报；
   - 账号字段：只读国籍 id（`nationality.id` / `nationality_id`）与当前所在国 id（`region.country.id`），统一走 `playerFeed`（2 分钟缓存），只存内存、不展示原值、不落盘、不打日志；
   - 账号接口固定 `POST /account/getuser`（当前登录账号），必须传 `{ login: true }`：只认游戏登录凭据，带专用密钥会 401；`/account` 是按 `account_id` 查别人，不要用；响应里的 `bearer` 必须忽略。
   唯一允许落盘的凭据是玩家在「设置」页主动生成 / 粘贴的**专用 API 密钥**（`eclesiar_prod_…`，`localStorage` 键 `api-key`），插件请求优先用它；不得打印完整密钥，不得发给任何第三方。
   `sessionStorage` 只允许 `eh:market-intent`（跳转意图，10 分钟过期，消费后立即删除）与 `eh:debug`（地址上出现过 `eh-debug=1` 后置位，供 SPA 跳转丢 query 后继续打印调试日志）。其它持久化一律不允许。

6. **不做影响公平性的自动化**：不自动点击游戏控件、不提交表单、不下单、不轮询接口、不多开、不绕过验证；只做展示、计算与玩家主动触发的操作。
   允许的自动行为只有下面两个，且必须同时满足「玩家显式触发或确认、只读公开接口、有硬上限、可随时关闭、`destroy()` 清理」：
   - `goodsAuto`（`localStorage` 键 `autoCompare`，**默认关闭**）：必须在设置页「功能开关」勾选并在提示「一轮上百次请求、可能拖慢启动并消耗额度」后点「仍然开启」才生效；按 `GOODS_CACHE_MS`（10 分钟）过期才重拉，只在前台标签页跑，失败退避 5 分钟。
   - `marketJump`：只在玩家从面板点「去市场」后运行，落地时读 `sessionStorage` 意图并点一次游戏自己的筛选按钮；只认文本或图标 `alt` 完全相等的可点控件（`button` / `role=button|tab|option` / `cursor:pointer`，不认 `div` / `span`——顶栏资源位也有同名文字；带 `href` 的链接一律不点），最多重试 10 秒，点不到就放弃并清掉意图。
   新增周期性请求或自动点击前，先改本节。

7. **扩展只走功能注册表**：新模块用 `features.register()`（工商子面板用 `registerBusinessPane()`），不要改面板外壳或硬编码标签页。

8. **版本号四处同步**：`eclesiar-helper.user.js` 的 `@version`、同文件 `const VERSION`、`eclesiar-helper.meta.js` 的 `@version`、`README.md` 的「当前版本」。四处只在**要发版的版本分支**上一起递增，且分支内始终保持一致；不含插件本体内容的改动（文档、脚本、纯注释）不动版本号。版本号由玩家确认后才递增。
   README 的版本行必须保持 `当前版本 **vX.Y.Z**` 这一格式，`scripts/release.sh` 按它校验。

9. **更新源固定**：`@updateURL` / `@downloadURL` / 设置页「安装更新」都走 jsDelivr `CDN_RAW`；备源顺序固定为 JSDMirror `MIRROR_RAW` → JSDMirror 备用域名 `MIRROR_CN_RAW` → `REPO_RAW`。设置页对 `UPDATE_META_URLS` **并行**请求并取最高 `@version`（`eh_t` 时间戳只绕得开边缘节点缓存，中间层对分支的解析缓存仍会滞后到小时级，所以单个源落后不会漏更新）。油猴只支持一个 `@updateURL`，自动更新通道只能是 jsDelivr；镜像不主动刷新，等它随自身缓存过期追上。改名或迁移仓库时，`REPO_URL` / `CDN_RAW` / `MIRROR_RAW` / `MIRROR_CN_RAW` / `REPO_RAW` / `UPDATE_META_URLS` / `UPDATE_INSTALL_URL` / `UPDATE_INSTALL_MIRROR` / `UPDATE_INSTALL_FALLBACK` 与 README 里的安装链接必须一起改。

## 4. 目录与命令

```
eclesiar-helper/
├── eclesiar-helper.user.js   # 脚本本体（唯一安装产物）
├── eclesiar-helper.meta.js   # 只有元数据，供油猴检查更新
├── README.md                 # 给玩家看的安装 / 功能一览
├── AGENTS.md                 # 本文件
└── scripts/
    └── release.sh            # 发布辅助：版本校验 + 刷新 jsDelivr 缓存（不是安装产物）
```

`dev/`（本地调试页）、`backups/`、`.playwright-cli/` 已被 git 忽略，不要提交。仓库不提供测试页，也不含任何镜像刷新密钥（不要重新引入）。

```bash
node --check eclesiar-helper.user.js   # 语法检查
node --check eclesiar-helper.meta.js   # 元数据语法检查
git switch -c v<新版本> main            # 版本分支：从 main 迁出（流程见 §7）
scripts/release.sh                     # 合并推送后刷新 jsDelivr 缓存（流程见 §7）
```

调试日志：游戏页地址后加 `?eh-debug=1`。需要假数据时，在 `dev/` 里写一个替换 `window.fetch` 的本地页面，验证完即弃，不入库。

## 5. 代码组织

`eclesiar-helper.user.js` 按以下顺序分节，新增代码放到对应区段：

1. 常量与工具
2. 状态
3. 样式（`STYLES`）
4. 外壳（`createShell` / 兜底样式）
5. 悬浮球（定位 / 拖拽 / 点击）
6. 面板（定位 / 开合 / 标签页）
7. 路由钩子（`route`：包装 `pushState` / `replaceState`，订阅变化，`goto(path)` 跳转）
8. 对外 UI 控制（`publicUi`）
9. 内置功能（`fx` / `goods`（含 `goodsSnapshot`、`regionFeed`、`goodsAuto`）/ `marketBadge` / `regionJump` / `marketJump` / `business` / `about`，版本检查在 `about`）
10. 启动与销毁
11. 公开 API

### 5.1 路由跳转

- 跳转必须把 `history.state.idx` 加一再 `pushState`，否则 React Router 认为 idx 没变、忽略这次 `popstate`，页面不重渲染。
- 同一路由只换 id（`/market/17` → `/18`、`/monetary-market/2` → `/3`）时组件不会重新挂载，走 `detour()`：先 push 到 `/{语言}/dashboard` 卸掉当前页，用 MutationObserver 数到 30 个节点增删（或 600ms 兜底）后立即 `replaceState` 到目标。两段都是结构变化，都会重渲染，全程不刷新，中转页不留在历史里。
- 换完不再回头校验 URL（目标若是玩家所在国，游戏会自己把地址改成 `/market`，校验会误判成失败再刷一次）。两段里任一段没生效才整页跳。
- 结构变化的跳转（`/market` → `/market/17`、市场 ↔ 货币市场）直接 `pushTo()` 走 SPA。
- `goto` 自动补当前路径首段的语言前缀（如 `/zh-CN/market/12`）。

### 5.2 外壳与样式

- 宿主是 `body` 下一个 0×0 的 `position: fixed` 容器，不占布局、不挡点击（子元素单独开 `pointer-events`）；容器被移除时自动重新挂载。
- 样式表优先用 `adoptedStyleSheets` 注入，规避站点 CSP 对内联 `<style>` 的限制；不支持构造样式表、回退 `<style>` 又被 CSP 拦截时，写入一段最小内联样式（CSSOM 不受 `style-src` 限制）保证入口可见可点，并在控制台告警。
- 悬浮球位置按视口比例保存，缩放后按比例还原；面板未固定时跟随悬浮球，固定后保留绝对位置。`resize`、`ResizeObserver`、`visibilitychange` 三路都会重新约束（后台标签页可能暂停事件与渲染回调）。
- 键盘 / 焦点：Shadow DOM 内用 `dom.shadow.activeElement`，不要用 `document.activeElement`；`Esc` 只在事件路径命中插件时接管，避免抢游戏按键。
- 面板内容高度变化后调用 `ctx.ui.reposition()`，否则会沿用旧的高度缓存。

### 5.3 布局留白

- `.eh-body` 只负责滚动，不设 padding；`.eh-pane` 统一 14px（窄屏 12px）。留白归功能页自己管。
- 工商页用 `.eh-biz-shell` 覆盖成 `padding: 10px 14px 14px`（窄屏 `8px 12px 12px`），二级标签因此能贴着一级标签。`.eh-biz-shell` 有 `overflow: hidden`，**不要用负边距**贴边（会被裁掉半行）。
- 「顶部固定、只有列表滚」的页面统一用 `.eh-pane--stick` + `.eh-stick-head` + `.eh-stick-bar` + `.eh-stick-scroll`（汇率 / 市场 / 工业）：pane 变 flex 列并撑满内容区，头部 `flex: none`，`.eh-stick-bar` 放不随列表滚动的区块标题（如「全球汇率」「各国市场」），滚动区 `flex: 1 1 auto; min-height: 0; overflow-y: auto`，滚动区的直接子项必须 `flex: none`（否则会被压缩成溢出而不是滚动）。`.eh-pane--stick` 只写 `display: flex`，flex 与 `min-height` 由 `.eh-body > .eh-pane.eh-pane--stick` / `.eh-biz-body > .eh-biz-pane.eh-pane--stick` 补——不要把 `display` 提到高特异性，否则会压掉 `.eh-pane[hidden]`。
- 工商子面板的 pane 本身没有 padding，固定头与滚动区直接挂在 pane 下；不要在外面再包一层 `.eh-section`，否则滚动区会失去 flex 容器、内容被裁而不是滚动。
- 税费页把滚动交给内部列表：`.eh-tax-pane` + `.eh-tax-scroll`，并用 `.eh-biz-body > .eh-tax-pane { flex: 1 1 auto; min-height: 0 }` 顶掉 `.eh-biz-body > .eh-biz-pane { flex: none }`。不要在工商页多出色带。

## 6. 新增功能

```js
EclesiarHelper.features.register({
  id: 'market-calc',
  title: '行情计算',
  order: 20,                 // 越小越靠前，默认 100
  mount(pane, ctx) {
    pane.innerHTML = '<p class="eh-note">…</p>';
    const off = ctx.route.onChange((path) => ctx.log('route', path));
    ctx.onDestroy(off);
  }
});
```

- `pane` 是该功能的容器，首次激活时才 `mount`（懒加载）；挂载失败会就地显示错误，不影响其它标签。
- `ctx` 提供：

| 字段 | 说明 |
| --- | --- |
| `ctx.id` / `ctx.version` | 当前功能 id、插件版本 |
| `ctx.shadow` | ShadowRoot |
| `ctx.ui` | `open / close / toggle / isOpen / resetBall / resetPanel / reposition` |
| `ctx.storage` | 按功能 id 自动加前缀的 `get / set / remove` |
| `ctx.route` | `current` 与 `onChange(fn)`，返回取消订阅函数 |
| `ctx.onDestroy(fn)` | 注册清理回调，`destroy()` 时执行 |
| `ctx.log(...)` | 带功能前缀的调试日志 |

- 可复用样式类：`eh-section`、`eh-h3`、`eh-kv`、`eh-note`、`eh-callout`、`eh-row`、`eh-btn`、`eh-btn--ghost`、`eh-links`、`eh-mono`、`eh-empty`。
- 工商子面板用 `registerBusinessPane({ id, title, order, mount })` 注册，加子面板只往 `businessPanes` 里加一项，不动一级标签。
- 注释与用户可见文案用中文。
- 控制台可用：`EclesiarHelper.ui.toggle()`、`EclesiarHelper.ui.open()`、`EclesiarHelper.features.list()`、`EclesiarHelper.route.current`、`EclesiarHelper.destroy()`。

## 7. Git 与发布

- 默认分支 `main` 代表「已发布 / 玩家可安装」的状态；提交信息用中文 + 类型前缀（`feat:` / `fix:` / `docs:` / `chore:`）。
- **不含插件本体内容的更新直接进 `main`**：文档、`scripts/`、`AGENTS.md` 等，不新建分支、不递增版本号、不发布。
- **要改插件本体时先与玩家确认版本**：
  1. 报出当前版本与递增后的版本，由玩家决定是否递增、递增到哪一位；
  2. 玩家确认后从 `main` 迁出版本分支：`git switch -c v<新版本> main`，并在该分支一次改好四处版本号；
  3. 之后该版本的功能与调整都提交在这个分支里；玩家明确说不递增时才直接在 `main` 上改。
- **版本分支上不主动合并、不主动推送、不跑发布脚本**。只有玩家明确表示「这个版本开发完了」才合并发布：`git switch main && git merge --no-ff v<新版本>` → `git push origin main` → 刷新缓存。版本分支保留不删（除非玩家要求）。
- 一次提交只做一件事；提交前 `git status` 确认没有 `.DS_Store`、临时脚本或无关杂物；不提交任何账号信息、Cookie、Token 或游戏内隐私数据。

**发布 = 合并回 `main` → 推送 → 刷新 jsDelivr 缓存 → 确认生效**，后两步用 `scripts/release.sh` 一次做完：

1. 四处版本号一致（脚本会校验）；更新 README「功能一览」与首部「当前版本」。
2. 合并推送。
3. `scripts/release.sh`（每次推送都要跑）。参数：`--verify` 只校验版本与 jsDelivr 当前状态；`--no-wait` 发完刷新请求就退出。
   - 脚本做的事：校验四处版本 + 两个文件 `node --check`（当前分支不是 `main` 时给警告）→ 刷新 jsDelivr 上两个文件的缓存 → 轮询 `@main` 直到返回新版本。
   - **两个目标缺一不可**：只刷 `.meta.js` 会出现「提示有新版本、点安装下来还是旧的」。
   - 刷新方式：`GET https://purge.jsdelivr.net/gh/Billdex/eclesiar-helper@main/<文件名>`，无需密钥，返回 `"status": "finished"` 即成功。
   - **顺序不能反**：先 push 再 purge（purge 回源到 GitHub raw，raw 自己有 `max-age=300`），刷不到时脚本会重试，实在不行过几分钟再跑 `--verify`。
   - **镜像不主动刷新**：JSDMirror 两个域名与 GitHub raw 等自身缓存过期追上；落后只影响手工安装 / 备用检查，不影响自动更新。发现镜像长时间落后只记录现象，不新增刷新流程。
4. 对外分享统一发**安装地址**，不要发仓库首页：首选 jsDelivr 的 `.user.js`，国内打不开时给 JSDMirror 镜像（`raw.githubusercontent.com` 在国内多被拦截，只作最后备用）。文案模板见 README 的「分享给朋友」。
5. **不要**把 `@updateURL` / `@downloadURL` 改成 tag 或 commit 地址：更新地址写死在已安装副本里，指向不可变引用会让该版本永远「已是最新」、之后再也收不到更新。tag / commit 只用于「安装更新」链接与发版自检。

## 8. 测试清单

提交前至少：

1. 两个文件都过 `node --check`。
2. 外壳：悬浮球可拖、点击开合、`Alt+E`、`Esc`（焦点在面板内）、方向键切标签；视口缩到 360 宽时球与面板都不出屏。
3. 生命周期：控制台执行 `EclesiarHelper.destroy()`，宿主、API、监听器、定时器与页面注入都消失；无残留请求。
4. 汇率：展示与排序符合 §2.3（最优价徽标、目标额度结果、深度不足时的均价、加载中不排序、结束后按买入均价升序）；国籍 / 所在国置顶两行不重复、同币合并、读不到账号时有提示且凭据晚到后自动补上；目标口径切换不发请求、清空输入不立刻回填；`destroy()` 后无残留订阅。
5. 市场：采购口径 = 挂单价 × 买币最优价（不加进口税）；销售 = 挂单价 ×（1 − 增值税 − 进口税）× 卖币最优价，本国免进口税、读不到国籍两项都扣；缺税率 / 缺买单 / 换汇深度不足都有标注；切商品或切采购销售不重新请求；流亡政府单列且名次 `—`、不抢最优；领土只对有挂单的国家查、5 分钟缓存，查不到按「有领土」处理。
6. 设置与更新：同版本「已是最新」，更高版本出现「安装更新」且指向 jsDelivr；四个源全失败时保留三个手动安装链接；`meta.js` 与主脚本 `@version` 一致。
7. API 密钥：无密钥时可生成并显示掩码；有密钥时「汇率 / 市场」请求头用 `Bearer eclesiar_prod_…`（`/account/getuser` 与 `/account/apikey/usage` 例外，必须用登录凭据）；密钥 401 时只提示失效、不丢登录凭据；「移除密钥」回到登录凭据；「清除本地设置」不删密钥；用量只在进入设置页时请求一次。
8. `marketBadge`：市场页每行起价下有「≈ + 金币 + 金额」，与采购同口径；抓过行情后补「比全球最低贵多少」（`+0.0078` / `最低`）；切品类 / 品质 / 国家后每行仍只有一个标注（单行、单品质时也要有）；上架表单「实收金额」旁金价用所在国币种与卖币方向，实时更新，且**不打开面板也能出现**；离开市场页后 `[data-eh-gold]` 归零；设置页「功能开关」即时生效；没凭据时静默不标。
9. `goodsAuto`：开关在设置页「功能开关」；默认关闭；点「取消」不落盘不发请求，点「仍然开启」才写入并立刻抓一轮；开启后启动约 3 秒开始抓，市场页不打开面板也显示对比；10 分钟内不重复拉，后台标签页不刷新，失败退避 5 分钟；与面板共用同一份 `goodsSnapshot`；关掉后不再自动刷新但已抓到的标注保留；`destroy()` 后无定时器与请求残留。
10. 跳转：点箭头能到 `/monetary-market/{currency_id}` 与 `/market/{country_id}`；落地后按意图点中分类与 Q1–Q5（要先展开「筛选」），点完清掉 `sessionStorage` 意图；同类页面只换 id 时走 detour（不刷新、历史不多一条 dashboard、后退回原页），失败才整页跳；找不到控件 10 秒后放弃，不弹错。
11. `regionJump`：只在「你当前不在该国家」时出现，按钮数与该国地区数一致；离开市场页后 `[data-eh-regions]` 归零；同一国家 5 分钟内不重复请求；流亡政府显示「该国已失去全部领土」；无凭据时静默、`onAuth` 后自动补；设置页「功能开关」即时生效。
12. 工业：打开即自动抓一轮并列出全服地区（3 并发 + 60ms 间隔），状态栏显示地区数 / 国家数 / 更新时间；默认综合排序符合 §2.3；排序标签只有综合 / 物产 / 污染 / NPC，方向记在本地；搜索按地区名 / 中英文国名 / 法币过滤且不触发游戏快捷键；子标签栏与排序 / 状态不随列表滚、不多出色带；与市场页领土检查、`regionJump` 共用 `regionFeed`；无凭据时不发请求。
13. 税费：先汇率后领土（复用缓存），状态栏分阶段提示；行内两行分组不被拆开；排序标签顺序与行内一致且无悬浮说明；默认综合先比增值税 + 进口税、同值比最低工资税金、再比进口税、最后国名；缺汇率行永远最后；顶部固定、只有列表滚；搜索按中英文国名 / 法币过滤且不触发游戏快捷键；国籍 / 所在国就地高亮不置顶；流亡政府单列；切子标签再回来不重新请求。
