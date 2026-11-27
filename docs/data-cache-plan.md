# 数据访问层重构计划：请求去重 + 细粒度缓存

状态：**已完成（阶段 0–6）**。请求出口已改名 `apiClient`，`apiCache` 统一接管缓存与去重，汇率走 `coinBook`，市场 / 岗位改页级缓存。本期在 `v0.2.6` 版本分支上推进。

## 1. 背景

现状的缓存不是统一层，而是「按接口建模的共享缓存 + 功能自己再写一套」的混合，导致同一个接口出现多套缓存、不同 TTL、失败冷却有的有有的没有：

| 问题 | 现状 |
| --- | --- |
| 同接口两套缓存 | `fxFeed` 整轮 `/market/coin/get`（10 分钟）与 `marketBadge` 的 `rates` / `sellRates`（5 分钟、独立失败冷却）互不共享 |
| 空结果信息丢失 | `fxFeed` 把两侧都无挂单的币种从 `quotes` 里 `splice` 掉，`marketBadge` 无从得知，5 分钟后重新问同一币种 |
| 组合型数据无法复用 | 岗位按「门槛」整轮缓存，换门槛整轮重抓；`/account/apikey/usage` 完全无 TTL，每次进设置页都请求 |
| 失败无冷却 | `ensureCountries` / `ensureTaxes` 失败即清 promise，多个功能会依次重试 |
| 请求放大 | `market.call`（现名，阶段 0 改名 `apiClient.call`）的兜底重试（网络失败 / 403 / 404-405 / 解析失败）让一次逻辑调用最多发 3 个请求 |

## 2. 目标架构

```
功能（fx / goods / marketBadge / regionJump / industry / tax / jobs）
        │  只订阅 + ensure/refresh，不自己做接口缓存
        ▼
数据层（快照与索引）
  coinBook（含批量加载句柄）/ regionIndex / goodsSnapshot / player / profile / jobPages
        │  组合多个接口，负责排序、进度、流亡判断
        ▼
请求层 apiCache（新增）
  key = method + path + 规范化参数；TTL + 失败冷却 + in-flight 合并 + 空结果标记 + 统一失效
        ▼
apiClient.call（凭据 / 超时 / 错误分类）→ fetch
```

原则：

1. **请求层只认「接口 + 参数」**，不认功能；谁能共享就给谁共享。
2. **数据层只做组合**，不碰 DOM，不重复发起已被请求层管理的请求。
3. **功能层不持有接口缓存**，只持有 UI 状态（排序方向、筛选条件、渲染节点）。

### 2.1 数据层对象一览

| 对象 | 职责 | 生命周期 |
| --- | --- | --- |
| `coinBook` | 单币种买卖两侧挂单簿：`quote(id)` → `{ asks, bids, at, empty }`、`ensureMany(ids)`、`load(targets)`；另存一份 `lastBatch = { startedAt, okKeys }`（最近一次批量刷新的成功集合，覆盖式更新，仅在内存） | 随 `apiCache` 的 10 分钟 |
| 批量加载句柄（原 `fxRound`） | 一次 `coinBook.load(targets)` 的返回值：目标 id 集合、`startedAt`、`progress { done, total, phase, retryIndex, retryTotal }`、`failedKeys`、`limited(429)` | 面板持有引用，批结束即丢弃；**不常驻** |
| `regionIndex` | 国家 → 地区清单索引，判定流亡政府（无 `data` / 空数组） | 随 10 分钟 key |
| `goodsSnapshot` | 各国市场挂单快照，抓完 `publish` 给 `goodsFeed` | 随 10 分钟 key |
| `player` / `profile` | 账号三字段 / `economic_level` | 10 秒 |
| `jobPages` | 岗位页缓存（`country_id` + `page`）与去重 | 2 分钟 |

