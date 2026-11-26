# AGENTS.md

本文件给在本仓库工作的 AI 代理与协作者使用，只记录项目特有约定；通用工作原则沿用全局配置（`~/.dsh/AGENTS.md`）。

## 1. 项目定位

- 目标：为多人在线经济 / 政治模拟游戏 Eclesiar（<https://app.eclesiar.com/>）提供 Tampermonkey 用户脚本。
- 现状：**v0.1.8**（走 GitHub 仓库分发，下载与更新走 jsDelivr 镜像）——外壳（悬浮球 + 面板 + 功能注册表 + SPA 路由钩子）+ 业务模块「汇率总览」（拉取全球法币挂单、算最优价与目标额度加权均价，内置中文国名 / 国旗，逐行加载进度；目标额度可在黄金 / 法币之间切换，列表顶部置顶玩家国籍与当前所在国的汇率，各自配色 + 标签，数据来自 `playerFeed`）与「商品比价」（两行图标按钮点选成品 / 原材料、成品再选 Q1–Q5；「采购」按黄金单价从低到高，「销售」扣增值税 / 进口税后按卖币换金汇率算出税后收入并从高到低，国籍固定取 `POST /account/getuser`）。两者共用 `fxFeed` 这一份汇率缓存，销售模式还会额外读一次 `countries` 的 `laws` 税率。商品行情由全局 `goodsSnapshot` 持有（抓取 / 去重 / 10 分钟 TTL / 抓完 `publish` 给 `goodsFeed`），面板「商品」页与自动比价共用。「设置」页负责专用 API 密钥管理（生成 / 粘贴 / 移除，优先于登录 JWT 用于插件查询）、版本检查与更新入口。「商品」页底部另有默认关闭的「自动展示商品比价」（`goodsAuto`：开启后启动即预抓全球汇率与商品行情、按 TTL 自动更新，使市场页不打开面板也能显示全球最低价对比）。另有 `marketBadge` 模块在游戏自己的商品市场页每行起价下追加折算金价，并在上架表单的「实收金额」右侧追加税后折算金价（唯一会写游戏 DOM 的地方，规则见硬约束 2）。
- 非官方工具：不修改游戏数据、不自动操作，遵守游戏规则。
- 文档：`README.md` 面向玩家（安装 / 扩展），官方 Wiki 为 <https://wiki.eclesiar.com/>。

## 2. 硬约束

1. **单文件交付**：唯一安装产物是 `eclesiar-helper.user.js`。不要引入构建链、包管理器或运行时依赖；确有需要先征得用户同意。仓库里另有一个 `eclesiar-helper.meta.js`，只放元数据（供油猴 `@updateURL` 只拉版本号），它不是安装产物，内容必须与主脚本头部保持一致。
2. **UI 全在 Shadow DOM**：新增界面挂在 `dom.shadow` 内，样式写进 `STYLES`（`eh-` 前缀）。不要直接往游戏页面插 DOM / CSS。
   - 唯一例外是 `marketBadge` 的页面标注：只允许在商品市场列表的价格单元格、上架表单「实收金额」所在横排里**追加**带 `data-eh-gold` 标记的只读节点（文字 + 金币图标，内联样式，不注入全局 CSS），不得改动游戏原有节点、文本、按钮与事件，不得接管点击；必须能被开关与 `destroy()` 完整移除。其它任何页面级注入都视为违规，先改本节再动手。
