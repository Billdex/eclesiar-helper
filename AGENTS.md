# AGENTS.md

本文件给在本仓库工作的 AI 代理与协作者使用，只记录项目特有约定；通用工作原则沿用全局配置（`~/.dsh/AGENTS.md`）。

## 1. 项目定位

- 目标：为多人在线经济 / 政治模拟游戏 Eclesiar（<https://app.eclesiar.com/>）提供 Tampermonkey 用户脚本。
- 现状：**v0.1.4**（走 GitHub 仓库分发，下载与更新走 jsDelivr 镜像）——外壳（悬浮球 + 面板 + 功能注册表 + SPA 路由钩子）+ 业务模块「汇率总览」（拉取全球法币挂单、算最优价与目标额度加权均价，内置中文国名 / 国旗，逐行加载进度）与「商品比价」（两行图标按钮点选成品 / 原材料、成品再选 Q1–Q5；「采购」按黄金单价从低到高，「销售」扣增值税 / 进口税后按卖币换金汇率算出税后收入并从高到低，国籍固定取 `POST /account/getuser`）。两者共用 `fxFeed` 这一份汇率缓存，销售模式还会额外读一次 `countries` 的 `laws` 税率。「设置」页负责专用 API 密钥管理（生成 / 粘贴 / 移除，优先于登录 JWT 用于插件查询）与版本检查、更新入口。
- 非官方工具：不修改游戏数据、不自动操作，遵守游戏规则。
- 文档：`README.md` 面向玩家（安装 / 扩展），官方 Wiki 为 <https://wiki.eclesiar.com/>。

## 2. 硬约束

1. **单文件交付**：唯一安装产物是 `eclesiar-helper.user.js`。不要引入构建链、包管理器或运行时依赖；确有需要先征得用户同意。仓库里另有一个 `eclesiar-helper.meta.js`，只放元数据（供油猴 `@updateURL` 只拉版本号），它不是安装产物，内容必须与主脚本头部保持一致。
2. **UI 全在 Shadow DOM**：新增界面挂在 `dom.shadow` 内，样式写进 `STYLES`（`eh-` 前缀）。不要直接往游戏页面插 DOM / CSS。
3. **资源必须可回收**：监听器用 `on(...)` 注册；功能内的定时器、订阅用 `ctx.onDestroy(...)` 登记。新增资源时同步检查 `destroy()` 是否覆盖。
4. **不碰账号与隐私**：不读取或上报 Cookie、Token、账号信息；日志不打印玩家数据。计算只在本地进行。登录 JWT 只从游戏自己发往 `api.eclesiar.com` 的请求头里捕获，仅存内存，不写 `localStorage`、不打印、不上报；不要扩展到读取 Cookie 或任何其它凭据。唯一允许读的账号字段是国籍 id（`nationality.id` / `nationality_id`，用于「销售」判断本国免进口税），且只存内存、不展示原值、不落盘、不打日志；其余字段一律不读。账号信息固定用 `POST /account/getuser`（当前登录账号；`/account` 是按 `account_id` 查指定用户，不要用）。该接口只认游戏登录凭据（带专用密钥会 401），必须传 `{ login: true }`，不能用专用密钥；`getuser` 响应里带 `bearer`，必须忽略，绝不能存或打印。唯一允许落盘的是玩家在「设置」页主动生成 / 粘贴的**专用 API 密钥**（`eclesiar_prod_…`，存 `localStorage` 的 `api-key`）：插件请求一律优先用它，避免占用玩家游戏内的每日查询额度；仍不得打印完整密钥、不得把它发给任何第三方。
5. **不做影响公平性的自动化**：不自动点击、提交表单、循环请求接口、多开或绕过验证；只做展示、计算与用户主动触发的辅助（例如玩家点按钮生成插件专用 API 密钥）。
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
9. 内置功能（`fx` / `goods` / `about`，版本检查也在这里）
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
4. 改过「汇率」：最优价与均价和手算一致；目标额度吃不满时显示实际成交金数并标注深度不足；逐行转圈随数据到达消失，无挂单的行被移除；没捕获到凭据时给出提示。
5. 改过「商品」：采购的黄金单价 = 挂单价 × 买币最优价（不叠加进口税）；缺换汇挂单的货币排最后并标注；切商品 / 切采购销售不重新请求；选择区是两行图标按钮（成品 / 原材料），品质行只在选中成品时出现；商品图标缺图时退回内置 emoji。销售：税后价 = 挂单价 ×（1 − 增值税 − 进口税），再乘卖币最优价（买单方向，与采购相反）；国籍自动读取（`POST /account/getuser`，取 `nationality.id` 或 `nationality_id`），本国免进口税、拿不到国籍时两项都扣；最显眼的是税后金价，其次一行先写税前金价再写税率，不重复税后；商品市场只有卖单，不显示「可卖数量」；排序按税后从高到低；缺税率标「按 0 税估算」，缺买单标「暂无换汇买单」，买盘连 1 件所得都吃不下标「换汇深度不足」；`countries` 与 `POST /account/getuser` 只在进入销售时各请求一次。
6. 改过「设置」或版本检查：同版本显示「已是最新」、`@version` 更大时出现「安装更新」且链接指向 jsDelivr 上的 `.user.js`、两个源都失败时显示提示并保留手动安装链接；顺手确认 `eclesiar-helper.meta.js` 的 `@version` 与主脚本一致。
7. 真实环境：从 `@downloadURL` 安装后刷新游戏，确认悬浮球出现、面板正常，「设置」页能读到仓库里的版本号。
8. 改过「设置」的 API 密钥：没有密钥时按钮能生成并立即显示掩码；有密钥时「汇率 / 商品」发出的请求头带的是 `Bearer eclesiar_prod_…` 而不是登录 JWT（`/account/getuser` 例外，只认登录凭据）；密钥被拒（401）时只提示密钥失效、不丢登录凭据；「移除密钥」后回到登录凭据；「清除本地设置」不删除密钥。使用专用密钥时进入「设置」页会请求一次 `/account/apikey/usage` 并显示已用 / 上限、剩余与距 UTC 零点重置的倒计时（本地每分钟刷新，请求不轮询），切走再回来或重开面板只多请求一次；没有密钥时不发这个请求。注意：该接口只认游戏登录凭据，必须用 `{ login: true }` 发请求，不能用专用密钥。

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