**结论：面板的数据状态与缓存时间直接读 `coinBook`（时间取 `lastBatch.okKeys` 里最旧的 `at`），不需要 `fxRound` 这样的常驻对象。** 判断当前数据是否可用（有没有挂单、`empty`、每币种 `at`、买卖两侧报价）全部来自 key 本身；「一轮刷新」只产生一个临时的批次句柄，用来驱动进度条、重试阶段与失败计数，批结束就丢。

三条理由：

1. **没有「轮」也要能显示**。10 分钟内重开面板不触发抓取，此时没有本轮可言，但「更新于」「N 种货币有挂单」仍必须准确 —— 这些只能来自每个 key 的 `at` 与 `empty`。
2. **轮级时间会低估新鲜度**。`marketBadge`、销售折算是按币种单独 `ensure` 的，可能在汇率面板没打开时就刷新过某几个币种；此时 `updatedAt` 若记「本轮结束时刻」，反而比真实数据旧。
3. **少一份需要同步的状态**。常驻轮次对象要跟着 `invalidate` / 凭据变化 / `destroy()` 一起维护，而批次句柄天然随调用栈消失。

只有两样东西确实无法从 `coinBook` 推导、必须留在句柄里：**本轮失败尝试的 key 集合**（失败不写缓存，所以缓存里看不出来）与 **429 标记**（一次全局事件）；另有 `phase` / `retryIndex`，那是「首轮并发 + 失败串行补」的编排进度，属于调度而非数据。

## 3. 已确认决策

| 决策 | 内容 |
| --- | --- |
| 缓存时长 | 行情类数据（币种挂单、各国市场挂单、地区清单）统一 **10 分钟**，不再有 5 分钟的私有缓存，也不做后台续期 |
| 岗位缓存 | 改为**页级缓存**（`country_id` + `page`），门槛只决定读到第几页；换门槛复用已读页，不整轮重抓 |
| 命名 | 请求出口 `market` 改名 `apiClient`（`apiClient.call` / `.mode` / `.state` / `.onAuth`），与 `apiCache` 组成 `api*` 系列；公开命名空间 `window.EclesiarHelper` 已占用 `api` 标识符，故不取 `api` |
| 轮次对象 | 取消常驻 `fxRound`：改为 `coinBook.load(targets)` 返回的**批次句柄**，面板只持有当前批，结束即丢弃（见 §2.1） |
| 汇率「更新于」 | 取**最近一次批量刷新中成功的那批** key 的最旧 `at`（`min(at)` over `lastBatch.okKeys ∩ 当前目标集合`），失败项只报数量、不拉低时间；含义是「这屏数据里最旧的有效数据到此为止」。不再用「本轮结束时刻」`Date.now()`。从未成功过的币种只计入失败数，不参与 `min` |
| 账号 / 资料 TTL | `/account/getuser` 与 `/user/profile/{id}` 由 2 分钟缩短到 **10 秒**：游戏内旅行、换国籍、升级都会改这两个数据，而这两个接口只在功能读取时触发（无定时器），面板不开就几乎不请求。失败冷却维持 60 秒，避免失效凭据被打成高频重试 |

说明：`playerFeed` / `profileFeed` 本期改为 10 秒（见 §5），因为它们描述的是玩家自身状态，旅行 / 换国籍 / 升级都会立刻改变；读它们的都是用户触发的动作，`apiCache` 不轮询，所以请求量随交互而非时间增长。岗位页保持 2 分钟，与「刷新岗位」的既有口径绑定。

## 4. 请求层设计

### 4.1 API

```js
apiCache.key(path, params)                 // 参数排序后拼接，作为唯一键
apiCache.peek(key)                         // 只读，不触发请求；命中返回 { value, at, empty }
apiCache.ensure(key, loader, opts)         // 命中即 resolve；in-flight 合并；冷却期 reject(COOLDOWN)
apiCache.refresh(key, loader, opts)        // 忽略 TTL，但仍复用 in-flight；失败不删旧值
apiCache.refreshMany(keys, loader, opts)   // 批量 refresh（汇率整轮、岗位整轮）
apiCache.refreshPrefix(prefix, opts)       // 按 key 前缀批量 refresh（/country/regions、/market/get）
apiCache.invalidate(prefix)                // 按前缀**删除**（如全部 /market/coin/get），下次 ensure 重新请求
apiCache.clear()                           // destroy / 凭据切换
apiCache.stats()                           // 调试：hit / join / miss / cooldown / refresh 计数
```