3. **资源必须可回收**：监听器用 `on(...)` 注册；功能内的定时器、订阅用 `ctx.onDestroy(...)` 登记。新增资源时同步检查 `destroy()` 是否覆盖。
4. **不碰账号与隐私**：不读取或上报 Cookie、Token、账号信息；日志不打印玩家数据。计算只在本地进行。登录 JWT 只从游戏自己发往 `api.eclesiar.com` 的请求头里捕获，仅存内存，不写 `localStorage`、不打印、不上报；不要扩展到读取 Cookie 或任何其它凭据。唯一允许读的账号字段是国籍 id（`nationality.id` / `nationality_id`，用于「销售」判断本国免进口税）与当前所在国家 id（`region.country.id`，用于确定上架表单按哪国本币计价折算金价），且只存内存、不展示原值、不落盘、不打日志；其余字段一律不读。两者统一走 `playerFeed`，缓存 2 分钟，两个模块共用一次请求。账号信息固定用 `POST /account/getuser`（当前登录账号；`/account` 是按 `account_id` 查指定用户，不要用）。该接口只认游戏登录凭据（带专用密钥会 401），必须传 `{ login: true }`，不能用专用密钥；`getuser` 响应里带 `bearer`，必须忽略，绝不能存或打印。唯一允许落盘的是玩家在「设置」页主动生成 / 粘贴的**专用 API 密钥**（`eclesiar_prod_…`，存 `localStorage` 的 `api-key`）：插件请求一律优先用它，避免占用玩家游戏内的每日查询额度；仍不得打印完整密钥、不得把它发给任何第三方。
5. **不做影响公平性的自动化**：不自动点击、提交表单、循环请求接口、多开或绕过验证；只做展示、计算与用户主动触发的辅助（例如玩家点按钮生成插件专用 API 密钥）。
   - 唯一例外：「自动展示商品比价」（`goodsAuto`，`localStorage` 键 `autoCompare`，**默认关闭**）。必须由玩家在「商品」页勾选并在明确提示「一轮上百次请求、可能拖慢启动并消耗额度」后点「仍然开启」才生效；只读公开行情、不写游戏数据；按 `GOODS_CACHE_MS`（10 分钟）过期才重拉、只在前台标签页跑、失败退避 5 分钟、可随时关闭。新增其它周期性请求一律视为违规。
