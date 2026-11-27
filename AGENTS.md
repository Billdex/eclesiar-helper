# AGENTS.md

本文件给在本仓库工作的 AI 代理与协作者使用，只记录项目特有约定；通用工作原则沿用全局配置（`~/.dsh/AGENTS.md`）。

## 1. 项目定位

- 目标：为多人在线经济 / 政治模拟游戏 Eclesiar（<https://app.eclesiar.com/>）提供 Tampermonkey 用户脚本。
- 现状：**v0.2.1**（走 GitHub 仓库分发，下载与更新走 JSDMirror 镜像，jsDelivr 与 GitHub raw 备用）——外壳（悬浮球 + 面板 + 功能注册表 + SPA 路由钩子）+ 业务模块「汇率总览」（拉取全球法币挂单、算最优价与目标额度加权均价，内置中文国名 / 国旗，逐行加载进度；目标额度可在黄金 / 法币之间切换，列表顶部置顶玩家国籍与当前所在国的汇率，各自配色 + 标签，数据来自 `playerFeed`）与「商品比价」（两行图标按钮点选成品 / 原材料、成品再选 Q1–Q5；「采购」按黄金单价从低到高，「销售」扣增值税 / 进口税后按卖币换金汇率算出税后收入并从高到低，国籍固定取 `POST /account/getuser`）。两者共用 `fxFeed` 这一份汇率缓存，销售模式还会额外读一次 `countries` 的 `laws` 税率。商品行情由全局 `goodsSnapshot` 持有（抓取 / 去重 / 10 分钟 TTL / 抓完 `publish` 给 `goodsFeed`），面板「商品」页与自动比价共用。地区清单由全局 `regionFeed` 持有（按国家缓存 5 分钟、并发共享同一个请求），商品比价的领土检查、`regionJump` 与「工商」页共用。「工商」是工商类数据的入口，目前只挂一个「工业」子面板：拉全服所有国家的地区，按国旗 / 地区 / 资源产区 / 工业区 / 物产 / 污染度 / NPC 列成可排序的表（默认「三项齐全优先，同级按（工业区 + 资源产区 + 物产加成）× 污染扣减」）；手动排序只给综合 / 物产 / 污染 / NPC（产区与工业区最高 5 级，单独排序区分度太低），每行右侧走 `route.goto('/region/{region_id}')`；子面板由 `registerBusinessPane()` 注册，后续加子面板只往 `businessPanes` 里加一项。「设置」页负责专用 API 密钥管理（生成 / 粘贴 / 移除，优先于登录 JWT 用于插件查询）、版本检查与更新入口。「商品」页底部另有默认关闭的「自动展示商品比价」（`goodsAuto`：开启后启动即预抓全球汇率与商品行情、按 TTL 自动更新，使市场页不打开面板也能显示全球最低价对比）。另有 `marketBadge` 模块在游戏自己的商品市场页每行起价下追加折算金价，并在上架表单的「实收金额」右侧追加税后折算金价；`regionJump` 模块只在该页出现「你当前不在该国家」提示时，把该国的地区列成按钮，点一下 `route.goto('/region/{region_id}')`（两者是仅有的会写游戏 DOM 的模块，规则见硬约束 2）。`route.goto` 负责跳到游戏内页面（`/market/{country_id}`、`/monetary-market/{currency_id}`，会自动补当前路径首段的语言前缀，如 `/zh-CN/market/12`），优先 SPA 内切换、失败退回整页跳；`marketJump` 在落地后按 `sessionStorage` 里的意图点一次游戏自己的分类（食物 / 武器 / 票券 / 原材料——游戏只有这四类，飞机归「武器」、机票归「票券」、四种原材料归「原材料」）与 Q1–Q5 品质筛选（规则见硬约束 5）。同一路由只换 id（`/market/17` → `/18`、`/monetary-market/2` → `/3`）时游戏不会重新渲染，`route.goto` 会走 `detour`：先 push 到 `/{语言}/dashboard` 把当前页卸掉，用节点增删判断 dashboard 已经画出来（正常一百多毫秒，600ms 兜底）后立即 `replaceState` 到目标（两段都是结构变化，路由都会重渲染，全程不刷新，中转页也不留在历史里）；两段里任一段没生效才整页跳。
- 非官方工具：不修改游戏数据、不自动操作，遵守游戏规则。
- 文档：`README.md` 面向玩家（安装 / 扩展），官方 Wiki 为 <https://wiki.eclesiar.com/>。