`opts`：`{ ttl, cooldown, empty, namespace }`。

### 4.2 必须定死的语义

1. **共享请求不透传调用方 `signal`**。`fxFeed.load()` 现在用 `AbortController` 取消整轮；改造后只「停止继续发起新 key」，已发出且可能被共享的请求不 abort。超时仍由 `apiClient.call` 的 10 秒负责。
2. **错误不写入缓存**，只记录失败时间用于冷却；`NO_TOKEN` / `UNAUTHORIZED` 不冷却，`429` 冷却 5 分钟，其它失败默认 60 秒。
3. **`empty: true`** 表示「成功但没有数据」也是有效缓存（无挂单、无地区、空岗位页），与「未加载」严格区分。
4. **凭据变化统一失效**：生成 / 清除密钥、401 时 `invalidate` 所有非永久 key。
5. **不轮询**：`apiCache` 只被动响应 `ensure` / `refresh`，不自行起定时器。

### 4.3 刷新与失效怎么往下传

先把一个问题问清楚：**改造后只有一层缓存**。数据层（`coinBook` / `goodsSnapshot` / `jobPages` …）不再保存接口响应，只保存「由载荷派生出来的结构」，生命周期与对应 key 一致。所以不存在「逐层清除」——没有两套缓存可以对不上，也就没有「只清掉了其中一层」这种状态。

两个动作，不要混用：

| 动作 | 语义 | 谁用 |
| --- | --- | --- |
| `refresh*` | 绕过 TTL 重新请求，成功即覆盖缓存值；**失败不删除旧值**，只记录失败时间与 `stale` 标记 | 面板上的「刷新」按钮 |
| `invalidate(prefix)` | **删除**缓存条目，下一次 `ensure` 才重新请求 | 凭据变化（生成 / 移除密钥、401）、`destroy()`、明确要求丢弃旧数据的场景（如岗位换门槛重抓） |

按钮逐个对照（现状 → 改造后）：

| 按钮 | 现状 | 改造后 | 单次请求量 |
| --- | --- | --- | --- |
| 汇率「刷新行情」 | `fxFeed.load()` 整轮重抓全部币种买卖两侧 | `coinBook.load(全部币种 × {SELL, BUY})`（内部 `refresh` 各 key），进度读返回的批次句柄 | 币种数 × 2 |
| 市场「刷新行情」 | `goodsSnapshot.load()` 无条件整轮重抓 | `apiCache.refreshPrefix('/market/get')` 后重算 entries | 国家数 |
| 工业「刷新数据」 | `load(true)` → `regionFeed.ensure(id, { force })` 逐国绕过 TTL | `apiCache.refreshPrefix('/country/regions')` | 国家数 |
| 税费「刷新数据」 | `load(true)`：先汇率后领土，两步都 force | 汇率走 `coinBook.ensureMany`（TTL 内不重拉）+ 领土 `refreshPrefix` | 同工业 |
| 工作「刷新岗位」 | `fetchJobs(true)` 丢弃整轮缓存 | `invalidate` 该轮页 key 后逐页 `ensure`（改门槛**不** invalidate，只补缺失页） | 国家数 × 页数 |
| 设置「检查更新」 | 3 源并行 + 时间戳 | 不进层，保持现状 | 3 |

配套约束：