6. **扩展只走功能注册表**：新模块用 `features.register()`，不要改面板外壳或硬编码标签页。
7. **版本号四处同步**：`eclesiar-helper.user.js` 的 `@version`、`eclesiar-helper.meta.js` 的 `@version`、`const VERSION`、`README.md` 的「当前版本」。
8. **更新源地址固定**：`@updateURL` / `@downloadURL` / 设置页的版本检查与「安装更新」都优先走 jsDelivr 镜像 `https://cdn.jsdelivr.net/gh/Billdex/eclesiar-helper@main/…`（国内可达）；`raw.githubusercontent.com` 只作为备用源（`REPO_RAW`、`UPDATE_INSTALL_FALLBACK`）。改名或迁移仓库时这几处（含 `REPO_URL` / `CDN_RAW` / `REPO_RAW` / `UPDATE_META_URLS` / `UPDATE_INSTALL_URL`、README 里的安装链接）必须一起改，否则老版本收不到更新。

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
7. 路由钩子
8. 对外 UI 控制（`publicUi`）
9. 内置功能（`fx` / `goods`（含 `goodsSnapshot` 行情快照与 `goodsAuto` 自动比价）/ `marketBadge` 页面标注 / `about`，版本检查也在这里）
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
4. 改过「汇率」：最优价与均价和手算一致；每行两个方向各一行（徽标是最优价，后面是这笔目标额度的成交结果，均价与最优价只差一档时不重复显示）；目标额度吃不满时显示实际成交金数并标注深度不足；逐行转圈随数据到达消失，无挂单的行被移除；没捕获到凭据时给出提示。目标口径：输入框左侧的口径标签本身就是切换按钮（文字 + 切换图标，与输入框同在一个胶囊里，不再有独立的切换按钮），点一下从「目标黄金」变「目标法币」再点回去，输入框里的数字不变（只有 `fx:target` 一个值，默认 10；`fx:mode` 记当前口径），切换后立即按新口径重算整张列表且不发请求，再切回来数字仍是原值；按法币算时每个方向显示「换够这么多单位需要 / 得到多少黄金」，黄金数改用 `fxGold` 保留位数，吃不满标「深度不足」并显示实际成交量；切回黄金口径排序恢复正常。置顶：列表上方固定两行（国籍在上、当前所在国在下，同一种货币合并为一行并标「国籍 · 当前所在国」），两国额度不同时用不同配色 + 「国籍」「当前所在国」标签；这两行在全球列表里不重复出现；读不到账号时原位提示（无凭据与读不到国籍文案不同），凭据晚到（`market.onAuth`）后自动补上；行情没拉过时显示「未加载」而不是「暂无卖单」；点刷新 / 一轮行情结束会重新读一次（`playerFeed` 2 分钟缓存）；`destroy()` 后无残留订阅。
5. 改过「商品」：采购的黄金单价 = 挂单价 × 买币最优价（不叠加进口税）；缺换汇挂单的货币排最后并标注；切商品 / 切采购销售不重新请求；选择区是两行图标按钮（成品 / 原材料），品质行只在选中成品时出现；商品图标缺图时退回内置 emoji。销售：税后价 = 挂单价 ×（1 − 增值税 − 进口税），再乘卖币最优价（买单方向，与采购相反）；国籍自动读取（`POST /account/getuser`，取 `nationality.id` 或 `nationality_id`），本国免进口税、拿不到国籍时两项都扣；最显眼的是税后金价，其次一行先写税前金价再写税率，不重复税后；商品市场只有卖单，不显示「可卖数量」；排序按税后从高到低；缺税率标「按 0 税估算」，缺买单标「暂无换汇买单」，买盘连 1 件所得都吃不下标「换汇深度不足」；`countries` 与 `POST /account/getuser` 只在进入销售时各请求一次。领土：`GET /country/regions?country_id=…` 没有 `data`（真实接口对无领土国家只回 `{ code: 200, description: '成功' }`）或返回空数组 = 已失去全部领土（流亡政府，玩家到不了），`call` 需传 `allowEmpty` 才不把「无 data」当成坏载荷；这些国家从主列表剔除、单独放到最底部「流亡政府」一栏并说明原因，栏内仍按同一套规则排序但名次显示 `—`、不抢「最优」高亮；领土只对有挂单的国家查、结果按国家缓存 5 分钟，查不到时按「有领土」处理（只在 `?eh-debug=1` 的日志里记录，不上状态栏）；该接口只发 GET（同地址 POST 是 404，`call` 要传 `noMethodRetry` 挡掉「GET 失败改 POST」的兜底）。
6. 改过「设置」或版本检查：同版本显示「已是最新」、`@version` 更大时出现「安装更新」且链接指向 jsDelivr 上的 `.user.js`、两个源都失败时显示提示并保留手动安装链接；顺手确认 `eclesiar-helper.meta.js` 的 `@version` 与主脚本一致。
7. 真实环境：从 `@downloadURL` 安装后刷新游戏，确认悬浮球出现、面板正常，「设置」页能读到仓库里的版本号。
8. 改过「设置」的 API 密钥：没有密钥时按钮能生成并立即显示掩码；有密钥时「汇率 / 商品」发出的请求头带的是 `Bearer eclesiar_prod_…` 而不是登录 JWT（`/account/getuser` 例外，只认登录凭据）；密钥被拒（401）时只提示密钥失效、不丢登录凭据；「移除密钥」后回到登录凭据；「清除本地设置」不删除密钥。使用专用密钥时进入「设置」页会请求一次 `/account/apikey/usage` 并显示已用 / 上限、剩余与距 UTC 零点重置的倒计时（本地每分钟刷新，请求不轮询），切走再回来或重开面板只多请求一次；没有密钥时不发这个请求。注意：该接口只认游戏登录凭据，必须用 `{ login: true }` 发请求，不能用专用密钥。
9. 改过 `marketBadge`（市场列表金价标注）：进游戏「商品市场」页，确认每行起价下出现「≈ + 金币图标 + 金额」且与「商品比价」同口径（挂单价 × 买币最优价，悬停可看乘式）；打开面板「商品」页抓取一次后，市场页每条标注应补上「比全球最低贵多少」（`+0.0078` 这类绝对金数，全球最低或差额不足 0.5% 时显示`最低`），数值 = 本行金价 − 全球最低金价，全球最低取 `goodsFeed.bestGold()`（跳过流亡政府、缺汇率的国家），没抓过行情时不显示这段、不自动发起抓取（「自动展示商品比价」开启时除外，见第 10 条）；切品类 / 切品质 / 换国家后重渲染仍每行只有一个标注、不重复叠加（某品质只剩 1 件商品、列表只有一行时也要标，且从单行切回多行后不能只剩第一行有标注）；离开市场页（含 SPA 前进后退到其它页面）后 `document.querySelectorAll('[data-eh-gold]').length` 归零；面板「商品」页的开关能即时摘掉 / 恢复标注并写进 `localStorage`；`EclesiarHelper.destroy()` 后页面无残留标注与观察器；没捕获到凭据时静默不标（只在 `?eh-debug=1` 日志里留记录），不重复打接口。上架表单：进「商品市场」→「我的报价」点开「上架物品」并选中商品，调整单价 / 数量后「实收金额」右侧应出现（并实时更新）「≈ + 金币图标 + 金额」，口径 = 实收金额 × 卖币换金最优价（买单方向，和列表行的买币口径相反），币种取 `playerFeed` 的 `region.country.id` 对应货币（页面右上的「货币市场 · XXX」只是购买页的余额按钮，**不能**当上架币种用）；**必须自己主动加载**——不打开插件面板、不点「刷新行情」也要能出来（面板是点击才插进 DOM 的，靠 `addedListingAnchor` 认到「单价」输入框后重扫；热身重试要等两类标注都画出来才停），收起再展开、隔一分钟再展开都要能恢复；同一行只允许一个标注；开关与列表行共用；离开商品市场页后 `document.querySelectorAll('[data-eh-gold]').length` 归零；拿不到所在国家时静默跳过（不弹提示、不重复打 `/account/getuser`）。
10. 改过「自动展示商品比价」（「商品」页底部开关）：**只影响游戏市场页的自动比价，面板「商品」页始终自己抓取**（关掉开关后打开面板仍应正常拉数据，凭据晚到时由 `goodsSnapshot` 的 `armAuthRetry` 在 `market.onAuth` 后自动补一轮，不需要玩家手动点刷新）；默认关闭且关闭时不显示任何说明文字；勾选后先出短提示与「仍然开启 / 取消」，点「取消」不落盘也不发请求，点「仍然开启」才写入 `autoCompare` 并立刻抓一轮；重新打开面板 / 切回「商品」页勾选状态与 `localStorage` 一致。「清除本地设置」把开关复位为关闭并停掉定时器。开启后刷新游戏页，约 3 秒后开始拉国家清单、汇率挂单与各国市场（未捕获凭据时不动，`market.onAuth` 后再补）；市场页**不打开面板**也要出现「+0.0078 / 最低」；10 分钟内再进市场页不重复拉，过期后自动重拉；切到后台标签页不刷新；抓取失败（429 / 网络）后 5 分钟内不再自动重试；面板「商品」页与自动比价共用 `goodsSnapshot`（面板里能看到同一轮的进度与「更新于」，不会两套数据）；关掉开关后不再自动刷新但本轮已抓到的标注保留；`EclesiarHelper.destroy()` 后无定时器与请求残留。

