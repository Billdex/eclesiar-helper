# 数据访问层重构计划：请求去重 + 细粒度缓存

状态：**规划中，未开工**。本期在 `v0.2.6` 版本分支上逐步推进，开工前不动 `eclesiar-helper.user.js`。

## 1. 背景

现状的缓存不是统一层，而是「按接口建模的共享缓存 + 功能自己再写一套」的混合，导致同一个接口出现多套缓存、不同 TTL、失败冷却有的有有的没有：

| 问题 | 现状 |
| --- | --- |
| 同接口两套缓存 | `fxFeed` 整轮 `/market/coin/get`（10 分钟）与 `marketBadge` 的 `rates` / `sellRates`（5 分钟、独立失败冷却）互不共享 |
| 空结果信息丢失 | `fxFeed` 把两侧都无挂单的币种从 `quotes` 里 `splice` 掉，`marketBadge` 无从得知，5 分钟后重新问同一币种 |
| 组合型数据无法复用 | 岗位按「门槛」整轮缓存，换门槛整轮重抓；`/account/apikey/usage` 完全无 TTL，每次进设置页都请求 |
| 失败无冷却 | `ensureCountries` / `ensureTaxes` 失败即清 promise，多个功能会依次重试 |
| 请求放大 | `market.call` 的兜底重试（网络失败 / 403 / 404-405 / 解析失败）让一次逻辑调用最多发 3 个请求 |

## 2. 目标架构

```
功能（fx / goods / marketBadge / regionJump / industry / tax / jobs）
        │  只订阅 + ensure/refresh，不自己做接口缓存
        ▼
数据层（快照与索引）
  coinBook / regionIndex / fxRound / goodsSnapshot / player / profile / jobPages
        │  组合多个接口，负责排序、进度、流亡判断
        ▼
请求层 apiCache（新增）
  key = method + path + 规范化参数；TTL + 失败冷却 + in-flight 合并 + 空结果标记 + 统一失效
        ▼
market.call（凭据 / 超时 / 错误分类）→ fetch
```

原则：

1. **请求层只认「接口 + 参数」**，不认功能；谁能共享就给谁共享。
2. **数据层只做组合**，不碰 DOM，不重复发起已被请求层管理的请求。
3. **功能层不持有接口缓存**，只持有 UI 状态（排序方向、筛选条件、渲染节点）。

## 3. 已确认决策

| 决策 | 内容 |
| --- | --- |
| 缓存时长 | 行情类数据（币种挂单、各国市场挂单、地区清单）统一 **10 分钟**，不再有 5 分钟的私有缓存，也不做后台续期 |
| 岗位缓存 | 改为**页级缓存**（`country_id` + `page`），门槛只决定读到第几页；换门槛复用已读页，不整轮重抓 |

说明：本期不动 `playerFeed` / `profileFeed`（2 分钟）与岗位页（2 分钟）的 TTL，它们与「换国后尽快更新」「岗位刷新」的既有口径绑定。若后续要求也统一 10 分钟，只改 §5 的 TTL 常量，但会延长换国后的置顶 / 高亮延迟。

## 4. 请求层设计

### 4.1 API

```js
apiCache.key(path, params)                 // 参数排序后拼接，作为唯一键
apiCache.peek(key)                         // 只读，不触发请求；命中返回 { value, at, empty }
apiCache.ensure(key, loader, opts)         // 命中即 resolve；in-flight 合并；冷却期 reject(COOLDOWN)
apiCache.refresh(key, loader, opts)        // 忽略 TTL，但仍复用 in-flight
apiCache.invalidate(prefix)                // 按前缀清（如全部 /market/coin/get）
apiCache.clear()                           // destroy / 凭据切换
apiCache.stats()                           // 调试：hit / join / miss / cooldown 计数
```

`opts`：`{ ttl, cooldown, empty, namespace }`。

### 4.2 必须定死的语义