## 2. 硬约束

1. **单文件交付**：唯一安装产物是 `eclesiar-helper.user.js`。不要引入构建链、包管理器或运行时依赖；确有需要先征得用户同意。仓库里另有一个 `eclesiar-helper.meta.js`，只放元数据（供油猴 `@updateURL` 只拉版本号），它不是安装产物，内容必须与主脚本头部保持一致。
2. **UI 全在 Shadow DOM**：新增界面挂在 `dom.shadow` 内，样式写进 `STYLES`（`eh-` 前缀）。不要直接往游戏页面插 DOM / CSS。
   - 例外之一是 `marketBadge` 的页面标注：只允许在商品市场列表的价格单元格、上架表单「实收金额」所在横排里**追加**带 `data-eh-gold` 标记的只读节点（文字 + 金币图标，内联样式，不注入全局 CSS），不得改动游戏原有节点、文本、按钮与事件，不得接管点击；必须能被开关与 `destroy()` 完整移除。
   - 例外之二是 `regionJump` 的地区快捷入口：只在 `/market/{country_id}` 页、且页面上出现游戏自己的「你当前不在该国家」横幅时，才把一个小宿主节点（`data-eh-regions`）插在横幅之后；没有这条横幅（玩家就在该国）时不显示。界面与样式全部在该宿主的 Shadow DOM 里，只放插件自己的按钮，不改游戏原有节点、文本与事件；按钮只调用 `route.goto('/region/{region_id}')`，不提交表单、不下单。离开市场页、关掉开关或 `destroy()` 时必须整块移除。
   - 其它任何页面级注入都视为违规，先改本节再动手。
3. **资源必须可回收**：监听器用 `on(...)` 注册；功能内的定时器、订阅用 `ctx.onDestroy(...)` 登记。新增资源时同步检查 `destroy()` 是否覆盖。
4. **不碰账号与隐私**：不读取或上报 Cookie、Token、账号信息；日志不打印玩家数据。计算只在本地进行。登录 JWT 只从游戏自己发往 `api.eclesiar.com` 的请求头里捕获，仅存内存，不写 `localStorage`、不打印、不上报；不要扩展到读取 Cookie 或任何其它凭据。唯一允许读的账号字段是国籍 id（`nationality.id` / `nationality_id`，用于「销售」判断本国免进口税）与当前所在国家 id（`region.country.id`，用于确定上架表单按哪国本币计价折算金价），且只存内存、不展示原值、不落盘、不打日志；其余字段一律不读。两者统一走 `playerFeed`，缓存 2 分钟，两个模块共用一次请求。账号信息固定用 `POST /account/getuser`（当前登录账号；`/account` 是按 `account_id` 查指定用户，不要用）。该接口只认游戏登录凭据（带专用密钥会 401），必须传 `{ login: true }`，不能用专用密钥；`getuser` 响应里带 `bearer`，必须忽略，绝不能存或打印。唯一允许落盘的是玩家在「设置」页主动生成 / 粘贴的**专用 API 密钥**（`eclesiar_prod_…`，存 `localStorage` 的 `api-key`）：插件请求一律优先用它，避免占用玩家游戏内的每日查询额度；仍不得打印完整密钥、不得把它发给任何第三方。另允许在 `sessionStorage` 存两类非敏感数据：`eh:market-intent`（跳转意图：国家 id、商品 api、品质、时间戳，10 分钟过期，消费后立即删除）与 `eh:debug`（地址上出现过 `eh-debug=1` 后置 1，用于 SPA 跳转丢掉 query 后继续打印调试日志）。两者都不含账号信息、不跨会话，不得扩展成其它持久化。
5. **不做影响公平性的自动化**：不自动点击、提交表单、循环请求接口、多开或绕过验证；只做展示、计算与用户主动触发的辅助（例如玩家点按钮生成插件专用 API 密钥）。
   - 唯一例外：「自动展示商品比价」（`goodsAuto`，`localStorage` 键 `autoCompare`，**默认关闭**）。必须由玩家在「商品」页勾选并在明确提示「一轮上百次请求、可能拖慢启动并消耗额度」后点「仍然开启」才生效；只读公开行情、不写游戏数据；按 `GOODS_CACHE_MS`（10 分钟）过期才重拉、只在前台标签页跑、失败退避 5 分钟、可随时关闭。新增其它周期性请求一律视为违规。
   - 例外之二：`marketJump`。只在玩家从面板点「去市场」之后运行：跳到 `/market/{country_id}` 后，读 `sessionStorage` 里的意图，点一下游戏自己的商品 / 品质筛选按钮（只认文本或图标 `alt` 完全相等的可点控件——`button` / `role=button|tab|option` / `cursor:pointer`，带 `href` 的链接一律不点，最多重试 10 秒，点不到就放弃并清掉意图），不提交表单、不下单、不轮询。已经在同类页面、只换国家 / 币种时，只做两段 history 跳转（先 `/dashboard` 再目标，不点击游戏里的任何控件、不碰金额与买卖按钮），失败才整页刷新。玩家没点跳转时任何情况下都不执行。