## 8. Git 约定

- 默认分支 `main`；提交信息用中文 + 类型前缀：`feat:` / `fix:` / `docs:` / `chore:`。
- 一次提交只做一件事；提交前 `git status` 确认没有 `.DS_Store`、临时脚本或无关杂物。
- `dev/` 已被 git 忽略（本地调试页）；提交前确认没有混入截图、临时页面等杂物，也不要强制把它们加进版本库。
- 不提交任何账号信息、Cookie、Token 或游戏内隐私数据。

## 9. 发布

1. 修改 `eclesiar-helper.user.js` 的 `@version`、`eclesiar-helper.meta.js` 的 `@version`、`const VERSION`，同步 README 的「当前版本」。
2. 更新 README 的能力表 / 说明。
3. 提交并推送到 `main`（`updateURL` / `downloadURL` 都指向 jsDelivr 的 `main` 分支地址，推送后老版本即可在下次检查时看到更新）。
4. 刷新 jsDelivr 缓存（分支地址是 `s-maxage=43200`，不刷新的话最多 12 小时仍返回旧文件）：
   ```bash
   curl -s "https://purge.jsdelivr.net/gh/Billdex/eclesiar-helper@main/eclesiar-helper.user.js"
   curl -s "https://purge.jsdelivr.net/gh/Billdex/eclesiar-helper@main/eclesiar-helper.meta.js"
   ```
   注意 purge 会回源到 GitHub raw，而 raw 自己也有 `max-age=300`：刚推完的 5 分钟内 purge 拿到的可能还是旧文件，等几分钟再 purge 一次。
5. 对外分享统一发**安装地址**，不要发仓库首页：首选 `https://cdn.jsdelivr.net/gh/Billdex/eclesiar-helper@main/eclesiar-helper.user.js`（`raw.githubusercontent.com` 在国内多被拦截，只作为备用链接）。文案模板见 README 的「分享给朋友」。
6. 本地调试也可以把 `.user.js` 全文粘贴进 Tampermonkey 覆盖。
