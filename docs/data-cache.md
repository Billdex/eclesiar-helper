# 数据访问层说明（v0.2.7 现状）

本文只描述**现在是什么样**：数据怎么流、缓存怎么失效、什么时候发请求、变了通知谁。
必须遵守的硬性约定在 `AGENTS.md` §2.2 / §2.3 / §5.4，这里补充的是「为什么这么设计」。
改造过程与历史决策不进本文，见 git log（`60412fe`…`e561618`）。

## 1. 分层

```
功能层（fx / goods / marketBadge / business 子面板）
   │  读数据源 getter，订阅变化；不持有接口缓存，也不自己写接口缓存
   ▼
数据层（只保存由载荷派生的结构）
  coinBook | fxFeed(国家清单/税率/quotes) | regionFeed | goodsSnapshot | playerFeed | profileFeed
   │  组合接口、排序、判断流亡、维护进度
   ▼
请求层 apiCache（唯一缓存：key = path + 规范化参数）
   │  TTL / 失败冷却 / in-flight 合并 / 空结果 / 失效代数 / 变更通知
   ▼
apiClient.call（凭据、超时 10 秒、错误分类、兜底重试）→ fetch
```

两条通道互相独立：

- **数据通道**：功能层 `ensure()` → 请求层（命中就返回条目）→ 数据层解析 → getter。
- **通知通道**：请求层写入/失效 → `apiCache.watch` 订阅者 → 数据源重新解析 → 数据源订阅者 → 界面重绘。

## 2. 请求层 `apiCache`

### 2.1 key

`apiCache.key(path, params)`：参数名排序后拼接成 `path?a=1&b=2`。**不包含 HTTP 方法**，也不包含凭据——凭据变化靠主动失效（§2.4）处理。

key 直接暴露在调试接口里，所以前缀有意义：`/market/coin/get`、`/market/get?countryid=…`、`/country/regions?country_id=…`。

### 2.2 条目

```js
{ key, value, at, ttl, empty, emptyPick, stale, namespace, loader }
```

- `value`：`apiClient.call` 的返回（已过校验的原始载荷），请求层不解析。
- `at`：写入时间；TTL 判断只看它。
- `ttl`：毫秒数，`Infinity` 表示页面级（`API_TTL.page`）。
- `empty`：本次是否为「成功但没数据」。默认规则是「空数组」，数据源可传 `opts.empty(value)` 自定义（如商品市场是空 `Map`，失土国家是「没有 data」）。
- `emptyPick`：记住这个谓词，供 `refresh` 不传 `opts` 时沿用。
- `stale`：刷新失败时打标，旧值保留。
- `loader`：写入时用的加载函数，供 `refresh(key)` 省略 loader 时复用。

### 2.3 生命周期与失效代数

`entries` 是唯一缓存表；`writeEntry` 是唯一写入点，`invalidate` / `clear` 是唯一删除点。

「失效代数」保证在途结果不会写回旧缓存：

- `epoch` 全局代数，`clear()` 时 +1；`prefixStamps` 按前缀记代数，`invalidate(prefix)` 时 +1。
- 请求发出时记下 `stampOf(key)`，回来时对不上就丢弃结果（`ensure` 返回 `null`，数据源按「作废」处理，不能当成功值）。

`clear(keepPage)`：`keepPage=true` 保留 `ttl === Infinity` 的页面级条目（国家清单、税率与凭据无关），其余全删；`keepPage=false`（`destroy()`）连统计一起归零。

### 2.4 失败与冷却

错误**不写入缓存**，只记 `failures[key] = { at, code, retryAt }`：

| 错误 | 冷却 |
| --- | --- |
| `NO_TOKEN` / `UNAUTHORIZED` | 0（补到凭据后要能立刻重试） |
| `HTTP_429` | 5 分钟 |
| 其它（网络、5xx、解析失败） | 60 秒 |

冷却期内 `ensure` 直接 `reject({ code: 'COOLDOWN', reason, retryAt })`，**不发请求**；`refresh` 不看冷却（手动刷新要能立刻重试）。

`apiClient.call` 遇到 401 会调 `dropSessionCache()`：

```js
apiCache.clear(true);   // 保留页面级条目
coinBook.reset();       // 连「最近一次成功」的时间一起丢
fxFeed.reset();         // 清展示快照，避免「旧价格 + 还没有数据」
playerFeed.reset();     // 清账号三字段
profileFeed.reset();    // 清技能等级
```

### 2.5 空结果是有效缓存

「无挂单 / 无地区 / 空岗位页」用 `opts.empty` 标记成条目，与「没加载过」严格区分。这是 `coinBook` 能回答「这个币种确实没人挂单」而不是反复重问的前提。