6. **扩展只走功能注册表**：新模块用 `features.register()`，不要改面板外壳或硬编码标签页。
7. **版本号四处同步**：`eclesiar-helper.user.js` 的 `@version`、`eclesiar-helper.meta.js` 的 `@version`、`const VERSION`、`README.md` 的「当前版本」。
8. **更新源地址固定**：`@updateURL` / `@downloadURL` / 设置页的「安装更新」都走 JSDMirror `https://cdn.jsdmirror.com/gh/Billdex/eclesiar-helper@main/…`（`CDN_RAW`；与 jsDelivr 路径完全兼容的国内镜像，解析到国内多线节点，分支缓存约 5 分钟）。备源顺序固定为 `cdn.jsdelivr.net`（`JSDELIVR_RAW`）→ `cdn.jsdmirror.cn`（`CDN_MIRROR_RAW`，同镜像的备用域名）→ `raw.githubusercontent.com`（`REPO_RAW`）。设置页的版本检查对 `UPDATE_META_URLS` 里的源**并行**请求并取最高 `@version`（带 `eh_t` 时间戳绕开 CDN 缓存），所以单个源缓存落后不会漏更新；油猴只支持一个 `@updateURL`，自动更新通道只能有一个，改主源要清楚这一点。改名或迁移仓库时这几处（含 `REPO_URL` / `CDN_RAW` / `JSDELIVR_RAW` / `CDN_MIRROR_RAW` / `REPO_RAW` / `UPDATE_META_URLS` / `UPDATE_INSTALL_URL` / `UPDATE_INSTALL_JSDELIVR` / `UPDATE_INSTALL_FALLBACK`、README 里的安装链接）必须一起改，否则老版本收不到更新。

## 3. 目录

```
eclesiar-helper/
├── eclesiar-helper.user.js   # 脚本本体（唯一安装产物）
├── eclesiar-helper.meta.js   # 只有元数据，供油猴检查更新（@updateURL 指向它）
├── README.md                 # 给玩家看的安装 / 扩展文档
└── AGENTS.md
```

## 4. 常用命令

```bash
node --check eclesiar-helper.user.js   # 语法检查
node --check eclesiar-helper.meta.js   # 元数据文件语法检查
```

调试日志：游戏页地址后加 `?eh-debug=1`，控制台会输出插件日志。

仓库里不提供测试页。需要假数据时，自己在 `dev/`（已被 git 忽略）里写一个替换 `window.fetch` 的本地页面，验证完即弃，不入库。

## 5. 代码组织

`eclesiar-helper.user.js` 内按以下顺序分节，新增代码放到对应区段，不要打乱：

1. 常量与工具
2. 状态
3. 样式（`STYLES`）
4. 外壳（`createShell` / 兜底样式）
5. 悬浮球（定位 / 拖拽 / 点击）
6. 面板（定位 / 开合 / 标签页）
7. 路由钩子（`route`：包装 `pushState` / `replaceState`、订阅变化，并用 `goto(path)` 跳转到游戏内页面）
   - 游戏是 React Router（`window.__reactRouterVersion`），跳转必须把 `history.state.idx` 加一再 `pushState`，否则它认为 idx 没变、直接忽略这次 `popstate`，页面不会重渲染。
   - 同一个路由只换 id（`/market/17` → `/18`、`/monetary-market/2` → `/3`）时组件不会重新挂载，`pushState` 后地址变了页面不动；`goto` 对这类走 `detour()`：先 push 到 `/{语言}/dashboard` 把当前页卸掉，MutationObserver 数到 30 个节点增删（或 600ms 兜底）就立刻 `replaceState` 到目标。两段都是结构变化，路由都会重渲染，中转页也不留在历史里。换完不再回头校验 URL（目标若是玩家所在国，游戏会自己把地址改成 `/market`，校验会误判成失败再刷一次）。结构变化的跳转（`/market` → `/market/17`、市场 ↔ 货币市场）直接 `pushTo()` 走 SPA。