1. **不把 `force` 布尔再往上透传**。现在 `load(force)` → `ensure({ force })` 的写法要在功能层消失，改由功能直接调用 `refresh*`，避免「某个中间层吞了 force」这类问题。
2. **刷新不透传调用方 `signal`**：只停止继续发起新的 key，已发出且可能被共享的请求不 abort（与 §4.2 第 1 条同一条规则）。
3. **刷新时同 key 已有 in-flight（可能由别的面板发起）就复用**，不并发第二次；等它结束后照常回写（对应 §8「不跳过 in-flight」）。
4. **失败保留旧值**：面板继续显示上次成功的数据，状态栏必须说清「本次刷新失败，下方为 M 分钟前的数据」——这条现在就有，改造后不能退化。
5. **刷新只作用于自己的域**：市场「刷新行情」不 `invalidate` 币种挂单，工作「刷新岗位」不碰地区清单，避免一个按钮把别的面板正在用的数据清空。

## 5. 键与 TTL

| 数据 | key | TTL | 备注 |
| --- | --- | --- | --- |
| 国家清单 | `/countries/summary` | 页面级永久 | 沿用「一次页面只拉一次」 |
| 税率 / 工资法 | `/countries` | 页面级永久 | 与上一条同源不同接口 |
| 单币种卖单 | `/market/coin/get` + `{currency_id, transaction: SELL}` | 10 分钟 | 两侧拆成独立 key |
| 单币种买单 | `/market/coin/get` + `{currency_id, transaction: BUY}` | 10 分钟 | 上架表单的实收金额用这条 |
| 单国市场挂单 | `/market/get` + `{countryid}` | 10 分钟 | `goodsSnapshot` 的底层 |
| 单国地区 | `/country/regions` + `{country_id}` | 10 分钟 | 由 5 分钟上调，流亡判断最迟 10 分钟跟上 |
| 岗位页 | `/market/jobs/get` + `{country_id, page}` | 2 分钟 | 门槛不进 key |
| 账号 | `/account/getuser` | **10 秒** | 单例；失败冷却仍 60 秒 |
| 公开资料 | `/user/profile/{id}` | **10 秒** | key 含 id；失败冷却仍 60 秒 |
| 接口用量 | `/account/apikey/usage` | 60 秒 | 新增，替代「每次进页面」 |

### 5.1 请求层与数据层的边界

- 请求层返回**原始载荷**（已过 `apiClient.call` 的校验），不做业务解析。
- 数据层负责解析并在内存里保存「解析后的结构」（例如 `Map<countryId, {vat, importTax}>`），避免每次渲染重建。
- 解析结果与原始载荷的生命周期一致，`invalidate` 时一起清。

## 6. 各数据源改造

| 模块 | 改法 | 对外签名 |
| --- | --- | --- |
| `regionFeed` | 内部 `cache` / `pending` 换成 `apiCache`；修正 `force` 在 in-flight 期间被忽略的问题 | `get / ensure / exiled / clear` 不变 |
| `fxFeed.ensureCountries` | 改走 `apiCache` + 解析快照 | 不变 |
| `fxFeed.ensureTaxes` | 同上；补失败冷却 | 不变 |
| 新增 `coinBook` | `quote(id)` → `{ asks, bids, at, empty }`；`ensureMany(ids, opts)`；`load(targets)` → 批次句柄；`subscribe` | 新增 |
| `fxFeed` | 拆除：行情数据归 `coinBook`，一轮刷新的进度 / 失败 / 429 归批次句柄；`rateFor` / `sellRateFor` / `sellCapacityFor` 改读 `coinBook` | 内部（面板只依赖 `coinBook` + 句柄） |
| `marketBadge` | 删除 `rates` / `sellRates` / `fetchRate`，改读 `coinBook`；无挂单由 `empty` 判断；`ensureCurrencyMap` 的国家清单也走 `apiCache` | 不变（页面注入行为不变） |
| `goodsSnapshot` | `/market/get` 改走 `apiCache`；保留 entries、订阅、进度、流亡标记、`goodsFeed.publish` | 不变 |
| `playerFeed` / `profileFeed` | 改走 `apiCache`，保留 getter 与 `onAuth` 补拉；`profileFeed` 换 id 时丢弃旧 promise 的回写 | 不变 |
| 岗位 | 缓存从「门槛整轮」改为「国家 + 页」；门槛只决定读到第几页；保留 300 次硬上限与 10 页/国上限 | 内部 |
| `about` 用量 | 走 `apiCache`（60 秒） | 不变 |