### 2.6 变更通知

`apiCache.watch(test, fn)`：`test` 是前缀字符串或谓词；`writeEntry` / `invalidate` / `clear` 之后 `emitKey(key)`，**按 `requestAnimationFrame` 合并**——同一帧写 90 个 key，订阅者只被叫一次（后台标签页 rAF 暂停时退回 `setTimeout`）。

回调收到本帧变化的 key 数组；`stats().watchers` 是订阅者数量，`destroy()` 后必须为 0。

### 2.7 API 一览

| 方法 | 作用 |
| --- | --- |
| `key(path, params)` | 规范化 key |
| `peek(key)` | 只读，返回 `{ value, at, empty, stale }`；**不判 TTL** |
| `fresh(key)` | 只读，是否有未过期缓存；判「要不要发请求」一律用它 |
| `busy(key)` | 该 key 是否有在途请求 |
| `ensure(key, loader, opts)` | 命中即返回；同 key 合并；冷却期 reject |
| `refresh(key, loader, opts)` | 绕过 TTL，复用在途；失败保留旧值；缺 `opts` 时沿用上次登记的口径 |
| `watch(test, fn)` | key 级变更订阅，返回退订函数 |
| `invalidate(prefix)` | 按前缀删除（丢弃旧数据） |
| `clear(keepPage)` | 整体清空 |
| `stats()` / `report(label)` / `resetStats()` | 调试统计 |

`opts`：`{ ttl, cooldown, empty, namespace }`。

## 3. 数据源

### 3.1 `coinBook`：单币种挂单簿

- 每个币种**买卖两侧各一个 key**：`/market/coin/get?currency_id=…&transaction=SELL|BUY`，10 分钟。
- `quote(id)` → `{ asks, bids, at: min(两侧), empty, partial, stale }`；两侧都没加载过返回 `null`。
- `ready(id)`：两侧都 `fresh`。用于「整批命中就别跑一轮」的快路径。
- `ensureMany(ids)`：补齐缺失的一侧，命中不发请求，失败只收集 key。
- `load(ids, { mode, onRow, onProgress })` → **批次句柄**（`progress` / `failedIds` / `failedKeys` / `limited` / `cancelled` / `done` / `promise`），批结束即丢，不常驻。
  - 3 并发 + 60ms 间隔；命中的币种跳过间隔。
  - 首次失败后**串行补跑一次**（`refresh`，绕过冷却），429 直接跳过；补跑上限 8 个，失败面过大时视为整体故障不补。
  - 失败时保留旧值，面板继续显示上一次成功的数据。
- `lastBatch = { startedAt, okKeys, okAt }`：按**本轮成功的货币**覆盖式更新（失败项剔除，长期失败的币种不会冻结「更新于」）；整批全失败时保留上一次。`oldestAt(ids)` 据此给「更新于」。
- 复位：`reset()`（凭据变化 / destroy）标记旧批次取消并清 `lastBatch`；批次收尾带 `batch === handle` 守卫，旧批次不会回写。

### 3.2 `fxFeed`：国家清单 / 税率 / 汇率展示快照

- `/countries/summary` 与 `/countries` 都是**页面级**（`ttl: 'page'`），换凭据时保留；解析结果（国家数组、税率 `Map`、工资法 `Map`）用**条目对象身份**做版本，条目换了才重新解析。
- 入口分两个口径：`ensureCountries` / `ensureTaxes`（命中 TTL）与 `refreshCountries` / `refreshTaxes`（绕过 TTL）；`loadCountries(mode)` 是统一入口，刷新失败且手里有旧清单时退回旧清单并置 `countriesStale`。
- `quotes` 只是渲染快照（含 `pending` / `error` 行），数据一律回 `coinBook` 读，不是第二层缓存。
- `run(mode)` 的两种路径：
  - **全部命中**（`mode === 'ensure'` 且每个币种 `ready`）：直接从挂单簿拼 `quotes`，不置 `loading`、不显示进度、不发请求；行集合没变时连 DOM 都不重建。
  - 否则逐币种跑 `coinBook.load`，进度与失败计数交给批次句柄。
- `updatedAt` = `coinBook.oldestAt(当前列表)`；没有「整批成功」记录时（例如缓存是被商品市场页标注单独补的）退回逐行取最旧。

### 3.3 `regionFeed`：国家 → 地区