1. **共享请求不透传调用方 `signal`**。`fxFeed.load()` 现在用 `AbortController` 取消整轮；改造后只「停止继续发起新 key」，已发出且可能被共享的请求不 abort。超时仍由 `market.call` 的 10 秒负责。
2. **错误不写入缓存**，只记录失败时间用于冷却；`NO_TOKEN` / `UNAUTHORIZED` 不冷却，`429` 冷却 5 分钟，其它失败默认 60 秒。
3. **`empty: true`** 表示「成功但没有数据」也是有效缓存（无挂单、无地区、空岗位页），与「未加载」严格区分。
4. **凭据变化统一失效**：生成 / 清除密钥、401 时 `invalidate` 所有非永久 key。
5. **不轮询**：`apiCache` 只被动响应 `ensure` / `refresh`，不自行起定时器。

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
| 账号 | `/account/getuser` | 2 分钟 | 单例 |
| 公开资料 | `/user/profile/{id}` | 2 分钟 | key 含 id |
| 接口用量 | `/account/apikey/usage` | 60 秒 | 新增，替代「每次进页面」 |

### 5.1 请求层与数据层的边界

- 请求层返回**原始载荷**（已过 `market.call` 的校验），不做业务解析。
- 数据层负责解析并在内存里保存「解析后的结构」（例如 `Map<countryId, {vat, importTax}>`），避免每次渲染重建。
- 解析结果与原始载荷的生命周期一致，`invalidate` 时一起清。

## 6. 各数据源改造

| 模块 | 改法 | 对外签名 |
| --- | --- | --- |
| `regionFeed` | 内部 `cache` / `pending` 换成 `apiCache`；修正 `force` 在 in-flight 期间被忽略的问题 | `get / ensure / exiled / clear` 不变 |
| `fxFeed.ensureCountries` | 改走 `apiCache` + 解析快照 | 不变 |
| `fxFeed.ensureTaxes` | 同上；补失败冷却 | 不变 |
| 新增 `coinBook` | `quote(id)` → `{ asks, bids, at, empty }`；`ensureMany(ids, opts)`；`subscribe` | 新增 |
| `fxFeed` | 退化为编排器：币种清单 → `coinBook.ensureMany` → 维护 `quotes` 顺序、进度、`error`、`done` 事件；`rateFor` / `sellRateFor` / `sellCapacityFor` 内部改读 `coinBook` | 不变 |
| `marketBadge` | 删除 `rates` / `sellRates` / `fetchRate`，改读 `coinBook`；无挂单由 `empty` 判断；`ensureCurrencyMap` 的国家清单也走 `apiCache` | 不变（页面注入行为不变） |
| `goodsSnapshot` | `/market/get` 改走 `apiCache`；保留 entries、订阅、进度、流亡标记、`goodsFeed.publish` | 不变 |
| `playerFeed` / `profileFeed` | 改走 `apiCache`，保留 getter 与 `onAuth` 补拉；`profileFeed` 换 id 时丢弃旧 promise 的回写 | 不变 |
| 岗位 | 缓存从「门槛整轮」改为「国家 + 页」；门槛只决定读到第几页；保留 300 次硬上限与 10 页/国上限 | 内部 |
| `about` 用量 | 走 `apiCache`（60 秒） | 不变 |

**不进层**：版本检查（非游戏数据，带时间戳绕 CDN 缓存，保持现有 3 源并行）、`/account/apikey/generate`（写操作）。

## 7. 分阶段 TODO

### 阶段 0：准备

- [ ] 确认本期版本号（当前分支 `v0.2.6`，不额外递增）
- [ ] 新增 `apiCache` 骨架：key 规范化、`peek / ensure / refresh / invalidate / clear / stats`
- [ ] `?eh-debug=1` 下输出每轮真实请求数与 `hit / join / miss / cooldown` 计数
- [ ] `AGENTS.md`：§2.2 数据源表新增「请求层」一行，§5 代码组织新增 `9.0 数据访问层`
- [ ] `AGENTS.md`：§2.2 中地区缓存 5 分钟的表述改为 10 分钟

### 阶段 1：`regionFeed` 迁移（最小闭环）

- [ ] `regionFeed` 内部改调 `apiCache`，删除自建 `cache` / `pending`
- [ ] `force` 在已有 in-flight 时不再被静默忽略：等当前请求结束后补一次刷新，或返回旧 pending 并标记
- [ ] 验收：`goodsSnapshot.checkLand`、`regionJump`、工业、税费五处调用方零改动；同国并发只发 1 请求；失败后 60 秒内不重试；`destroy()` 后 `stats()` 归零