**不进层**：版本检查（非游戏数据，带时间戳绕 CDN 缓存，保持现有 3 源并行）、`/account/apikey/generate`（写操作）。

## 7. 分阶段 TODO

### 阶段 0：`market` → `apiClient` 重命名（最高优先，零行为变更）

动因：`market` 是插件第一个功能（汇率 / 货币市场）留下的名字，现在已是全插件唯一的请求出口。`market` 与游戏的 `/market` 路由、市场页功能（`marketBadge` / `marketJump`）撞名，读代码时容易误判作用域；请求层重构期间还要不断在这一层加东西，先改干净，后续新增代码直接用新名，避免二次清扫。

- [x] 只改这一个对象：`const market = (() => { … })()` → `const apiClient = (() => { … })()`。**不要**动 `marketBadge` / `marketJump` / `market-calc` / 字符串里的 `/market/…` / `sessionStorage` 键 `eh:market-intent` / 注释里的游戏路由
- [x] 成员访问同步改名（当前实测 47 处）：`call` 7、`state` 22、`onAuth` 11、`mode` 3，`install` / `uninstall` / `generateKey` / `setKey` / `clearKey` 各 1
- [x] 模块头注释「市场接口凭据」改为「统一请求出口 / 凭据」，并注明它不仅服务行情
- [x] `AGENTS.md` 同步：§2.2「行情请求统一走 `market.call`（负责并发、凭据与错误分类）」与下一条分页接口说明改成 `apiClient.call`；§5 代码组织里该区段的描述一并核对
- [x] 不写兼容别名（不保留 `market` 指向同一对象）：该对象不在公开 API 上，无外部调用方
- [x] 验收：`grep -nE '\bmarket\.' eclesiar-helper.user.js` 归零（`marketBadge.` / `marketJump.` 不匹配该模式）；`node --check` 通过；§8 全量回归无行为差异，重点看汇率刷新、市场页标注、密钥生成 / 移除、`onAuth` 补拉、`destroy()`
- [x] 单独一次提交（`chore: 统一请求出口命名 market → apiClient`），便于单条回退；本阶段不动四处版本号

### 阶段 1：准备

- [x] 确认本期版本号（当前分支 `v0.2.6`，不额外递增）
- [x] 新增 `apiCache` 骨架：key 规范化、`peek / ensure / refresh / refreshMany / refreshPrefix / invalidate / clear / stats`
- [x] `refresh` 失败保留旧值并打 `stale` 标记（不是删除），与 §4.3 一致
- [x] `?eh-debug=1` 下输出每轮真实请求数与 `hit / join / miss / cooldown / refresh` 计数
- [x] `AGENTS.md`：§2.2 数据源表新增「请求层」一行，§5 代码组织新增 `9.0 数据访问层`
- [x] `AGENTS.md`：§2.2 中地区缓存 5 分钟的表述改为 10 分钟（随阶段 2 一起改，避免文档先于代码失真）

### 阶段 2：`regionFeed` 迁移（最小闭环）

- [x] `regionFeed` 内部改调 `apiCache`，删除自建 `cache` / `pending`
- [x] `force` 在已有 in-flight 时不再被静默忽略：先等在途请求结束，再补一次真正的刷新（`regionFeed.refresh`）
- [x] 工业 / 税费的 `load(force)` 收成 `load()` / `refresh()` 两个入口（内部走 `regionFeed.ensure` / `regionFeed.refresh`），功能层不再传布尔
- [x] 修正 `industry.load` 的注释：改成「pull 决定命中缓存还是绕过 TTL」，与实现一致
- [x] 验收：`goodsSnapshot.checkLand`、`regionJump` 两处调用方零改动（工业 / 税费只换 pull 入口）；同国并发只发 1 请求；失败后 60 秒内不重试；`destroy()` 后 `stats()` 归零（离线桩测试 16 条断言全过）