8. 对外 UI 控制（`publicUi`）
9. 内置功能（`fx` / `goods`（含 `goodsSnapshot` 行情快照、`regionFeed` 地区缓存与 `goodsAuto` 自动比价）/ `marketBadge` 页面标注 / `regionJump` 市场页地区快捷入口 / `marketJump` 跳转意图消费 / `business`（工商：子面板注册表 `registerBusinessPane` + 工业列表）/ `about`，版本检查也在这里）
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

1. 两个文件都过 `node --check`。
2. 装到 Tampermonkey 后进 `app.eclesiar.com`：悬浮球可拖、点击开合、`Alt+E`、`Esc`（焦点在面板内）、方向键切标签；视口缩到 360 宽时球与面板都不出屏。
3. 改过生命周期时，控制台执行 `EclesiarHelper.destroy()`，确认宿主与 API 都消失。
4. 改过「汇率」：最优价与均价和手算一致；每行两个方向各一行（徽标是最优价，后面是这笔目标额度的成交结果；吃满多档时行尾补「均价」，均价与最优价只差一档时不重复显示；吃不满时徽标直接换成成交均价并在前面标「均价」，行尾只留「深度不足」与实际成交金数，不再重复写均价）；逐行转圈随数据到达消失，无挂单的行被移除；没捕获到凭据时给出提示。目标口径：输入框左侧的口径标签本身就是切换按钮（文字 + 切换图标，与输入框同在一个胶囊里，不再有独立的切换按钮），点一下从「目标黄金」变「目标法币」再点回去，输入框里的数字不变（只有 `fx:target` 一个值，默认 10；`fx:mode` 记当前口径），切换后立即按新口径重算整张列表且不发请求，再切回来数字仍是原值；清空输入框时不要立刻把 10 填回去（可以留着空继续输入，列表保持上一次的有效额度），只有失焦 / 回车 / 切口径才补回上一次的有效值；按法币算时每个方向显示「换够这么多单位需要 / 得到多少黄金」，黄金数改用 `fxGold` 保留位数，吃不满标「深度不足」并显示实际成交量；切回黄金口径排序恢复正常。置顶：列表上方固定两行（国籍在上、当前所在国在下，同一种货币合并为一行并标「玩家国籍 · 当前位置」），两国额度不同时用不同配色 + 「玩家国籍」「当前位置」标签；这两行在全球列表里不重复出现；读不到账号时原位提示（无凭据与读不到国籍文案不同），凭据晚到（`market.onAuth`）后自动补上；行情没拉过时显示「未加载」而不是「暂无卖单」；点刷新 / 一轮行情结束会重新读一次（`playerFeed` 2 分钟缓存）；`destroy()` 后无残留订阅。
5. 改过「商品」：玩家当前所在国的行换橙色配色，国名后标「当前位置」；销售模式下国籍国在国名后标「玩家国籍」，两者重合时合成一个标签「玩家国籍 · 当前位置」；国名后另有英文国名（窄面板截断），货币代码只出现在下方数据行；第一名绿色、当前所在国橙色，两者重合时橙色底 + 绿色描边。采购的黄金单价 = 挂单价 × 买币最优价（不叠加进口税）；缺换汇挂单的货币排最后并标注；切商品 / 切采购销售不重新请求；选择区是两行图标按钮（成品 / 原材料），品质行只在选中成品时出现；商品图标缺图时退回内置 emoji。销售：税后价 = 挂单价 ×（1 − 增值税 − 进口税），再乘卖币最优价（买单方向，与采购相反）；国籍自动读取（`POST /account/getuser`，取 `nationality.id` 或 `nationality_id`），本国免进口税、拿不到国籍时两项都扣；最显眼的是税后金价，其次一行先写税前金价再写税率，不重复税后；商品市场只有卖单，不显示「可卖数量」；排序按税后从高到低；缺税率标「按 0 税估算」，缺买单标「暂无换汇买单」，买盘连 1 件所得都吃不下标「换汇深度不足」；`countries` 与 `POST /account/getuser` 只在进入销售时各请求一次。领土：`GET /country/regions?country_id=…` 没有 `data`（真实接口对无领土国家只回 `{ code: 200, description: '成功' }`）或返回空数组 = 已失去全部领土（流亡政府，玩家到不了），`call` 需传 `allowEmpty` 才不把「无 data」当成坏载荷；这些国家从主列表剔除、单独放到最底部「流亡政府」一栏并说明原因，栏内仍按同一套规则排序但名次显示 `—`、不抢「最优」高亮；领土只对有挂单的国家查、结果按国家缓存 5 分钟，查不到时按「有领土」处理（只在 `?eh-debug=1` 的日志里记录，不上状态栏）；该接口只发 GET（同地址 POST 是 404，`call` 要传 `noMethodRetry` 挡掉「GET 失败改 POST」的兜底）。
6. 改过「设置」或版本检查：同版本显示「已是最新」、`@version` 更大时出现「安装更新」且链接指向 JSDMirror 上的 `.user.js`、所有源都失败时显示提示并保留三个手动安装链接（JSDMirror / jsDelivr / GitHub）；顺手确认 `eclesiar-helper.meta.js` 的 `@version` 与主脚本一致。
7. 真实环境：从 `@downloadURL` 安装后刷新游戏，确认悬浮球出现、面板正常，「设置」页能读到仓库里的版本号。
8. 改过「设置」的 API 密钥：没有密钥时按钮能生成并立即显示掩码；有密钥时「汇率 / 商品」发出的请求头带的是 `Bearer eclesiar_prod_…` 而不是登录 JWT（`/account/getuser` 例外，只认登录凭据）；密钥被拒（401）时只提示密钥失效、不丢登录凭据；「移除密钥」后回到登录凭据；「清除本地设置」不删除密钥。使用专用密钥时进入「设置」页会请求一次 `/account/apikey/usage` 并显示已用 / 上限、剩余与距 UTC 零点重置的倒计时（本地每分钟刷新，请求不轮询），切走再回来或重开面板只多请求一次；没有密钥时不发这个请求。注意：该接口只认游戏登录凭据，必须用 `{ login: true }` 发请求，不能用专用密钥。
9. 改过 `marketBadge`（市场列表金价标注）：进游戏「商品市场」页，确认每行起价下出现「≈ + 金币图标 + 金额」且与「商品比价」同口径（挂单价 × 买币最优价，悬停可看乘式）；打开面板「商品」页抓取一次后，市场页每条标注应补上「比全球最低贵多少」（`+0.0078` 这类绝对金数，全球最低或差额不足 0.5% 时显示`最低`），数值 = 本行金价 − 全球最低金价，全球最低取 `goodsFeed.bestGold()`（跳过流亡政府、缺汇率的国家），没抓过行情时不显示这段、不自动发起抓取（「自动展示商品比价」开启时除外，见第 10 条）；切品类 / 切品质 / 换国家后重渲染仍每行只有一个标注、不重复叠加（某品质只剩 1 件商品、列表只有一行时也要标，且从单行切回多行后不能只剩第一行有标注）；离开市场页（含 SPA 前进后退到其它页面）后 `document.querySelectorAll('[data-eh-gold]').length` 归零；面板「商品」页的开关能即时摘掉 / 恢复标注并写进 `localStorage`；`EclesiarHelper.destroy()` 后页面无残留标注与观察器；没捕获到凭据时静默不标（只在 `?eh-debug=1` 日志里留记录），不重复打接口。上架表单：进「商品市场」→「我的报价」点开「上架物品」并选中商品，调整单价 / 数量后「实收金额」右侧应出现（并实时更新）「≈ + 金币图标 + 金额」，口径 = 实收金额 × 卖币换金最优价（买单方向，和列表行的买币口径相反），币种取 `playerFeed` 的 `region.country.id` 对应货币（页面右上的「货币市场 · XXX」只是购买页的余额按钮，**不能**当上架币种用）；**必须自己主动加载**——不打开插件面板、不点「刷新行情」也要能出来（面板是点击才插进 DOM 的，靠 `addedListingAnchor` 认到「单价」输入框后重扫；热身重试要等两类标注都画出来才停），收起再展开、隔一分钟再展开都要能恢复；同一行只允许一个标注；开关与列表行共用；离开商品市场页后 `document.querySelectorAll('[data-eh-gold]').length` 归零；拿不到所在国家时静默跳过（不弹提示、不重复打 `/account/getuser`）。
10. 改过「自动展示商品比价」（「商品」页底部开关）：**只影响游戏市场页的自动比价，面板「商品」页始终自己抓取**（关掉开关后打开面板仍应正常拉数据，凭据晚到时由 `goodsSnapshot` 的 `armAuthRetry` 在 `market.onAuth` 后自动补一轮，不需要玩家手动点刷新）；默认关闭且关闭时不显示任何说明文字；勾选后先出短提示与「仍然开启 / 取消」，点「取消」不落盘也不发请求，点「仍然开启」才写入 `autoCompare` 并立刻抓一轮；重新打开面板 / 切回「商品」页勾选状态与 `localStorage` 一致。「清除本地设置」把开关复位为关闭并停掉定时器。开启后刷新游戏页，约 3 秒后开始拉国家清单、汇率挂单与各国市场（未捕获凭据时不动，`market.onAuth` 后再补）；市场页**不打开面板**也要出现「+0.0078 / 最低」；10 分钟内再进市场页不重复拉，过期后自动重拉；切到后台标签页不刷新；抓取失败（429 / 网络）后 5 分钟内不再自动重试；面板「商品」页与自动比价共用 `goodsSnapshot`（面板里能看到同一轮的进度与「更新于」，不会两套数据）；关掉开关后不再自动刷新但本轮已抓到的标注保留；`EclesiarHelper.destroy()` 后无定时器与请求残留。
11. 改过跳转（`route.goto` / `marketJump`）：在「汇率」点某行右侧箭头，地址应变成 `/monetary-market/{currency_id}` 并渲染出该货币页（SPA 内切换时面板收起、行情缓存仍在；整页跳那一档也要能到达）；在「商品」点某行箭头，落到 `/market/{country_id}`，插件按类别映射（食物/武器/票券/原材料）点中对应分类按钮、再点 Q1–Q5 品质按钮（都是 `button`，文本完全等于分类名与 `Q{n}`；注意市场页默认收起「筛选」，这两个按钮藏在里面，要先点一下「筛选」展开；顶栏资源位里也有「食物」这类文字 / 图标，所以查找只认 `button`/`role`/`li` 的精确文本，不认 `div`/`span`；游戏没有单品级筛选）；切完 `sessionStorage` 里的意图被删除、刷新不再重复点击；已经在市场页时再点另一个国家，应走「先 `/dashboard` 再目标」的中转（不刷新、`window.EclesiarHelper` 仍存在，最终 URL 是 `/market/{新 id}`；历史里不多一条 dashboard，按后退回到原市场页）；货币市场页同理（实测 `/monetary-market/2` → `/45` 从 GBP 直接换成 AUD）；中转没生效时自动退回整页跳，不能出现「点了没反应」；找不到控件时 10 秒后放弃并清参（`?eh-debug=1` 会打印页面上识别到的可点文案），不弹错、不反复打扰页面；`EclesiarHelper.destroy()` 后无残留定时器。
12. 改过 `regionJump`（市场页地区快捷跳转）：进 `/market/{非所在国 id}`，确认「你当前不在该国家」提示下方出现「地区」一行，按钮数量与该国 `GET /country/regions` 返回一致；该提示不存在时不显示（把横幅删掉后宿主应被移除），页面其它位置（如表头）也不会出现入口；点一个按钮地址变成 `/{语言}/region/{id}`，离开市场页后 `document.querySelectorAll('[data-eh-regions]').length` 归零；同一国家 5 分钟内来回进出不重复请求；已失去全部领土的流亡政府显示「该国已失去全部领土」；没有凭据时静默不出现、`market.onAuth` 后自动补上；切品类 / 切品质 / 换国家后仍只有一行、不重复叠加；面板「商品」页的开关能即时摘掉 / 恢复并写进 `localStorage`；`EclesiarHelper.destroy()` 后无残留宿主与观察器。
13. 改过「工商 / 工业」：打开面板「工商」页，子标签「工业」应自动抓一轮并列出全服所有地区（`GET /country/regions?country_id=…`，53 个国家约 53 次请求，3 并发 + 60ms 间隔），状态栏显示「N 个地区 · M 个国家 / 更新于 hh:mm:ss」；每行有国旗、地区名、所属国、资源产区 / 工业区等级、物产（`bonus` 的 `type` + `value`）、污染度、NPC 数量（行内不显示排名序号），箭头放在标题行最右侧（行内元素，不用绝对定位）、跳到 `/region/{region_id}`；子标签栏不随列表滚动（工商页自己开一层滚动，只有列表滚），且不能多出一条色带；默认「综合」排序符合「三项齐全 > 有工业区 + 资源产区 > 只有工业区 > 只有资源产区 > 其余，同级按（工业区 + 资源产区 + 物产加成）×（1 − 污染%）降序」；排序标签只有综合 / 物产 / 污染 / NPC，点「污染」先按低到高、再点一次反过来；「物产」先按加成总和、总和相同再按主物产（最高加成那一项）聚拢，同类产地不被打散、也不会出现 30% 的谷物排到 5% 的铁后面；其余列同理，切换后刷新页面仍是同一列同一方向（`localStorage` 里的 `eclesiar-helper:business:industry:sort`）；「刷新地区」会重抓一轮；地区清单与「商品」的领土检查、`regionJump` 共用 `regionFeed`（先开商品再开工业、或反过来，5 分钟内同一国家只请求一次）；没有凭据时状态栏给提示、不显示空列表说明、不发请求，`market.onAuth` 后自动补一轮；`EclesiarHelper.destroy()` 后无残留请求与渲染。