- key：`/country/regions?country_id=…`，10 分钟；`empty` 谓词为「非数组或空数组」（失土国家的载荷是「没有 data」，默认规则认不出来）。
- 载荷归一：`null` 表示「缓存被清空」，抛 `DROPPED` 让调用方按失败处理，**不能当成没有领土**，否则会把国家误判成流亡政府。
- `get(id)`：未过期才返回（同步读取）；`atOf(id)`：缓存时间，供「更新于」取最旧；`ensure` / `refresh` / `exiled` / `clear`。
- `refresh(id)` 在已有在途请求时先等它结束，再补一次真正的刷新（不会因为 in-flight 把刷新吞掉）。

### 3.4 `goodsSnapshot` / `goodsFeed`：各国市场行情

- `/market/get?countryid=…`，10 分钟，解析结果是 `Map<name#quality, {price, supply}>`；空 `Map` 记为 `empty`。
- `run(mode)` 逐国 `ensure` / `refresh`，单国失败时若手里有旧值就继续显示；抓完 `goodsFeed.publish(entries)` 给市场页标注算「比全球最低贵多少」。
- 两个时间要分开：
  - `updatedAt`：这屏数据里**最旧**的市场 key 时间，用于展示；
  - `checkedAt`：本轮检查结束时刻，只用于「多久之后再自动拉一轮」的调度。
- `ensure(maxAge)`：`checkedAt` 在有效期内且 `entries` 非空就直接返回；刚失败过 60 秒内不自动重试（手动刷新不受限）。
- `entries` 每轮整表重建，没有做 `structural sharing`。

### 3.5 `playerFeed` / `profileFeed`：账号与技能

- `/account/getuser`（`POST`，只认登录凭据）与 `/user/profile/{id}`，**10 秒**；失败冷却 60 秒。
- `playerFeed` 只保存三个字段：`accountId` / `nationalityId` / `countryId`，不展示原字段、不打日志。
- `watch(fn)` 直接订阅 `/account/getuser` 这个 key（写入/清空时回调，参数是解析后的 info 或 `null`），所有面板的「当前位置」因此共用一条通知链。
- `profileFeed` 用 `wantedId` 丢弃晚到的旧账号结果。

### 3.6 岗位页

- key：`/market/jobs/get?country_id=…&page=…`，2 分钟；**门槛不进 key**，只决定读到第几页。
- `pagination` 在响应根上（`call` 传 `full`），`total_records === 0` 直接当空结果。
- 硬上限：每国 10 页、整轮 300 次请求；计数用 `apiCache.fresh`，过期的页照样会重新请求、照样计入。
- 提前停止：接口按薪资降序，设了门槛时某页最低已低于门槛就不再请求后续页；汇率缺失的页不据此判断。

## 4. TTL 总表

| 数据 | 位置 | TTL |
| --- | --- | --- |
| 国家清单 `/countries/summary` | `API_TTL.page` | 页面级（`destroy` 前不过期） |
| 税率 / 工资法 `/countries` | `API_TTL.page` | 页面级 |
| 币种挂单（买卖各一条 key） | `API_TTL.coin` | 10 分钟 |
| 单国市场挂单 | `API_TTL.goods` | 10 分钟 |
| 单国地区 | `API_TTL.regions` | 10 分钟 |
| 岗位页 | `API_TTL.jobPage` | 2 分钟 |
| 账号 / 公开资料 | `API_TTL.account` / `profile` | 10 秒 |
| 接口用量 | `API_TTL.usage` | 60 秒 |

行情类统一 10 分钟、不做后台续期；`apiCache` 本身不起定时器。

## 5. 两个问题：什么时候问、变了告诉谁

### 5.1 什么时候去问

只有三个入口，都不轮询接口：

1. **`ctx.onShow`**：面板每次打开、切到某个标签时触发一次。汇率补读账号 + 行情（行情过期才拉），市场补读位置 + 快照，税费 / 工作只补读账号。工商子面板在「切回已挂载的子标签」时触发，首次由 mount 自己读。
2. **面板上的刷新按钮**：一律 `refresh` 口径（§6）。
3. **`marketBadge` 的 60 秒本地重扫**（仅游戏商品市场页、仅前台）：只重算本地 DOM，**不发请求**；是否补拉由 10 分钟 TTL 决定，补拉失败退避 5 分钟。

除此之外没有定时器。面板静止时数据不会自己更新——这是刻意的（§3.6 不轮询接口）。

### 5.2 变了告诉谁

| 数据源 | 通知方式 | 载荷 |
| --- | --- | --- |
| `apiCache` | `watch(test, fn)` | 本帧变化的 key 数组 |
| `playerFeed` | `watch(fn)` | 解析后的 info 或 `null` |
| `fxFeed` | `subscribe(fn)` | `reset` / `row` / `drop` / `state` / `done`（抓取过程事件） |
| `goodsSnapshot` | `subscribe(fn)` | `reset` / `entry` / `drop` / `done` / `error` / `state` |
| `goodsFeed` | `subscribe(fn)` | `publish()` 时推全量 markets |
| `route` | `subscribe(fn)` | 路径变化 |