### 阶段 3：国家清单 / 税率 / 账号 / 资料

- [x] `ensureCountries` / `ensureTaxes` 改走 `apiCache`，补 60 秒失败冷却（页面级条目 `ttl: 'page'`，换凭据时保留）
- [x] `playerFeed` / `profileFeed` 改走 `apiCache`，保留失败冷却与 `onAuth` 补拉
- [x] `API_TTL.account` / `API_TTL.profile` 由 2 分钟改为 10 秒（失败冷却仍 60 秒）：两个接口只描述玩家自身状态，且只在功能读取时触发，不轮询
- [x] `profileFeed` 换 id 时校验回写，丢弃旧账号结果
- [x] 验收：切标签不发请求；401 后不刷屏重试；`taxFor` / `wageLawsFor` / `currencyOfCountry` 结果与改造前一致（离线桩测试 31 条断言全过）

### 阶段 4：`coinBook`（收益最大）

- [x] 新增 `coinBook`：单币种买卖两侧独立缓存、`empty` 标记、`ensureMany` 并发合并
- [x] 新增 `coinBook.load(targets)`：返回批次句柄（`progress` / `failedKeys` / `limited`），内部对每个 key 走 `refresh`，失败项串行补一轮
- [x] 汇率面板不再持有轮级状态：数据状态与「更新于」读 `coinBook`（可用性看 `empty` / `asks` / `bids`，时间取 `lastBatch.okAt ∩ 当前目标` 里**最旧**的 `at`，删掉轮级 `updatedAt = Date.now()`）
- [x] `lastBatch` 失败时不覆盖：整批失败或部分失败都保留上一次成功集合，只把本轮失败数交给状态栏；国家清单变化时按交集过滤；凭据变化时随 `coinBook.reset()` 清空
- [x] 状态栏口径不变：`N 种货币有挂单 · 更新于 HH:MM`，有失败时补 `M 个拉取失败（显示旧数据）`
- [x] `rateFor` / `sellRateFor` / `sellCapacityFor` 改读 `coinBook`
- [x] `marketBadge` 删除自建缓存与 `fetchRate`（连带自建的国家清单重试计时），改读 `coinBook`
- [x] 验收：汇率页一轮请求数不变（币种数 × 2）；打开商品市场页 0 额外 coin 请求；无挂单币种不再被重复询问；销售口径与改造前一致；10 分钟内重开面板 0 请求且「更新于」= `lastBatch` 中最旧的 `at`；长期失败的币种不拉低该时间（离线桩测试 35 条断言全过）

### 阶段 5：`goodsSnapshot` / 岗位

- [x] `/market/get` 改走 `apiCache`，`goodsSnapshot` 保留编排与订阅；刷新失败保留旧值继续显示
- [x] 岗位改页级缓存：`country_id + page` 为 key，门槛只影响读几页
- [x] 「刷新岗位」逐页 `refresh`（绕过 TTL 但不清缓存，旧值仍在）；换门槛不 invalidate，只复用已读页
- [x] 保留 300 次整轮上限（只数真正要发的页）、10 页/国上限、每国失败只跳过该国
- [x] 验收：市场页 10 分钟内重开 0 请求；换门槛只补缺失页；状态栏进度与「符合条件 N 条」不变（离线桩测试 12 条断言全过）

### 阶段 6：收尾

- [x] `/account/apikey/usage` 加 60 秒 TTL
- [x] 删除所有重复实现：`marketBadge` 的 `rates` / `sellRates` / `fetchRate` / 自建国家清单重试、`regionFeed` 的 `cache` / `pending`、岗位旧整轮缓存、`fxBook`
- [x] `AGENTS.md` §2.2 表格按新结构重写，§5.4 补数据层约定，§8 增补请求层验收
- [x] 全量回归 §8 测试清单（离线桩测试覆盖 apiCache / regionFeed / 账号与资料 / 税率与国家清单 / coinBook / fxFeed / goodsSnapshot）