## 8. Git 约定

- 默认分支 `main`；提交信息用中文 + 类型前缀：`feat:` / `fix:` / `docs:` / `chore:`。
- 一次提交只做一件事；提交前 `git status` 确认没有 `.DS_Store`、临时脚本或无关杂物。
- `dev/` 已被 git 忽略（本地调试页）；提交前确认没有混入截图、临时页面等杂物，也不要强制把它们加进版本库。
- 不提交任何账号信息、Cookie、Token 或游戏内隐私数据。

## 9. 发布

1. 修改 `eclesiar-helper.user.js` 的 `@version`、`eclesiar-helper.meta.js` 的 `@version`、`const VERSION`，同步 README 的「当前版本」。
2. 更新 README 的能力表 / 说明。
3. 提交并推送到 `main`（`updateURL` / `downloadURL` 都指向 JSDMirror 的 `main` 分支地址，推送后老版本即可在下次检查时看到更新）。
4. JSDMirror 的分支缓存只有 `max-age=300`，等 5 分钟就会自然过期，**不需要 purge**；发布后确认两端都已拿到新版本：
   ```bash
   curl -s "https://cdn.jsdmirror.com/gh/Billdex/eclesiar-helper@main/eclesiar-helper.meta.js" | grep '@version'
   curl -s "https://cdn.jsdelivr.net/gh/Billdex/eclesiar-helper@main/eclesiar-helper.meta.js" | grep '@version'
   ```
   jsDelivr 那份是备用源（分支 `s-maxage=43200`，最长 12 小时），要让它也立刻更新就调一次它的 purge 接口（回源到 GitHub raw，raw 自己还有 `max-age=300`，拿到的可能仍是旧文件，过几分钟再 purge 一次）：
   ```bash
   curl -s "https://purge.jsdelivr.net/gh/Billdex/eclesiar-helper@main/eclesiar-helper.meta.js"
   ```
   顺手也确认一下 JSDMirror 返回的 `.user.js` 与本地一致：`curl -s <镜像地址> | md5`（Windows 用 `certutil -hashfile` 比对）。
5. 对外分享统一发**安装地址**，不要发仓库首页：首选 `https://cdn.jsdmirror.com/gh/Billdex/eclesiar-helper@main/eclesiar-helper.user.js`，备用 `https://cdn.jsdelivr.net/gh/Billdex/eclesiar-helper@main/eclesiar-helper.user.js`（`raw.githubusercontent.com` 在国内多被拦截，只作为最后备用）。文案模板见 README 的「分享给朋友」。
6. 本地调试也可以把 `.user.js` 全文粘贴进 Tampermonkey 覆盖。