`fxFeed` / `goodsSnapshot` 发的是**过程事件**（描述一轮抓取的进度），不是「某个 key 的值变了」；跨页面共享的数据要走 `apiCache.watch`（如 `marketBadge` 订阅 `/market/coin/get`）。

### 5.3 订阅的约束

- 回调里**只读数据、只重绘**，不要再发起请求（否则容易自己触发自己）。
- 值没变就不要重绘：`applyHere` / `applyPlayer` / `applyFields` 都先比较再决定。
- 必须成对退订：面板用 `ctx.onDestroy`，页面级注入用 `stop()`；`destroy()` 后 `cache.stats().watchers` 必须为 0。

## 6. 刷新语义

| 动作 | 语义 | 谁用 |
| --- | --- | --- |
| `refresh` | 绕过 TTL 重新请求；成功覆盖；**失败保留旧值**并标 `stale` | 面板刷新按钮 |
| `invalidate(prefix)` | **删除**条目，下次 `ensure` 才重新请求 | 凭据变化、`destroy()`、明确丢弃旧数据 |
| `clear(keepPage)` | 整体清空 | `destroy()`（不保留） / 换凭据（保留页面级） |

各按钮的实际请求量：

| 按钮 | 实际动作 | 请求量 |
| --- | --- | --- |
| 汇率「刷新行情」 | `loadCountries('refresh')` + `coinBook.load(全部币种, refresh)` | 币种数 × 2 + 1 |
| 市场「刷新行情」 | `loadCountries('refresh')` + 逐国 `refresh('/market/get')`（销售模式另刷税率） | 国家数 + 1（+1） |
| 工业「刷新数据」 | `loadCountries('refresh')` + 逐国 `regionFeed.refresh` | 国家数 + 1 |
| 税费「刷新数据」 | 清单 / 税率 refresh + 行情按 TTL + 逐国 `regionFeed.refresh` | 同工业 |
| 工作「刷新岗位」 | `loadCountries('refresh')` + 逐页 `refresh('/market/jobs/get')` | 国家数 × 页数 + 1 |

刷新失败时列表不清空，状态栏说明「M 个拉取失败（显示旧数据）」；`COOLDOWN` 会被翻成「上次请求失败，冷却中，约 N 秒后可重试」。

## 7. 调试

- 地址加 `?eh-debug=1`（之后由 `sessionStorage` 记住）：每次 `ensure / hit / join / cooldown / 失败 + 冷却秒数`，以及 `report()` 的每轮汇总。
- `EclesiarHelper.cache.stats()`：

| 字段 | 含义 |
| --- | --- |
| `hit` / `join` / `miss` | 命中 / 合并到在途 / 未命中 |
| `cooldown` | 因冷却直接拒绝的次数 |
| `refresh` | `refresh` 调用次数 |
| `fail` | 请求实际失败的次数（冷却期直接拒绝计入 `cooldown`，不重复计 `fail`） |
| `request` | **逻辑请求数**（不含 `apiClient` 的兜底重试） |
| `entries` / `failures` / `inflight` | 条目 / 冷却记录 / 在途 |
| `watchers` | 订阅者数量（`destroy()` 后应为 0） |

- `EclesiarHelper.cache.peek(key)` 只看「有没有这条」，不判过期；判断新鲜度看返回的 `at`。
- `EclesiarHelper.cache.invalidate(prefix)` / `.clear()` 只丢数据，不下线插件；`EclesiarHelper.destroy()` 才是彻底卸载（之后只能刷新页面）。

## 8. 已知取舍与未做

- **不轮询接口**：面板静止时不更新；`visibilitychange` / 路由变化时的重验（SWR 的 `revalidateOnFocus`）没做，要加需先改 `AGENTS.md` §3.6。
- **`request` 计数不含兜底重试**：`apiClient.call` 在 403 / 404-405 / 解析失败 / 网络失败时最多再发 2–3 个请求，真实请求数可能高于统计值。
- **共享请求不 abort**：取消只表示「不再发起新 key」，已发出的请求会跑完（超时由 10 秒兜底）。
- **`goodsSnapshot` 无结构共享**：每轮整表重建 DOM，45 国规模下可接受，再大需要按行 diff。
- **无自动化回归测试**：`apiCache` 的语义靠人工点选与临时桩测试（不入库）。