## 8. 验收清单

- [x] 同一 key 10 并发调用只发 1 个请求
- [x] 缓存有效期内的标签切换、页面往返均 0 请求（数据源层：`fxFeed` / `goodsSnapshot` / `coinBook` 均已验证）
- [x] 失败后冷却期内不重试；手动「刷新」可绕过 TTL 但不跳过 in-flight
- [x] 五个刷新按钮只重抓自己域内的 key，不会 `invalidate` 别的面板正在用的缓存（`refreshPrefix` 前缀隔离已验证，按钮本身待浏览器点选）
- [x] `refreshMany` / `refreshPrefix` 逐 key 复用 in-flight，同一 key 不会出现两次并发
- [x] 刷新失败时旧值仍在，状态栏明确标注「本次刷新失败 / 下方为 M 分钟前的数据」
- [x] `NO_TOKEN` / `UNAUTHORIZED` 不写入缓存，冷却期不生效
- [x] 切换专用密钥后不返回旧凭据的数据（`dropSessionCache` + 失效代数丢弃在途回写；密钥切换本身待浏览器点选）
- [x] `destroy()` 后请求层清空、无 pending、无定时器、无残留请求（`stats()` 各项归零，公开 API 同步摘除）
- [x] `?eh-debug=1` 能对比迁移前后的真实请求数
- [x] 请求出口改名为 `apiClient` 后，以上各条行为与改造前一致（`grep -nE '\bmarket\.'` 归零）

验证方式：离线桩测试 109 条断言（`apiCache` / `regionFeed` / 账号与资料 / 税率与国家清单 / `coinBook` / `fxFeed` / `goodsSnapshot`）+ 最小 DOM 桩加载整份脚本（启动、开合面板、`storage`、`destroy()` 均不抛错，启动阶段 0 网络请求）。**仍需真实浏览器点选回归**：五个「刷新」按钮、密钥生成 / 移除、以及汇率 / 市场 / 工业 / 税费 / 工作五个页面的视觉与状态栏文案（见 `AGENTS.md` §8）。

## 9. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 共享请求被某个功能 abort | 层内不透传 `signal`，取消只作用于「是否继续发起新 key」 |
| 地区缓存 5 → 10 分钟导致流亡政府 / 领土变化延迟 | 在「刷新」入口保留强制刷新；文档标注最迟 10 分钟 |
| 行情缓存统一 10 分钟导致商品市场页标注偏旧 | 标注只作参考值，不承诺实时；必要时另开决策再调 |
| 迁移期行为回退 | 每阶段独立提交、独立验收；`regionFeed` 等对外签名不变可单阶段回退；`fxFeed` 拆除那一阶段改动最大，需整阶段独立提交 |
| 单文件膨胀 | 请求层控制在 ~120 行，`coinBook` ~80 行；数据层不碰 DOM |
| 重命名漏改 | `grep -nE '\bmarket\.'` 归零校验 + `node --check` + §8 全量回归；纯改名单独提交，可单条回退 |
| 刷新被写成「清缓存」 | 按 §4.3 表实现：按钮一律 `refresh*`，只有凭据变化 / `destroy` / 岗位换轮次才 `invalidate`；验收含「刷新失败旧值仍在」 |
| 调试困难 | 依赖 `?eh-debug=1` 的缓存统计输出 |

## 10. 文档与版本

- 本文档随 `v0.2.6` 分支推进；每完成一个阶段勾掉对应 TODO。
- 阶段 0 先改 `AGENTS.md` §2.2 的两条 `market.call`；阶段 1 开工时补 §2.2 请求层与 §5 代码组织；阶段 6 再统一校对。
- 版本号仅在插件本体改动要发版时递增，本文档改动不动四处版本号。