### 阶段 2：国家清单 / 税率 / 账号 / 资料

- [ ] `ensureCountries` / `ensureTaxes` 改走 `apiCache`，补 60 秒失败冷却
- [ ] `playerFeed` / `profileFeed` 改走 `apiCache`，保留失败冷却与 `onAuth` 补拉
- [ ] `profileFeed` 换 id 时校验回写，丢弃旧账号结果
- [ ] 验收：切标签不发请求；401 后不刷屏重试；`taxFor` / `wageLawsFor` / `currencyOfCountry` 结果与改造前一致

### 阶段 3：`coinBook`（收益最大）

- [ ] 新增 `coinBook`：单币种买卖两侧独立缓存、`empty` 标记、`ensureMany` 并发合并
- [ ] `fxFeed.load` 改为「算缺失币种 → `ensureMany` → 汇总」，保留进度、`done`、部分失败标注
- [ ] `rateFor` / `sellRateFor` / `sellCapacityFor` 改读 `coinBook`
- [ ] `marketBadge` 删除自建缓存与 `fetchRate`，改读 `coinBook`
- [ ] 验收：汇率页一轮请求数不变（币种数 × 2）；打开商品市场页 0 额外 coin 请求；无挂单币种不再被重复询问；销售口径与改造前一致

### 阶段 4：`goodsSnapshot` / 岗位

- [ ] `/market/get` 改走 `apiCache`，`goodsSnapshot` 保留编排与订阅
- [ ] 岗位改页级缓存：`country_id + page` 为 key，门槛只影响读几页
- [ ] 保留 300 次整轮上限、10 页/国上限、每国失败只跳过该国
- [ ] 验收：市场页 10 分钟内重开 0 请求；换门槛只补缺失页；状态栏进度与「符合条件 N 条」不变

### 阶段 5：收尾

- [ ] `/account/apikey/usage` 加 60 秒 TTL
- [ ] 删除所有重复实现：`marketBadge` 的 `rates` / `sellRates`、`regionFeed` 的 `cache` / `pending`、岗位旧整轮缓存
- [ ] `AGENTS.md` §2.2 表格按新结构重写，§8 测试清单同步增补
- [ ] 全量回归 §8 测试清单

## 8. 验收清单

- [ ] 同一 key 10 并发调用只发 1 个请求
- [ ] 缓存有效期内的标签切换、页面往返均 0 请求
- [ ] 失败后冷却期内不重试；手动「刷新」可绕过 TTL 但不跳过 in-flight
- [ ] `NO_TOKEN` / `UNAUTHORIZED` 不写入缓存，冷却期不生效
- [ ] 切换专用密钥后不返回旧凭据的数据
- [ ] `destroy()` 后请求层清空、无 pending、无定时器、无残留请求
- [ ] `?eh-debug=1` 能对比迁移前后的真实请求数

## 9. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 共享请求被某个功能 abort | 层内不透传 `signal`，取消只作用于「是否继续发起新 key」 |
| 地区缓存 5 → 10 分钟导致流亡政府 / 领土变化延迟 | 在「刷新」入口保留强制刷新；文档标注最迟 10 分钟 |
| 行情缓存统一 10 分钟导致商品市场页标注偏旧 | 标注只作参考值，不承诺实时；必要时另开决策再调 |
| 迁移期行为回退 | 每阶段独立提交、独立验收；`fxFeed` / `regionFeed` 对外签名不变，可单阶段回退 |
| 单文件膨胀 | 请求层控制在 ~120 行，`coinBook` ~80 行；数据层不碰 DOM |
| 调试困难 | 依赖 `?eh-debug=1` 的缓存统计输出 |

## 10. 文档与版本

- 本文档随 `v0.2.6` 分支推进；每完成一个阶段勾掉对应 TODO。
- 阶段 0 开工时同步改 `AGENTS.md` 的 §2.2 与 §5；阶段 5 再统一校对。
- 版本号仅在插件本体改动要发版时递增，本文档改动不动四处版本号。
