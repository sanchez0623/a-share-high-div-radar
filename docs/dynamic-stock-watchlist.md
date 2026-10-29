# 动态添加追踪股票：现状核实与实现方案

> 项目：息壤 · Dividend Atlas（`a-share-high-div-radar`）
> 编写日期：2026-10-29 ｜ 性质：**只读分析报告**，本文档是本次唯一新增文件；不改动任何代码、不 commit。
> 行号以 2026-10-29 当前工作区为准（工作区存在多 agent 并行修改，落地前请重新核对行号）。

---

## 一、现状核实（已核实事实）

### 1.1 股票列表是写死的吗？——**是**

- 全部可研究股票来自 [demo-data.ts](../server/demo-data.ts#L59) 的 `STOCK_SEEDS: StockSeed[]` 常量，共 **6 只硬编码种子**：601318.SH 中国平安、600941.SH 中国移动、000333.SZ 美的集团、601398.SH 工商银行、601088.SH 中国神华、600900.SH 长江电力（L59–253）。
- [createDemoState()](../server/demo-data.ts#L421-L525) 遍历 `STOCK_SEEDS` 构建 `DemoState`：`stocks`（研究口径 Map）、`histories`（合成 90 根日K）、`dividends`（外推 5 年分红）、`qualityInputs`（L427）。**没有任何从文件/数据库加载股票全集的路径**。
- 观察仓默认三只 `'601318.SH'、'600941.SH'、'000333.SZ'` 写死在 [demo-data.ts L429](../server/demo-data.ts#L429)。
- [state.ts](../server/state.ts#L24-L41) 的 `DemoState` 只是内存接口，不含加载逻辑；持久化恢复在 `app.ts` 启动时通过三个 store 完成（见 1.2）。

### 1.2 重启后哪些会保留、哪些不会

| 数据 | 来源 | 重启后 | 依据 |
| --- | --- | --- | --- |
| 股票全集（可研究范围） | `STOCK_SEEDS` 常量 | **不保留概念上的"新增"**——因为根本没有新增通道，重启即回到 6 只 | demo-data.ts L441–522 |
| 观察仓 / 现金 / 持仓 / 交易 | `server/.data/portfolio.json` | 保留，但**会过滤掉不在 `state.stocks` 里的代码** | [portfolio.ts L311–323](../server/portfolio.ts#L311-L323)：`persisted.watchlist.filter(s => state.stocks.has(s))`；全部无效时回退到硬编码三只（L322） |
| 持仓 | 同上 | 同上：`state.stocks.has(h.symbol)` 过滤（[portfolio.ts L338](../server/portfolio.ts#L338)） | |
| 已保存分红假设 | `server/.data/assumptions.json` | 保留（按 symbol 索引；只对 stocks 里存在的代码生效） | assumption-store.ts |
| 风险事件与核验 | `server/.data/risks.json` | 保留（含 fail-closed 校验） | risk-store.ts、index.ts 启动检查 |
| 研究门槛设置 | `server/.data/settings.json` | 保留（白名单只有 `buyThreshold`，见 [settings.ts L9](../server/settings.ts#L9)） | settings-store.ts |
| 历史日K（histories） | **仅内存**，重启由 `createDemoState()` 重新合成 | 演示数据"恢复"但非真实；新增股票将完全无历史 | demo-data.ts L442、L510 |

**结论**：观察仓三只（用户问的中国平安/中国移动/美的集团）来自「种子默认值 + portfolio.json 持久化」，但**可研究的股票全集永远只有种子里那 6 只**；`POST /api/watchlist` 也只能在 6 只内切换（app.ts L305–319：`state.stocks.has(symbol)` 校验）。

### 1.3 现有 HTTP 接口与前端入口：**没有"新增股票"能力**

服务端（[app.ts](../server/app.ts)）：

| 端点 | 行号 | 能力 |
| --- | --- | --- |
| `GET /api/catalog` | L199 | 列出 `state.stocks` 全部 6 只（含 inWatchlist 标记） |
| `POST /api/watchlist` | L305 | 把 **已有** 股票加入观察仓（`state.stocks.has` 校验） |
| `DELETE /api/watchlist/:symbol` | L321 | 移出观察仓（观察仓至少留一只） |
| `POST /api/stocks/:symbol/assumption` 等 | L216/L242 | 假设保存/预览（仅已有股票） |
| `PATCH /api/stocks/:symbol/settings` | L275 | 仅 `buyThreshold` 白名单 |
| `GET /api/quotes` | L492 | 行情白名单同样限定 `state.stocks` |

**不存在** `POST /api/stocks`、`DELETE /api/stocks/:symbol` 或任何"注册新股票"端点。

前端：

- [src/api.ts](../src/api.ts) 已封装 `addWatchlist / removeWatchlist / catalog`，同样没有新增股票调用。
- UI 入口是「管理观察仓」弹窗 [AppModals.tsx L18–63（WatchlistModal）](../src/components/AppModals.tsx#L18-L63)：`api.catalog()` 拉列表 → 搜索过滤 → 加入/移出。**候选集就是那 6 只**，没有"输入新代码"的输入框。

### 1.4 每只股票写死了哪些数据，新增时各自从哪来

| 字段组 | 现在来自（种子） | 新增股票时的获取途径 |
| --- | --- | --- |
| `symbol / name / market / sector` | `StockSeed` L23–27 | 代码→名称：腾讯行情 f1 实测可得（live-quote-probe 验证过）；**行业 sector 免费源无现成字段（需实测东财 f100 或手填）** |
| `price / changePct / volume` | `seed.price` + 合成序列 | 免费行情源实时可得（P0 已落地：tencent/sina/eastmoney provider + `/api/quotes`） |
| `histories`（90 根日K） | `generateDemoHistory` + `buildMarketHistory`（demo-data.ts L300–361，合成波形+前复权） | **东财 push2his 日线可拉任意沪深代码前复权全历史**（P1 半成品 `server/providers/kline-eastmoney.ts` 已实现并实测，`fqt=1` 免自算除息） |
| `forecastDividend / buyThreshold / payoutRatio / dividendStreak` | 种子硬编码 | **免费接口没有可靠的每股分红预测**；`buyThreshold` 是用户设置（已有 settings 体系）；分红预测本质是研究假设，MVP 应让用户录入或先置 0 + `source:'assumption'`，沿用现有 `assumptions.json` 版本化体系 |
| `pe / pb / roe / valuationBasis` | 种子硬编码 | 腾讯行情实测含 PE(TTM)/PB（f39/f46，见 live-data-integration.md §3.2-A）；ROE 免费源无 → MVP 手填或标"未知" |
| `qualityInputs`（现金流覆盖/利润波动/杠杆） | 种子 `seed.quality` | 免费接口无 → MVP 必须人工录入（这本来就是"人工核验"设计，见 risk 体系哲学） |
| `dividends`（5 年分红史）+ `exDividend/pendingDividend` | 种子外推（demo-data.ts L363–378） | 免费源有东财分红接口（未实测）；MVP 可为空数组（质量检查降级为 base 口径，types.ts DividendQualityBasis 已支持 `base`） |
| 风险事件 | 种子生成一条演示风险（L387–411） | 新股票无风险事件 → `deriveRiskGate` 派生为 clear（risk-model.ts），合法状态 |
| 研究结论（level/score/signals/plan） | 纯派生，不存储 | `analyzeStock` 现算（research.ts L280–318 / snapshot.ts），**新增股票自动获得**，无需迁移 |
| 仓位计划 / 组合账本 | 派生 + `portfolio.json` | 自动；持仓默认 0 股 |

### 1.5 histories 只在内存？

是（demo-data.ts L442/L510：每次 `createDemoState()` 现算，无落盘读写）。对新增股票的影响：**新股票没有"历史"可言，必须拉真实日线**；这恰好与 P1 方向一致（已落盘的 `server/bar-store.ts` 提供了 `.data/bars/{symbol}.json` 原子持久化，未接线）。

---

## 二、「动态添加股票」实现方案

### 2.1 数据模型与存储（对应第 5 点）

延续现有「JSON 原子写 store」模式（不引入 DB），**新增一个 `stock-store.ts`**：

```
server/.data/stocks.json        # 股票主数据 + 研究口径（新增/停用状态）
server/.data/bars/{SYMBOL}.json # 日线（P1 半成品 bar-store.ts 已支持）
server/.data/assumptions.json   # 已有：分红假设
server/.data/risks.json         # 已有：风险事件
server/.data/settings.json      # 已有：门槛设置
```

`stocks.json` 每条记录 = 新增股票时拉取/录入的静态口径：

```jsonc
{
  "version": 1,
  "stocks": [
    {
      "symbol": "601318.SH",          // 统一带后缀格式（与 state.stocks 键一致，见 demo-data.ts L61）
      "name": "中国平安",
      "sector": "保险",                // MVP 允许空串，UI 显示“未分类”
      "enabled": true,                 // 软删除标记
      "addedAt": "2026-10-29",
      "research": {                    // 人工/接口获得的研究口径
        "forecastDividend": 2.85,      // 用户录入（免费源无可靠预测）
        "forecastYear": 2026,
        "forecastSource": "assumption",
        "buyThreshold": 5.5,
        "dividendStreak": 14,
        "pe": 7.8, "pb": 0.92, "roe": null,   // roe 可空 → 界面显示“未知”
        "quality": { ... }             // MVP 允许 null → 质量结论降级为 base 口径
      }
    }
  ]
}
```

- **键格式**：统一 `601318.SH`（现有 `state.stocks`、watchlist、trades 全部如此）。复用 P0 已落盘的 [shared/quote-types.ts normalizeSymbol](../shared/quote-types.ts)：白名单仅沪深 A/B 股（60/68/90/00/30/20 前缀），北交所/基金直接拒绝——这与 `Stock.market: 'SH' | 'SZ'`（types.ts L127）吻合；若将来支持北交所需同步扩展该类型与 `quote-types` 白名单。
- **重启不丢**：`createApp` 启动时 `hydrateStocks(state, stockStore.load())`，把 `stocks.json` 中的自定义股票构建进 `state.stocks/histories/dividends/qualityInputs`（构建逻辑见 2.2）；种子 6 只继续内置（或迁移进 stocks.json，见分阶段）。

### 2.2 新增流程（对应第 6 点）

```
POST /api/stocks { symbol: "601288.SH", forecastDividend?: 2.4, sector?: "银行" }
  1. normalizeSymbol 校验（6 位数字 + 沪深白名单）→ 非法 400
  2. state.stocks.has(symbol) → 已存在 409
  3. 拉取基础数据（免费源，全部已有实现）：
     a. 腾讯/东财批量行情（server/providers/tencent.ts）→ 名称、现价、PE、PB；拉不到 → 400“代码不存在或已退市”
     b. 东财 push2his 日线（server/providers/kline-eastmoney.ts，P1 半成品已实测）→ 140 根前复权日线；停牌股也能拿到历史（最后一根日期早于今天 → 提示“疑似停牌”但允许加入）
  4. 构建 Stock 记录：forecastDividend 用请求值或 0（source:'assumption'）；ROE/质量输入可空
  5. 写 stock-store → 注入 state.stocks/histories → saveBars 落盘日线 → 加入 watchlist → persistPortfolio
  6. 响应：getStockSnapshot 全量快照（研究结论自动派生）→ 前端刷新
```

不需要新的外部接口类型：行情、日线全部复用 P0/P1 已有 provider；唯一缺口是「行业 sector」与「ROE/质量数据」（免费源无，MVP 人工）。

### 2.3 删除与停用（对应第 7 点）

**软删除（`enabled: false`）**，不做硬删除：

- 已有的交易账本、风险核验、假设版本都以 symbol 关联，硬删会破坏「成交时冻结的研究快照」「风险证据链」的可追溯性。
- 停用后：从 `/api/catalog`、雷达、观察仓、行情轮询（collectPortfolioSymbols）中隐藏；`POST /api/watchlist` 拒绝停用股票；持仓 > 0 的股票**不允许停用**（先清仓），避免账本悬空。
- UI 遵循既有偏好：停用/移出后隐藏「修改参数」类入口（settings/assumption 按钮对停用股票不渲染）。
- 彻底删除留待将来提供「归档」（连同 bars 文件与关联记录打包导出后再删），P2 再议。

### 2.4 接口设计（对应第 8 点）

| 端点 | 请求 | 响应 | 说明 |
| --- | --- | --- | --- |
| `POST /api/stocks` | `{symbol, name?, sector?, forecastDividend?, buyThreshold?}` | `Stock` 全量快照 | 校验+拉数+初始化+入观察仓，事务式（任一步失败则回滚内存与文件） |
| `PATCH /api/stocks/:symbol` | `{sector?, forecastDividend?, dividendStreak?, ...}` | `Stock` | 补充/修正研究口径（沿用 settings.ts 白名单风格：逐字段校验，拒绝未知键） |
| `PATCH /api/stocks/:symbol/status` | `{enabled: boolean}` | `CatalogItem[]` | 停用/恢复 |
| `GET /api/catalog?includeDisabled=1` | — | `CatalogItem[]` | 管理页可看停用股票 |

鉴权与白名单：新端点自动落在 `app.ts` 现有 `/api` 中间件链内（来源白名单 + `ACCESS_TOKEN`，app.ts L77–81）；`/api/quotes`、watchlist 的 `state.stocks.has` 校验**无需修改**——新股票进入 `state.stocks` 后自动纳入白名单。写接口建议沿用 `runMutation` 模式（写库 → 重算 → 返回快照）。

### 2.5 前端交互（对应第 9 点）

- 入口：`WatchlistModal` 顶部加「添加新股票」区（现有 modal 内，复用 `modal-search`/`catalog-item` 样式），输入 6 位代码或带后缀代码。
- 校验反馈：输入即校验格式（复用 `normalizeSymbol` 逻辑的前端副本或直接 import shared）；提交后 loading（`busy` 状态已有先例）。
- 失败提示沿用 `form-error`：`代码不存在或已退市`（上游拉不到名称/行情）、`已在观察列表`（409）、`暂不支持该市场（仅沪深 A 股/B 股）`、`疑似长期停牌`（日线最后一根早于今日，二次确认后仍可加入）。
- 添加成功：目录列表就地插入 + 默认加入观察仓 + toast「已添加，历史日线与基础数据已同步」；研究页正常打开（快照自动派生）。
- 停用入口放管理页列表行内（长按/次级菜单），停用行置灰并隐藏参数按钮。

### 2.6 分阶段落地（对应第 10 点）

**M1 最小可用（建议 1 个迭代内）**

1. `stock-store.ts`（stocks.json 原子写 + hydrate）；
2. `POST /api/stocks` + `PATCH .../status`（复用 tencent provider + kline-eastmoney）；
3. WatchlistModal 添加区 + 错误反馈；
4. 观察仓/行情/雷达自动纳入（`state.stocks` 注入后零改动）。

**M2 增强**

- 停用股票的归档导出；行业与 ROE 接入东财字段（需实测 f100 等）；分红历史接口（东财分红）替代人工录入；
- 批量导入（粘贴代码列表）；
- 按名称模糊搜索代码（需要证券列表接口，免费源需实测，未找到可靠的免登录列表接口前不做）。

**M3 与 P1 行情真实化合流**

- P1 半成品（kline 日线、bar-store、quote-store、方案 A 实时价覆盖）完成后，新增股票天然享有「真实日线 + 盘中价进入派生链」；建议新股票功能在 P1 合入后实施，避免两套历史序列逻辑。

### 2.7 风险（对应第 11 点）

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 代码格式与市场前缀 | 6/9 开头沪、00/30 深已覆盖；北交所（43/83/87/920）当前 normalizeSymbol 白名单**明确拒绝**，`Stock.market` 类型也只有 SH/SZ | MVP 不支持北交所并在 UI 说明；扩展时同步改类型、白名单与 tencent setcode（北交所=2，未实测） |
| B 股 / 科创板 | B 股（900/200）价格单位为美元/港币，与 CNY 现金账本混算会错 | 白名单虽放行 90/20 前缀，但 MVP 建议 UI 拦截 B 股；科创板 688 正常支持 |
| 退市与停牌 | 行情拉不到 → 无法区分“写错代码”与“退市”；长期停牌股日线最后一根很旧 | 名称+现价双校验；停牌以“日线最后日期距今 > 5 个交易日”提示并允许带确认加入；`applyQuoteToHistory` 对 price=0 已跳过 |
| 免费源名称查询缺失 | 无免登录的“代码→名称”目录接口（未找到公开资料），只能拿行情捎带的名称 | 用腾讯行情 f1（已实测返回中文名）；名称拿不到即视为无效代码 |
| 分红预测质量 | 免费源无预测数据，用户录入值直接决定股息率与评分 | 录入时强制标注来源（`source:'assumption'` 体系已支持）；质量输入缺省时结论降级 base 口径（types.ts 已支持） |
| 并发写入 | 单进程 Node 写盘为临时文件+rename 原子操作，进程内无并发写冲突；但**当前工作区多 agent 并行开发**，落地前必须 rebase 对齐（本文档行号即受此影响） | 落地前以 git 当前状态重核；新增 store 遵循同一原子写模式 |
| 与 P1 半成品冲突 | 工作区已存在未接线的 kline/bar-store/quote-store（P1 中断产物） | 建议先完成或显式搁置 P1，再做本功能；两者共用 kline-eastmoney 与 bar-store |

---

## 三、结论速览

- 三只股票是「种子默认 + portfolio.json 持久化」的组合，但**可研究全集硬编码 6 只，无增删通道**（观察仓增删只能在 6 只内切换）。
- 动态添加的核心工作量在「股票主数据持久化（新 store）+ 初始化流程（行情/日线拉取 + 默认假设）+ 一个新端点 + 一个前端输入区」；行情与日线拉取 P0/P1 已备好，研究结论是纯派生零迁移。
- 主要缺口是“非行情类研究口径”（分红预测、质量输入、行业/ROE）免费源不可得，必须走人工录入 + 来源标注——这与系统「人工核验、用户假设」的既有哲学一致。
