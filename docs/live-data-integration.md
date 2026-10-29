# A 股实盘数据接入研究报告

> 项目：息壤 · Dividend Atlas（`a-share-high-div-radar`）
> 版本：v1.0 ｜ 编写日期：2026-10-29
> 实测环境：Windows / Node（tsx）/ 本机直连公网；实测时刻 **2026-10-29 15:00（Asia/Shanghai，当日已收盘）**
> 约束：本文只做研究与方案设计，**未改动任何业务代码、未提交 commit**。文中的示例脚本位于 `scripts/`，标注为“示例，未接入主流程”。

## 标注约定

| 标记 | 含义 |
| --- | --- |
| 【实测】 | 本次会话中实际调用并拿到返回结果，附时间戳 |
| 【公开资料】 | 有可查的官方文档 / 媒体报道链接支撑 |
| 【推测】 | 基于工程经验或接口行为的合理推断，未经直接验证 |
| 【未找到公开资料】 | 检索不到可信的公开说明，不做数字假设 |

---

## 0. 结论摘要

1. **当前项目没有任何实盘数据链路**：行情是 `server/demo-data.ts` 用正弦波形合成的 90 根日 K，价格取自 `history` 最后一根收盘价，`server/config.ts` 里的 `DATA_META` 是写死的常量。没有数据源适配层、没有定时任务、没有 DB/Redis。
2. **真正需要“实时”的只有价格类字段**（现价、涨跌幅、成交量/额、由此派生的股息率与距研究价距离）。分红预测、派息率、现金流覆盖、ROE/PE、风险事件都可以日频甚至事件驱动。
3. **推荐组合**：P0 用腾讯 `qt.gtimg.cn` 为主源 + 新浪 `hq.sinajs.cn` 兜底（单请求批量、无需密钥、实测 200ms 级）；P1 在同一 `QuoteProvider` 接口下接 iFinD（本环境 MCP 已实测可用）；Tushare 的 `rt_k` 实时日线（200 元/月）作为合规备选。**不建议**为这个场景上 QMT/Level-2/逐笔。
4. **架构要点**：Provider 抽象 + 多源 fallback + 单飞（single-flight）批量缓存 + 令牌桶限流 + 熔断 + **行情时间戳与陈旧度全链路透传**。服务端 15 秒轮询观察仓（≤30 只），前端 15 秒拉 `/api/quotes`；盘中 tick 不落库，收盘后只固化一根日线。
5. **第一步**：先跑 `scripts/live-quote-probe.ts` 验证网络与字段口径（本文已跑通并附原始数据），再按 P0 清单落 `shared/quote-types.ts` + `server/providers/tencent.ts` + `GET /api/quotes`。

---

## 1. 项目现状盘点

### 1.1 现有数据流

```
server/demo-data.ts  ──(合成 90 根日K + 分红/风险种子)──▶  DemoState（内存）
                                                             │
server/snapshot.ts ──▶ server/research.ts analyzeStock ──▶ Stock 快照（纯函数派生）
                                                             │
server/app.ts  /api/dashboard、/api/stocks/:symbol ──────────┘
                                                             │
src/api.ts ──fetch──▶ src/App.tsx（一次性加载 + 手动刷新按钮）──▶ 各页面
```

| 关注点 | 现状 | 关键文件 |
| --- | --- | --- |
| 数据来源 | 纯演示数据，6 只标的，行情截至 `AS_OF = '2026-10-23'` | [config.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/server/config.ts) |
| 数据源适配层 | **不存在**。`createDemoState()` 直接把种子写进内存 | [demo-data.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/server/demo-data.ts) |
| 缓存 | 无缓存层。状态在进程内存（`DemoState`） | [state.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/server/state.ts) |
| 持久化 | 仅三份 JSON 原子写入：`assumptions.json`、`risks.json`、`portfolio.json` | `server/.data/`、`*-store.ts` |
| 数据库 / Redis | **无**。`package.json` 依赖只有 express/cors/react/lucide/tsx | [package.json](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/package.json) |
| 定时任务 | **无 scheduler**。`reminder.ts` 只是被动冷却记录，没有任何 cron/interval | [reminder.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/server/reminder.ts) |
| 前端取数 | 进页面拉一次 `/api/dashboard`，之后只在写操作后重拉；刷新需手点按钮 | [App.tsx](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/src/App.tsx#L70-L86) |
| 行情时间 | `DATA_META.quoteTime` 常量；前端 `data-ribbon` 直接展示 | [Dashboard.tsx](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/src/pages/Dashboard.tsx#L59-L62) |
| 复权口径 | 演示数据先还原含权序列，再做前复权 | `buildMarketHistory()` |
| 行情时间/版本标识 | `DataMode = 'demo' \| 'live'` 已预留，`live` 分支从未实现 | [types.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/shared/types.ts#L1) |

### 1.2 五个直接决定接入方案的事实

1. **价格不是 `Stock.price`，而是 `history` 最后一根收盘价。**
   [research.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/server/research.ts#L283-L306) 中 `const price = history[history.length - 1].close;`，随后才派生 `changePct`、`dividendYield`、`percentB`、评分与等级。`Stock.price` 只在建种子时写入，之后被快照覆盖。
   **含义**：想接实时价，最小改动是“把盘中快照写进今天的最后一根 bar”；否则必须改造 `analyzeStock` 的入参（影响面更大）。

2. **`histories` 只在内存，不落盘。**
   重启后靠 `createDemoState()` 重新合成。接真实数据后必须补一份日线持久化，否则每次重启都没有历史。

3. **没有数据源抽象。** 所有数据都从 `DemoState` 直读，路由里没有 await 任何外部 IO。

4. **没有 scheduler。** 若要做盘中轮询，需要新增一个显式的启动/停止入口，并挂到 [index.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/server/index.ts#L35-L41) 的 `app.listen` 之后。

5. **前端没有轮询基础设施**，但已有请求序列号防乱序（`dashboardSeq`/`detailSeq`）。实时刷新可以复用同一套“只接受最新响应”的模式。

### 1.3 可以直接复用的设计

- `DataMode` 已区分 `demo` / `live`，`MarketDataMeta` / `DataMeta` 已经把行情时间、复权口径、PE/ROE 口径显式建模——**接入时不需要改类型契约的语义，只需补字段**。
- 所有研究结论都是纯函数派生（`snapshot.ts` → `analyzeStock`），只要价格输入变了，等级/评分/信号会自动重算，不存在缓存不一致。
- 写操作统一返回重算后的快照，前端不拼接派生数据——实时行情也应遵守同一原则。

---

## 2. 数据源横向比较

### 2.1 总表

| 数据源 | 接入形态 | 最小粒度 / 频率 | 实测 RTT | 覆盖字段 | 权限门槛 | 成本 | 稳定性 | 合规/许可 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **腾讯行情** `qt.gtimg.cn` | HTTP GET，可批量拼接代码 | 3 秒级快照【推测，本次仅收盘后采样】 | 【实测】3 只 181ms | 现价/昨收/开高低/成交量额/涨跌幅/换手/PE/PB/市值/买卖 5 档 | 无 | 免费 | 高，老牌接口；GBK 编码 | 【未找到公开资料】无商用授权条款；行情版权归交易所 |
| **新浪行情** `hq.sinajs.cn` | HTTP GET，可批量 | 3 秒级【推测】 | 【实测】3 只 119ms | 现价/昨收/开高低/量额/买卖 5 档（无 PE/PB） | 必须带 `Referer`（【实测】缺失即 403） | 免费 | 中高，Referer 校验较严 | 同上 |
| **东方财富 push2** `ulist.np/get` | HTTP GET，批量 `secids` | 3 秒级【推测】 | 【实测】3 只 321ms | 现价/涨跌/量额/开高低/昨收；**不返回行情时间**，无盘口 | 无 | 免费 | 中：批量接口正常，单票 `stock/get` 在本机传输层失败 | 同上 |
| **AkShare** | Python 库，封装上述公开源 | 取决于底层源 | 未测（非本项目栈） | 极全（行情/财务/分红/公告） | 无 | 免费（开源） | 依赖上游，接口会失效 | 官方声明“仅用于学术研究”，商用风险自担【公开资料】 |
| **Tushare Pro** | HTTP/SDK | `rt_k` 实时日线（9:30 起）；`rt_min` 实时分钟 | 未测（无 token） | 实时日线：全市场 OHLC/量额；分钟：1/5/15/30/60 | 需单独开通权限（非积分） | 实时日线 **200 元/月**；实时分钟 **1000 元/月**；历史分钟 2000 元/年；机构价为个人 10 倍【公开资料】 | 高 | 正规数据商，个人授权仅限自用 |
| **同花顺 iFinD** | 官方 quantapi（HTTP/Python）；本环境有 MCP | 实时快照；1 分钟高频；日频财务 | 【实测】实时 3 只秒级返回 | 实时：最新价/涨跌幅/量额/换手/PE TTM/市值等；高频：1 分钟 OHLC + MA/MACD/KDJ/RSI | 账号 + token；MCP 免费版 2000 次总量 | MCP 个人订阅 **40 / 99 / 199 元/月**（3000 / 8000 / 20000 次，专业版起含“实时通道 5 次/秒”）；终端约 0.88–2 万元/年（媒体口径，未逐档核实）【公开资料】 | 高 | 商业授权，禁止未授权再分发 |
| **Wind** | 金融终端 / WindPy / Alice | 实时、逐笔、Level-2（按套餐） | 未测（本环境无 Wind MCP/凭证） | 全 | 终端账号 + API 授权 | 基础终端约 **3.98 万元/年**，全套可超 10 万元（媒体口径）【公开资料】 | 高 | 严格按合同授权，禁止转售 |
| **东方财富 Choice** | 终端 / EM Quant API | 实时、逐笔（按套餐） | 未测（本环境 Eastmoney MCP 只返回日频） | 全 | 账号 + API 授权 | 媒体口径约 0.5–1.8 万元/年，两篇报道不一致，**以官方报价为准**【公开资料】 | 高 | 同上 |
| **QMT / miniQMT** | 券商终端内置 Python，本机进程 | tick / 3 秒 / 逐笔（券商而异） | 未测（本环境 tdx MCP 不可用） | 行情 + **交易下单绑定在同一终端** | 券商开户 + 权限申请 | 多数券商要求 **100 万**资产，部分 30–50 万【公开资料】 | 高（本地终端） | 受程序化交易新规约束；miniQMT 属“外接”形态，监管更严 |
| **Ptrade** | 券商托管 Python | 同上 | 未测 | 行情 + 交易绑定 | 券商开户 + 权限 | 同 QMT，券商而异【推测】 | 高 | 托管环境，策略在券商侧运行 |
| **恒生（UF2.0/UFT）** | 机构柜台接口 | 逐笔 / Level-2 | 未测 | 全 | 机构客户，个人不可得 | 【未找到公开资料】 | — | 机构合同 |
| **聚合数据等 API 聚合商** | 第三方 HTTP API | 快照 / 日频 | 未测 | 视套餐 | 注册 + 付费 | 按次/套餐【未找到公开资料】 | 中 | 数据来源不透明，需自行确认转授权 |

> 说明：上表“实测 RTT”是 **2026-10-29 15:00 收盘后** 单次 3 只标的的 HTTP 往返，不等于盘中推送延迟。盘中真实刷新节奏未在本次会话内连续采样，故标【推测】。

### 2.2 分源要点

**免费公开接口（腾讯 / 新浪 / 东财）**

- 优点：零成本、无需登录、支持一次请求多只（天然满足“批量拉取、避免逐只请求”）。
- 缺点：
  - 无 SLA、无公告，字段随时可能变；
  - 成交量单位不一致（腾讯/东财是“手”，新浪是“股”，实测差 42 股即为手取整误差）；
  - 东财批量接口**不返回行情时间**，只能拿本机时间当 `quoteTime`，陈旧度判断会失真；
  - 腾讯/新浪返回 **GBK**，Node 侧必须用 `TextDecoder('gbk')`，否则中文名乱码（本次实测踩到）。
- 许可：三个站点均无公开的商用授权条款，行情版权属于交易所。**自用研究可以，对外提供展示/再分发不行。**

**AkShare**

- 本质是上面这些公开源的 Python 封装，不是独立数据源；它的官方声明写明“仅用于学术研究”，并明确可能随时移除接口。
- 本项目是 Node/TS 技术栈，引入 AkShare 意味着多一个 Python 旁路服务，**不推荐**作为主链路；可作为离线研究/校验工具。

**Tushare Pro**

- 日频数据靠积分，实时数据靠**单独开权限**（与积分无关）；
- `rt_k` 一次可提取全市场（6000 条），每分钟 50 次，200 元/月——对“只盯 20–30 只”的场景是明显过剩，但对“全市场高股息扫描”是低成本的正规方案；
- 机构价是个人 10 倍，公司主体采购需按机构价。

**iFinD / Wind / Choice**

- 三家都是“终端 + API”双轨：终端用于人看，API 用于程序取数，实时权限通常要额外开通。
- 本环境 **iFinD MCP 实测可用**（见 §3），是唯一“开箱能拉到真实盘中数据”的商用源；Wind 与 Choice 在本会话没有可调用的 MCP 工具，需要用户提供账号/token 后才能验证。
- 价格数字均来自媒体报道（证券时报、21 世纪经济报道），**不是官方报价**，采购前必须以销售合同为准。

**券商通道（QMT / Ptrade / 恒生）**

- 核心特征是**行情与交易绑定**：拿到行情的代价是开立账户并把策略跑在券商终端/托管环境里。
- Level-2 因券商而异，且交易所对 Level-2 展示/非展示使用单独收费；上证所信息网络对 Level-2 展示许可申请方还有“注册资金 1000 万元以上、已获 Level-1 展示许可 2 年以上”等门槛【公开资料】——这说明 **Level-2 不是“接个接口”那么简单**。
- 对本项目：只做研究辅助、不下单，**没有必要**为此开户。

### 2.3 选型结论

| 阶段 | 组合 | 理由 |
| --- | --- | --- |
| P0（跑通） | 腾讯主 + 新浪备 + 东财第三备 | 全免费、批量、字段够用；三源互为兜底可抵消单源故障 |
| P1（正规化） | iFinD 主 + 腾讯备（或 Tushare `rt_k`） | 有合同与 SLA；iFinD 本环境已验证；Tushare 适合全市场扫描 |
| P2（推送） | 保持同一 Provider，仅把“拉”换成“服务端推 SSE 给浏览器” | 不引入 QMT/Level-2 |

---

## 3. 本环境实测结果

### 3.1 可用能力清单

| 能力 | 形态 | 本次状态 | 凭证要求 |
| --- | --- | --- | --- |
| 同花顺 iFinD 实时快照 | MCP `i_stock_highfreq`（`data_mode=real_time`） | ✅ 成功，返回 3 只真实盘中数据 | 已配置（本会话可用） |
| 同花顺 iFinD 1 分钟高频 | 同上（`data_mode=highfreq`） | ✅ 成功，返回当日 09:30 起分钟序列 | 已配置 |
| 东方财富 MCP（自然语言取数） | MCP `mx_ashare_finance_data` | ✅ 成功，但返回**日频**（最新 2026-10-28 收盘），非盘中 | 已配置 |
| 通达信 tdx MCP | MCP `tdx_quotes` / `tdx_lookup_stock` | ❌ 失败：`command response error (6003): list tools failed` | **需用户配置 TDX API Key** |
| Wind AIFin | 技能（无本地 MCP 工具） | ⚠️ 未实测：本会话没有可调用的 Wind 数据工具 | **需用户提供 Wind 账号/授权** |
| Tushare Pro | 无 MCP，仅技能说明 | ⚠️ 未实测 | **需用户提供 Tushare token 并开通实时权限** |
| 腾讯 / 新浪 / 东财公开接口 | 本机 HTTP | ✅ 全部成功（见 §3.2） | 无需 |

### 3.2 实测样例（2026-10-29 15:07，收盘后）

> 收盘后价格已定格，正好用来核对三源口径是否一致；盘中的刷新节奏未在本会话连续采样。

**A. 腾讯 `qt.gtimg.cn`（3 只一次请求，181ms）**

```text
source=tencent 请求耗时=181ms 条数=3
601318.SH | 中国平安 | price=53.2  | changePct=1.70% | volume=100009200 | quoteTime=2026-10-29T15:07:34+08:00
600941.SH | 中国移动 | price=101.47 | changePct=2.10% | volume=10950900  | quoteTime=2026-10-29T15:07:25+08:00
000333.SZ | 美的集团 | price=87.48  | changePct=1.83% | volume=28440800  | quoteTime=2026-10-29T15:07:30+08:00
```

原始报文（节选，`~` 分隔，索引 30 为快照时间）：

```text
v_sh601318="1~中国平安~601318~53.20~52.31~52.25~1000092~612073~388020~...~20261029150722~0.89~1.70~53.20~51.42~53.20/1000092/5262308390~1000092~526231~0.94~9.77~...";
```

索引对照：3=现价 4=昨收 5=今开 6=成交量(手) 30=快照时间 31=涨跌额 32=涨跌幅 33=最高 34=最低 36=成交量(手) 37=成交额(万元)。

**B. 新浪 `hq.sinajs.cn`（3 只，119ms，必须带 Referer）**

```text
source=sina 请求耗时=119ms 条数=3
601318.SH | 中国平安 | price=53.2  | changePct=1.70% | volume=100009242 | quoteTime=2026-10-29T15:07:38+08:00
600941.SH | 中国移动 | price=101.47 | changePct=2.10% | volume=10950904  | quoteTime=2026-10-29T15:07:38+08:00
000333.SZ | 美的集团 | price=87.48  | changePct=1.83% | volume=28440848  | quoteTime=2026-10-29T15:07:30+08:00
```

原始报文：

```text
var hq_str_sh601318="中国平安,52.250,52.310,53.200,53.200,51.420,53.180,53.200,100009242,5262308390.000,...,2026-10-29,15:07:24,00,H|20400|1085280.00";
```

字段顺序：0=名称 1=今开 2=昨收 3=现价 4=最高 5=最低 8=成交量(**股**) 9=成交额 30=日期 31=时间。

**C. 东方财富 `push2/ulist.np`（3 只，321ms；**不返回行情时间**）**

```json
{"rc":0,"rt":11,"data":{"total":3,"diff":[
 {"f2":53.2,"f3":1.7,"f4":0.89,"f5":1000092,"f6":5262308390.0,"f12":"601318","f14":"中国平安","f15":53.2,"f16":51.42,"f17":52.25,"f18":52.31},
 {"f2":101.47,"f3":2.1,"f4":2.09,"f5":109509,"f6":1106801679.0,"f12":"600941","f14":"中国移动","f15":101.8,"f16":99.05,"f17":99.38,"f18":99.38},
 {"f2":87.48,"f3":1.83,"f4":1.57,"f5":284408,"f6":2471982178.21,"f12":"000333","f14":"美的集团","f15":87.58,"f16":85.88,"f17":85.95,"f18":85.91}]}}
```

> f2 单位元、f5 单位**手**；整个响应没有时间字段，只能落本机抓取时间。

**D. iFinD MCP 实时快照（`data_mode=real_time`，采样于 14:57，收盘前）**

```text
证券代码   证券简称  time                最新价  涨跌幅              成交量   成交额          换手率 市盈率TTM
601318.SH  中国平安  2026-10-29 14:57:03  53      1.3190594532594107  960889   5.05374842965E9 0.9014 9.73657538
600941.SH  中国移动  2026-10-29 14:57:03  101.49  2.1231636144093375  109065   1.10229641111E9 1.2081 17.21053557
000333.SZ  美的集团  2026-10-29 14:57:00  87.3    1.617972296589455   281965   2.45061081421E9 0.4095 15.01035022
```

（iFinD 成交量单位是**手**；这也是它比腾讯/新浪多出 PE TTM、换手率的地方。）

**E. iFinD MCP 1 分钟高频（`data_mode=highfreq`, `interval=1`）**

```text
601318.SH 中国平安 2026-10-29 09:30 收盘价=52.25 最高=52.25 最低=52.25 成交量=3104200
601318.SH 中国平安 2026-10-29 09:31 收盘价=51.50 最高=52.00 最低=51.50 成交量=2873000
...（当日 09:30 起逐分钟）
```

### 3.3 实测暴露的口径差异（这是接入时最容易踩的坑）

| 差异 | 证据 | 处理方式 |
| --- | --- | --- |
| 成交量单位 | 腾讯 100,009,200 股 vs 新浪 100,009,242 股 | 腾讯/东财原始单位是“手”，乘 100 后与新浪差在手取整；统一以“股”为内部单位并保留原始值 |
| 编码 | 腾讯/新浪返回 GBK，直接 `response.text()` 中文名乱码 | Node 用 `new TextDecoder('gbk').decode(await res.arrayBuffer())` |
| 行情时间 | 东财 ulist 不返回时间 | 只能落 `fetchedAt`，同时把 `quoteTime` 标为“抓取时间（非交易所时间）”，前端文案必须区分 |
| 涨跌幅精度 | 东财 f3 直接给两位小数 1.70/2.10/1.83；新浪需自算，得 1.7014/2.1030/1.8275 | 内部统一用未舍入值计算，展示时再舍入（与现有 `research.ts` 的“决策用未舍入值”原则一致） |
| 收盘后时间戳仍在前进 | 15:00 后腾讯返回 `15:05:28`、新浪返回 `15:05:40`，但价格与成交量不再变化 | 说明该字段是**快照生成时间**，不是“最后成交时间”。陈旧度不能用它判断，必须用“最近一次成功抓取时间” + 交易时段 |
| 收盘后两源时间戳行为不同 | 16:36 复测：腾讯时间戳已走到 `16:14:52` 仍在前进；新浪停在 `15:34:58` 后冻结 | 两源对“收盘后快照时间”的处理策略不同，进一步证明不能跨源比较 `quoteTime`，只能作溯源展示 |

---

## 4. 场景判断：高股息雷达到底需要多“实时”

### 4.1 指标实时性分级

| 指标 | 是否必须实时 | 理由 | 建议刷新 |
| --- | --- | --- | --- |
| 现价 / 涨跌幅 | **必须**（准实时即可） | 股息率、距研究价距离、%B 都由价格派生；用昨收做决策会系统性偏差 | 盘中 15s，收盘后停止 |
| 当日成交量 / 成交额 | 需要 | 判断放量、流动性、除息日异常 | 同上 |
| 股息率（预测分红 ÷ 现价） | **必须**（随价格变） | 这是本产品的核心排序指标 | 随价格重算，无需单独拉数 |
| 距 L1/L2/L3 研究价距离 | **必须** | 用户真正关心的“是否触发” | 随价格重算 |
| 组合市值 / 仓位占比 / 浮盈 | 需要 | 影响资金信号与评分 | 随价格重算 |
| %B / 布林 / MA20 / ATR | **日频足够** | 技术指标基于日线收盘；盘中把它改成分钟级会改变策略语义 | 收盘后重算 |
| 预测每股分红 / 派息率 / 现金流覆盖 | 日频（事件驱动） | 只在年报/中报/分红公告时变化 | 每日一次或公告触发 |
| PE / PB / ROE | 日频 | PE 随价格变，但研究结论不靠分钟级 PE | 每日收盘后 |
| 分红历史 / 除权除息日 | 事件驱动 | 除息日会改变前复权序列 | 每日校验 |
| 风险事件 / 公告 | 事件驱动（人工核验） | 现有设计就是人工核验 + 有效期 | 不接实时 |

### 4.2 结论

- **本产品的主战场是“收盘后批量财务/股息筛选”，不是盘中交易。** 实时数据的价值集中在三件事：
  1. 盘中价格触达研究价时给出提示（而不是等第二天开盘才发现）；
  2. 避免把“昨天的收盘价”当成“今天的决策价”；
  3. 除息日/停牌/ST 等异常状态能被及时发现。
- **不需要**：逐笔成交、Level-2 十档、tick 级存储、消息队列。这些会把一个单进程 Express 研究工具推向“伪量化平台”，成本与合规风险都不划算。
- **量化指标**：观察仓 6 只（当前种子）到 30 只（合理上限），单次批量 1 个请求，15 秒一轮 = **4 请求/分钟**；免费源完全承受得住，商用源也在最低档套餐内。

---

## 5. 推荐架构

### 5.1 分层

```
                 ┌──────────────── 浏览器 ────────────────┐
                 │  15s 轮询 /api/quotes（可见时），隐藏暂停  │
                 └───────────────┬───────────────────────┘
                                 │ JSON（含 quoteTime / stale / sessionState）
                 ┌───────────────▼───────────────────────┐
                 │  server/routes：/api/quotes             │  校验 symbols / 批量上限
                 └───────────────┬───────────────────────┘
                 ┌───────────────▼───────────────────────┐
                 │  QuoteService                           │  单飞 + TTL 缓存 + 多源 fallback
                 │  ├─ 令牌桶限流 / 指数退避重试            │
                 │  ├─ 熔断（连续失败 → open 30s）          │
                 │  └─ 陈旧度计算（结合交易时段）           │
                 └───────────────┬───────────────────────┘
        ┌────────────────────────┼────────────────────────┐
   tencent.ts               sina.ts                 eastmoney.ts / ifind.ts / tushare.ts
        └────────────────────────┴────────────────────────┘
                                 │
                 ┌───────────────▼───────────────────────┐
                 │  QuoteScheduler（setInterval，仅盘中）  │
                 │  观察仓 ∪ 持仓 → 批量刷新 → 写缓存        │
                 └───────────────────────────────────────┘
```

### 5.2 统一 Quote 类型（新增 `shared/quote-types.ts`）

```ts
import type { DataMode } from './types.ts';

export type QuoteSource = 'tencent' | 'sina' | 'eastmoney' | 'ifind' | 'tushare' | 'demo';

/** 交易时段：由服务端判定并透传，前端不自己猜。 */
export type SessionState = 'pre-open' | 'open' | 'lunch-break' | 'closed' | 'non-trading-day';

export interface Quote {
  symbol: string;          // 统一 601318.SH
  name: string;
  price: number;
  prevClose: number;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number;          // 统一“股”
  amount: number | null;   // 统一“元”
  changePct: number;       // 未舍入
  /** 数据源给出的行情时间，ISO 8601。实测为“快照生成时间”而非最后成交时间，仅用于溯源展示。 */
  quoteTime: string;
  /** 服务端抓取时间。 */
  fetchedAt: string;
  source: QuoteSource;
  /** 该源是否返回行情时间；false 表示只能用 fetchedAt 兜底（如东财 ulist）。 */
  quoteTimeReliable: boolean;
  sessionState: SessionState;
  stale: boolean;
  staleSeconds: number;
}

export interface QuoteSnapshotResponse {
  dataMode: DataMode;
  sessionState: SessionState;
  quotes: Quote[];
  /** 主源失败降级时如实记录，前端必须展示。 */
  degraded: { from: QuoteSource; to: QuoteSource; reason: string } | null;
}

export interface QuoteProvider {
  readonly id: QuoteSource;
  /** 单次请求上限，服务端据此切批。 */
  readonly maxBatch: number;
  readonly quoteTimeReliable: boolean;
  fetchQuotes(symbols: string[], signal: AbortSignal): Promise<Quote[]>;
}
```

### 5.3 服务层：单飞 + TTL + fallback（`server/quote-service.ts`）

```ts
interface CacheEntry { quote: Quote; expiresAt: number; lastSuccessAt: number }

export interface QuoteServiceOptions {
  /** 盘中 TTL；建议 5s，小于轮询间隔。 */
  ttlMs: number;
  /** 收盘后 TTL；行情不再变化，可放宽到 5 分钟。 */
  closedTtlMs: number;
  /** 判定陈旧的阈值；盘中建议 60s。 */
  staleMs: number;
  /** 主源顺序，前一个失败自动降级。 */
  fallbackOrder: QuoteSource[];
}

export function createQuoteService(
  providers: Map<QuoteSource, QuoteProvider>,
  options: QuoteServiceOptions,
) {
  const cache = new Map<string, CacheEntry>();
  /** 同一批 symbols 的并发请求只打一次上游。 */
  const inflight = new Map<string, Promise<void>>();
  const breakers = new Map<QuoteSource, CircuitBreaker>();

  async function loadBatch(batch: string[], signal: AbortSignal): Promise<Quote[]> {
    const errors: string[] = [];
    for (const source of options.fallbackOrder) {
      const provider = providers.get(source);
      const breaker = breakers.get(source);
      if (!provider || breaker?.isOpen()) continue;
      try {
        const quotes = await breaker!.run(() => provider.fetchQuotes(batch, signal));
        breaker!.succeed();
        return quotes;
      } catch (error) {
        breaker!.fail();
        errors.push(`${source}: ${(error as Error).message}`);
      }
    }
    throw new Error(`全部行情源失败：${errors.join('；')}`);
  }

  async function refresh(symbols: string[]): Promise<void> {
    const key = [...symbols].sort().join(',');
    const running = inflight.get(key);
    if (running) return running;

    const task = (async () => {
      const session = resolveSessionState(new Date());
      const ttl = session === 'open' ? options.ttlMs : options.closedTtlMs;
      const missing = symbols.filter((symbol) => {
        const entry = cache.get(symbol);
        return !entry || entry.expiresAt <= Date.now();
      });
      if (missing.length === 0) return;

      for (const batch of chunk(missing, providers.get('tencent')!.maxBatch)) {
        const quotes = await loadBatch(batch, AbortSignal.timeout(8_000));
        const now = Date.now();
        for (const quote of quotes) {
          cache.set(quote.symbol, {
            quote: { ...quote, sessionState: session },
            expiresAt: now + ttl,
            lastSuccessAt: now,
          });
        }
      }
    })().finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
  }

  /** 上游失败时返回上一次成功的快照，并标记 stale —— 绝不清空。 */
  async function getSnapshot(symbols: string[]) {
    try {
      await refresh(symbols);
    } catch {
      /* 降级：继续读缓存 */
    }
    const session = resolveSessionState(new Date());
    const now = Date.now();
    const quotes = symbols
      .map((symbol) => cache.get(symbol))
      .filter((entry): entry is CacheEntry => Boolean(entry))
      .map(({ quote, lastSuccessAt }) => {
        const staleSeconds = Math.round((now - lastSuccessAt) / 1000);
        /** 只按“距离最近一次成功抓取”判陈旧；收盘后不判 stale。 */
        return {
          ...quote,
          sessionState: session,
          stale: session === 'open' && staleSeconds * 1000 > options.staleMs,
          staleSeconds,
        };
      });
    return { quotes, degraded: /* 记录本次 fallback 来源 */ null };
  }

  return { refresh, getSnapshot };
}
```

关键设计点：

- **TTL 必须小于轮询间隔**，否则缓存形同虚设；盘中 5s、收盘 300s。
- **单飞（inflight）**：前端多个标签页同时刷新时，上游只被请求一次。
- **降级读缓存**：上游全挂时返回上一次快照并置 `stale=true`，绝不返回空数组让前端显示 0。
- **熔断**：连续 5 次失败 → 打开 30s，避免把免费源打到封 IP。

### 5.4 限流与重试

```ts
/** 令牌桶：免费源建议 2 次/秒、突发 5；商用源按其套餐并发上限配置。 */
function createTokenBucket(ratePerSecond: number, capacity: number) {
  let tokens = capacity;
  let last = Date.now();
  return async function take(): Promise<void> {
    while (true) {
      const now = Date.now();
      tokens = Math.min(capacity, tokens + ((now - last) / 1000) * ratePerSecond);
      last = now;
      if (tokens >= 1) { tokens -= 1; return; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
}
```

- 重试：仅对网络错误/5xx 重试，指数退避 300ms → 900ms → 2.7s，带 ±30% 抖动；4xx（含 403 反爬）**不重试**，直接切下一个源。
- 批量：单批 ≤ provider.maxBatch（腾讯实测 3 只没问题，建议按 50 只一批验证后再放大）；30 只观察仓实际上 1 批即可。

### 5.5 陈旧与时间戳透传（硬性要求）

- **不要把 `quoteTime` 当作“最后成交时间”。** 实测：收盘后腾讯/新浪的时间戳仍在前进（15:05:28 / 15:05:40），价格与成交量却不再变化——它是**快照生成时间**。用它判陈旧会永远显示“新鲜”。
- 陈旧判定只看：`session === 'open' && now - lastSuccessAt > staleMs`（`lastSuccessAt` 为服务端最近一次成功抓取）。**收盘/午休不判 stale**，改由 `sessionState` 表达。
- 东财 ulist 不返回行情时间，`quoteTimeReliable=false`，`quoteTime` 回落为 `fetchedAt` 并在前端注明。
- 服务端在 `/api/dashboard`、`/api/stocks/:symbol` 的 `dataMeta` 中同步透传 `quoteSource`、`quoteTime`、`sessionState`，保证任何页面拿到的数据都自带出处与时效。

### 5.6 价格如何进入现有派生链（最小改动）

现有链路：`history` 最后一根 close → `analyzeStock` → 全部指标与等级。

推荐 **方案 A（最小改动）**：盘中把今日快照写进 `history` 的最后一根 bar（覆盖 close/high/low/volume），沿用现有纯函数派生，等级/评分/%B 自动随价格变化。

```ts
/** 盘中覆盖最后一根日线：前复权以最新价为锚，覆盖当日 bar 不会破坏历史序列。 */
export function applyLiveQuoteToHistory(history: PriceBar[], quote: Quote): PriceBar[] {
  if (history.length === 0) return history;
  const last = history[history.length - 1];
  if (last.date !== quote.quoteTime.slice(0, 10)) return history; // 跨日：等收盘后再追加
  const updated: PriceBar = {
    ...last,
    high: Math.max(last.high, quote.high ?? quote.price),
    low: Math.min(last.low, quote.low ?? quote.price),
    close: quote.price,
    volume: quote.volume,
  };
  return [...history.slice(0, -1), updated];
}
```

必须注意的两点：

1. **前复权以最新价为锚**，当日 bar 的原始价与前复权序列天然一致，所以覆盖是安全的；但**除息日必须重算整段前复权序列**，否则会出现价格断层，%B 会被误判为超跌。
2. 若不想让技术指标受盘中价格影响（更保守），则采用 **方案 B**：`analyzeStock` 只把实时价用于 `dividendYield`、`changePct` 与“距研究价距离”，`percentB`/布林继续用上一交易日收盘。方案 B 改动稍大（要给 `analyzeStock` 增加 `livePrice` 入参），但策略语义更干净。

**建议**：P0 用方案 A 快速跑通；P1 再评估是否切到方案 B（取决于用户是否接受盘中 %B 波动）。

---

## 6. 后端接入方式：轮询 vs WebSocket vs 消息队列

| 维度 | 服务端轮询（推荐） | WebSocket / SSE 推送 | 消息队列 |
| --- | --- | --- | --- |
| 复杂度 | 低：一个 `setInterval` + 一个 GET | 中：连接管理、心跳、重连、多标签页 | 高：需部署 broker |
| 实时性 | 15s 足够；3s 也可（20 次/分钟） | 秒级 | 秒级 |
| 与现有架构契合 | 完全契合（无状态 Express + 纯函数派生） | 需新增长连接端点；Vite 开发代理已把 `/api` 转发到 `:4174`（[vite.config.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/vite.config.ts#L6-L11)），SSE 还需关闭代理缓冲 | 与单进程内存状态冲突 |
| 上游压力 | 1 请求/批/轮 | 同（服务端仍要向上游取数） | 同 |
| 失败降级 | 天然可用“上次快照” | 需自行实现断线重连与快照补发 | 复杂 |
| 适用阶段 | **P0 / P1** | P2（多标签页/多用户时） | 不需要 |

**结论**：

- **服务端 → 数据源**：轮询。免费源与 iFinD 均为请求式接口；Tushare 公开文档中仅“期货实时分钟”标注支持 SDK/HTTP/WebSocket，A 股实时日线仍是请求式【公开资料】。
- **服务端 → 浏览器**：P0/P1 用前端 15s 轮询 `/api/quotes`；P2 若出现“多标签页重复拉取”或多用户场景，再升级为 **SSE**（比 WS 简单，天然兼容 HTTP 代理与断线重连）。
- **消息队列**：本项目是单实例、无横向扩展需求，引入 MQ 属于过度设计。

### 6.1 与现有 scheduler 的衔接

项目当前没有 scheduler，需要新增一个显式生命周期入口：

```ts
// server/quote-scheduler.ts
export function startQuoteScheduler(
  service: ReturnType<typeof createQuoteService>,
  collectSymbols: () => string[],
  intervalMs: number,
): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;                       // 上一轮未结束则跳过，避免堆积
    if (resolveSessionState(new Date()) !== 'open') return; // 非交易时段不轮询
    running = true;
    try {
      await service.refresh(collectSymbols());
    } catch (error) {
      console.error('[quote] 刷新失败：', (error as Error).message);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();                              // 不阻塞进程退出
  return () => clearInterval(timer);
}
```

挂载位置：[index.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/server/index.ts#L43-L58) 的 `app.listen` 回调之后；`collectSymbols` 直接复用 `collectPortfolioSymbols(state)`（观察仓 ∪ 有持仓的标的，见 [state-change.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/server/state-change.ts#L32-L38)）。关闭顺序：先 `stop()` scheduler，再关 HTTP server，避免退出时还在打上游。

另需一个收盘任务（15:05）：把当日最终快照固化为一根日线并落盘，顺便刷新 PE/PB。

### 6.2 交易时段判断

```ts
export function resolveSessionState(now = new Date()): SessionState {
  const shanghai = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const day = shanghai.getDay();
  if (day === 0 || day === 6) return 'non-trading-day';
  const minutes = shanghai.getHours() * 60 + shanghai.getMinutes();
  if (minutes < 9 * 60 + 15) return 'pre-open';        // 含 09:15–09:25 集合竞价
  if (minutes < 11 * 60 + 30) return 'open';
  if (minutes < 13 * 60) return 'lunch-break';
  if (minutes < 15 * 60) return 'open';
  return 'closed';
}
```

**局限**：只处理周末，**不处理法定节假日**。节假日的正确处理需要交易所日历（Tushare `trade_cal`、iFinD 交易日接口），P1 再补；P0 可接受“节假日空跑一轮但拿不到新数据 → 显示陈旧”，不影响正确性。

---

## 7. 存储设计

### 7.1 盘中快照要不要落库？

**结论：不落库。**

| 数据 | 是否持久化 | 保留 | 理由 |
| --- | --- | --- | --- |
| 盘中 tick / 15s 快照 | ❌ | — | 15s × 30 只 × 4 小时 ≈ 2.9 万条/日，对研究结论零增益，写放大明显 |
| 最新快照（last known） | ✅ 单文件 | 覆盖写 | 重启预热 + 前端降级展示 |
| 日线（收盘后一根） | ✅ | 永久 | 技术指标、%B、前复权的唯一基础；当前 `histories` 不落盘，必须补 |
| 交易记录 | 已有 | 永久 | `portfolio-store.ts` 已冻结研究快照；建议补 `quoteTime`/`source` 字段 |
| 除权除息事件 | 已有（演示） | 永久 | 前复权重算的触发条件 |

### 7.2 推荐存储形态（延续现有 JSON 原子写，不引入 DB）

```
server/.data/
├── assumptions.json
├── risks.json
├── portfolio.json
├── quotes-latest.json          # 新增：最后一次成功快照（含 quoteTime/source）
└── bars/
    └── 601318.SH.json          # 新增：日线数组 PriceBar[]，收盘后追加
```

`quotes-latest.json` 结构：

```json
{
  "updatedAt": "2026-10-29T15:05:02+08:00",
  "sessionState": "closed",
  "quotes": {
    "601318.SH": {
      "symbol": "601318.SH", "price": 53.2, "prevClose": 52.31,
      "quoteTime": "2026-10-29T15:00:21+08:00",
      "source": "tencent", "quoteTimeReliable": true
    }
  }
}
```

复用现有 `*-store.ts` 的原子写入模式即可（写临时文件 + rename），无需新依赖。

### 7.3 若未来确需入库（SQLite，仍不建议上独立 DB 服务）

```sql
-- 最新快照（覆盖写）
CREATE TABLE quotes_latest (
  symbol       TEXT PRIMARY KEY,
  price        REAL NOT NULL,
  prev_close   REAL NOT NULL,
  quote_time   TEXT NOT NULL,
  source       TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);

-- 日线（技术指标基础）
CREATE TABLE daily_bars (
  symbol TEXT NOT NULL,
  date   TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL NOT NULL,
  volume REAL NOT NULL,
  adjust TEXT NOT NULL DEFAULT 'forward',
  PRIMARY KEY (symbol, date)
);

-- 可选：仅当需要审计“当时看到的价”时启用，保留 20 个交易日
CREATE TABLE quote_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  quote_time TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
```

**迁移路径**：先 JSON（P0/P1），当 `daily_bars` 超过几十万行或需要多进程写入时再换 SQLite（`better-sqlite3`），接口层不变。

### 7.4 与现有表的关系

- `DemoState.stocks`：只存“研究口径”（预测分红、门槛、质量），**不存实时价**。实时价走 Quote 缓存，避免两处真相。
- `DemoState.histories`：实时价以“覆盖最后一根 bar”的方式进入（见 §5.6），收盘后由 EOD 任务写成永久日线。
- `TradeRecord`：成交时已冻结研究快照；补记 `quoteTime` 与 `source` 后，复盘能回答“这笔交易当时看到的行情是什么”。

---

## 8. 前端展示

### 8.1 新增接口

```ts
// src/api.ts 追加
quotes: (symbols: string[]) =>
  request<QuoteSnapshotResponse>(`/api/quotes?symbols=${symbols.join(',')}`),
```

服务端：

```ts
/** 必须挂在 app.ts 现有路由区（约 L350 附近），且要在末尾 /api 兜底 404（L412）之前。 */
app.get('/api/quotes', async (req, res) => {
  const raw = typeof req.query.symbols === 'string' ? req.query.symbols : '';
  const symbols = raw.split(',').map(normalizeSymbol).filter((s) => state.stocks.has(s));
  if (symbols.length === 0) return void res.status(400).json({ error: '缺少有效的 symbols' });
  if (symbols.length > MAX_BATCH) return void res.status(400).json({ error: `单次最多 ${MAX_BATCH} 只` });
  try {
    res.json(await quoteService.getSnapshot(symbols));
  } catch {
    res.status(503).json({ error: '行情源暂不可用' });
  }
});
```

> 安全：`/api` 已统一挂了来源白名单（[app.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/server/app.ts#L73-L76)）与 `ACCESS_TOKEN` 校验，新路由自动复用；前端 `request()` 已自动带 `Authorization: Bearer`（[api.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/src/api.ts#L21-L31)）。注意 `symbols` 必须白名单过滤到 `state.stocks`，否则会变成“任意代码行情代理”。

### 8.2 轮询 hook（`src/hooks/useLiveQuotes.ts`）

```ts
export function useLiveQuotes(symbols: string[], enabled: boolean) {
  const [snapshot, setSnapshot] = useState<QuoteSnapshotResponse | null>(null);
  const [error, setError] = useState('');
  const key = symbols.join(',');

  useEffect(() => {
    if (!enabled || symbols.length === 0) return;
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;

    const tick = async () => {
      try {
        const next = await api.quotes(symbols);
        if (cancelled) return;
        setSnapshot(next);
        setError('');
        failures = 0;
      } catch (reason) {
        if (cancelled) return;
        failures += 1;
        setError((reason as Error).message);
      } finally {
        if (cancelled) return;
        /** 页面隐藏时降频，失败指数退避，避免把后端与上游打穿。 */
        const base = document.visibilityState === 'visible' ? 15_000 : 60_000;
        timer = window.setTimeout(tick, Math.min(base * 2 ** failures, 180_000));
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [key, enabled]);

  return { snapshot, error };
}
```

要点：沿用 `App.tsx` 已有的“请求序列号 + 只接受最新响应”思路；页面隐藏时暂停/降频；失败不清空旧数据。

### 8.3 展示与降级

| 状态 | 展示 | 颜色/文案 |
| --- | --- | --- |
| 盘中新鲜 | 现价 + 涨跌幅 + 快照时间 `15:00:21` | 正常；绿色小圆点 + “盘中” |
| 盘中陈旧（>60s 未抓到） | 保留价格，追加 | 琥珀色圆点 + “行情延迟 42s” |
| 午休 / 未开盘 | 保留上一价 | 灰色 + “午间休市 / 未开盘” |
| 已收盘 | 保留收盘价 | 灰色 + “已收盘 · 15:00” |
| 请求失败 | **保留最后成功价格**，不清零 | 红色描边 + “更新失败，截至 14:57” |
| 主源降级 | 正常展示，附小字 | “备用源：新浪” |

补充：`Dashboard` 的 `data-ribbon` 目前写死“演示研究环境”，接入后按 `dataMode` 切换文案，并把 `dataNotice` 从“演示数据”改为数据源与授权声明（这是合规要求，不是可选优化）。

---

## 9. 落地清单

### 9.1 文件清单

> 全部为**新增**或**局部追加**，不重写现有业务逻辑。示例脚本 `scripts/live-quote-probe.ts` 已落盘并验证，注明“示例，未接入主流程”。

| 阶段 | 文件 | 职责 | 改动类型 |
| --- | --- | --- | --- |
| P0 | `shared/quote-types.ts` | `RawQuote`/`Quote`/`QuoteSnapshotResponse`/`QuoteProvider`/`SessionState` + `normalizeSymbol` 白名单校验 | ✅ 已完成 |
| P0 | `server/providers/tencent.ts` | 腾讯批量快照适配，GBK 解码、手→股换算、未舍入涨跌幅 | ✅ 已完成（实测通过） |
| P0 | `server/providers/sina.ts` | 新浪兜底适配（带 Referer，缺省 403 已实测） | ✅ 已完成（实测通过） |
| P0 | `server/providers/eastmoney.ts` | 东财批量适配（`quoteTimeReliable=false`） | ✅ 已完成（实测通过） |
| P0 | `server/quote-service.ts` | 单飞缓存、TTL、fallback、令牌桶、熔断、陈旧度（`getSnapshot` 失败降级读缓存） | ✅ 已完成（实测通过） |
| P0 | `server/trading-session.ts` | 交易时段判定（仅周末口径，节假日待 P1 日历） | ✅ 已完成 |
| P0 | `server/quote-scheduler.ts` | 盘中轮询（防重入 + unref；收盘固化随 P1 bar-store） | ✅ 已完成 |
| P0 | `server/app.ts` | 追加 `GET /api/quotes`（白名单过滤 + 上限校验，express 5 自动捕获 async 异常） | ✅ 已完成（实测通过） |
| P0 | `server/index.ts` | 装配 service（全部 env 可选，零配置可用）+ `QUOTE_ENABLE_INTRADAY` 控制 scheduler | ✅ 已完成（实测通过） |
| P0 | `server/config.ts` | `DATA_META` 支持 `live` | ⏸ 推迟到 P1：演示日线未替换前切 live 会误导，随 bar-store 一并切换；当前 `/api/quotes` 的 `dataMode` 跟随 `DATA_META`（demo） |
| P0 | `src/api.ts` | 追加 `quotes()` | ✅ 已完成 |
| P0 | `src/hooks/useLiveQuotes.ts` | 轮询（15s 可见 / 60s 隐藏）+ 退避 + 不清空旧数据 | ✅ 已完成 |
| P0 | `src/components/QuoteBadge.tsx` | `QuoteBadge`（单只：价格/涨跌/时效）+ `QuoteStatusBadge`（仓级：时段/来源/降级/陈旧数） | ✅ 已完成 |
| P0 | `src/pages/Dashboard.tsx`、`src/pages/StockDetail.tsx`、`src/App.tsx`、`src/styles.css` | App 层统一轮询，ribbon 仓级摘要 + 详情页单只徽章 | ✅ 已完成 |
| P0 | `scripts/live-quote-probe.ts` | 三源冒烟探针（示例，未接入主流程；已改为直接复用真实 provider，兼作端到端验证工具） | ✅ 已完成 |
| P1 | `server/providers/kline-eastmoney.ts` | 东财 push2his 前复权日线（实测确认：末根即今日实时值，fqt=1 免自算除息） | ✅ 已完成（实测通过） |
| P1 | `server/bar-store.ts` | 日线原子持久化（`.data/bars/`）+ `applyQuoteToHistory`（方案 A 实时价覆盖当日 bar） | ✅ 已完成（6 个单测通过） |
| P1 | `server/quote-store.ts` | `quotes-latest.json` 原子写 + 重启预热（seed 注入，expiresAt=0 优先拉新、失败降级） | ✅ 已完成（实测通过） |
| P1 | `server/config.ts` | `activateLiveMeta` / `getDataNotice`：启动装配成功后就地切 live，失败自动回退 demo（fail-safe） | ✅ 已完成（实测通过） |
| P1 | `server/index.ts` | 装配：kline→histories→bars→live 切换；`onUpdate` 实时价进派生链；收盘固化；`dataMode` 动态读取 | ✅ 已完成（端到端实测：6 只价格/指标全部真实化） |
| P1 | `server/quote-service.ts` | `onUpdate` / `seed` 钩子 + `dataMode` 改为动态函数（修复 live 切换后 /api/quotes 仍报 demo） | ✅ 已完成 |
| P1 | `server/quote-scheduler.ts` | `onSessionClosed` 收盘边沿回调（open→非 open 触发一次固化） | ✅ 已完成 |
| P1 | `server/providers/ifind.ts`、`tushare.ts` | iFinD / Tushare `rt_k` 适配 | ⏸ 未实施：依赖用户凭证（IFIND token / TUSHARE token），当前免费三源已满足需求，接入前先补探针验证 |
| P1 | `src/App.tsx`、`src/pages/Dashboard.tsx` | 侧边栏/数据条文案按 `dataMode` 切换（真实行情已连接 vs 演示快照已连接） | ✅ 已完成 |
| P1 | `server/quote-live.test.ts` | `applyQuoteToHistory` 覆盖/追加/停牌残留/时区 6 个用例 | ✅ 已完成（npm test 90/90） |
| P2 | `server/routes/quotes-stream.ts` | SSE 推送 | 新增 |
| P2 | `server/quote-store.ts` | 可选 SQLite 迁移 | 扩展 |

### 9.2 配置项

```bash
# .env（可选；已加入 .gitignore。全部缺省即零配置跑通：tencent→sina→eastmoney）
QUOTE_PROVIDER=tencent                # 主源：tencent | sina | eastmoney（P1 后可 ifind | tushare）
QUOTE_FALLBACKS=tencent,sina,eastmoney # 降级顺序，逗号分隔；缺省即此值
QUOTE_ENABLE_INTRADAY=false           # 只控制盘中预取轮询；/api/quotes 按需拉取始终可用
QUOTE_POLL_INTERVAL_MS=15000          # 盘中预取间隔
QUOTE_CACHE_TTL_MS=5000               # 盘中缓存 TTL，必须 < 前端轮询间隔
QUOTE_CLOSED_TTL_MS=300000            # 收盘后缓存 TTL
QUOTE_STALE_MS=60000                  # 陈旧阈值（仅盘中生效）
QUOTE_REQUEST_TIMEOUT_MS=8000         # 单次上游请求超时
QUOTE_RATE_PER_SECOND=2               # 令牌桶速率
QUOTE_RATE_CAPACITY=5                 # 令牌桶突发容量
QUOTE_BREAKER_THRESHOLD=5             # 熔断阈值（连续失败次数）
QUOTE_BREAKER_OPEN_MS=30000           # 熔断打开时长
# QUOTE_MAX_BATCH 不再作为 env：单批大小取降级链上各源 maxBatch 的最小值（当前均 50）

# 商用源凭证（不要暴露给前端，不要提交仓库）
IFIND_ACCESS_TOKEN=
IFIND_REFRESH_TOKEN=
TUSHARE_TOKEN=
TDX_API_KEY=
```

> 已实现默认值集中在 `server/index.ts`；`/api/quotes` 的标的数上限为 `server/app.ts` 的 `MAX_QUOTE_SYMBOLS = 50` 常量。

说明：项目当前直接用 `process.env`，没有 dotenv 依赖。Node ≥20.6 可用 `node --env-file=.env`；若继续用 `tsx`，可在 `server/index.ts` 启动时 `try { process.loadEnvFile('.env') } catch {}`（Node ≥20.12）。无论哪种，`.env` 必须进 `.gitignore`。

### 9.3 分阶段实施

**P0 —— 免费源跑通（不改数据语义，只加一条只读链路）**

1. 落 `shared/quote-types.ts`；
2. 落腾讯/新浪/东财三个 provider + `quote-service.ts`；
3. `GET /api/quotes` 打通，先用 `curl` 验证；
4. 前端 `useLiveQuotes` + `QuoteBadge`，Dashboard 顶部行情条展示“来源 + 时间 + 盘中/已收盘”；
5. `QUOTE_ENABLE_INTRADAY=true` 后再开 scheduler；
6. 验收：断网/屏蔽主源时，页面仍显示上次价格并标“备用源/更新失败”，不出现 0 或空白。

**P1 —— 接商用源 + 日线固化**

1. 落 `ifind.ts`（或 `tushare.ts`），通过 `QUOTE_PROVIDER` 切换，**业务代码零改动**；
2. 按套餐配置令牌桶（iFinD MCP 专业版 5 次/秒）；
3. 落 `bar-store.ts` + 收盘任务，把 `histories` 变成可持久化的真实日线；
4. `dataNotice` 改为真实授权声明，`dataMode` 改为 `live`；
5. 验收：重启服务后历史与技术指标不丢；`dataMeta.quoteSource` 与实际来源一致。

**P2 —— 盘中推送（可选）**

1. SSE `/api/quotes/stream`，替代前端轮询；
2. 若确需审计，再评估 `quote_snapshots` 表与保留策略；
3. **不引入** Level-2/逐笔/消息队列。

### 9.4 验收标准（建议）

| 项 | 标准 |
| --- | --- |
| 时效 | 盘中 30 只标的一轮刷新 ≤ 1 个上游请求，端到端 ≤ 2s（不含 15s 轮询间隔） |
| 一致 | 同一时刻同一标的，三源比价差 ≤ 1 个最小价位；成交量差异仅来自“手→股”取整 |
| 降级 | 主源 403/超时，自动切备源且页面有“备用源”标识 |
| 陈旧 | 盘中超过 60s 未成功抓取，前端出现琥珀色延迟提示 |
| 收盘 | 15:00 后不再产生上游请求；页面显示“已收盘 · 15:00” |
| 安全 | 任何 token 不出现在浏览器 bundle / 网络请求中；`.env` 不入库 |

---

## 10. 风险清单

| 风险 | 表现 | 缓解 |
| --- | --- | --- |
| 免费接口反爬 | 【实测】新浪无 `Referer` 直接 403；高频请求可能被限流/封 IP；字段随时变 | 固定 Referer + UA；2 次/秒令牌桶；多源 fallback；把解析失败当 provider 故障而非崩溃 |
| 封禁与商用风险 | 对公网提供行情展示可能被认定侵权；免费源高频请求会被限流/封 IP | 保持默认“仅回环监听 + 可选 `ACCESS_TOKEN`”（[index.ts](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/server/index.ts#L23-L33)），即本机自用；**不要为了接行情把 HOST 暴露到公网**；对外展示前取得交易所/信息商授权（Level-1/2 展示许可有明确门槛） |
| 字段口径差异 | 复权/停牌/ST/涨跌幅基准/成交量单位不一致 | 内部统一“股/元/未舍入”；`quoteTimeReliable` 显式标注；停牌用“价格与成交量同时为 0 或时间不更新”兜底并提示，不猜测 |
| 除息日断层 | 前复权序列未重算，%B 被误判为超跌 | 除息日强制重算整段前复权；EOD 校验 `lastExDate` |
| 时间与时区 | 服务器 UTC、交易所 +08:00 混用 | 全链路 ISO 8601 带偏移；交易时段用 `Asia/Shanghai` 判定 |
| 密钥管理 | token 写进前端或提交仓库 | 只在服务端读取；`.env` 入 `.gitignore`；`.env.example` 只留空值 |
| 过度实时化 | 引入 tick/Level-2/MQ，复杂度与成本失控 | 明确“收盘后筛选为主、盘中轻量刷新为辅”，P2 前不碰推送与 L2 |
| 数据源单点 | 只接一个免费源，源挂了整站变“演示数据” | 三源 fallback + 缓存降级 + `degraded` 字段 |
| 节假日空跑 | 工作日日历判断在节假日误判为 `open` | P0 可接受（拿不到新数据即陈旧）；P1 接交易所日历 |

---

## 附录 A：复现命令

```bash
# 三个免费源各跑一次（默认 601318.SH / 600941.SH / 000333.SZ）
npx tsx scripts/live-quote-probe.ts --source=tencent
npx tsx scripts/live-quote-probe.ts --source=sina
npx tsx scripts/live-quote-probe.ts --source=eastmoney

# 指定标的与陈旧阈值
QUOTE_STALE_MS=30000 npx tsx scripts/live-quote-probe.ts 601318.SH 600941.SH --source=tencent
```

## 附录 B：本环境 MCP 调用记录

| 调用 | 结果 | 时间戳 |
| --- | --- | --- |
| `i_stock_highfreq`（real_time，3 只） | 成功，返回最新价/涨跌幅/成交量/成交额/换手率/PE TTM | `2026-10-29 14:57:03` |
| `i_stock_highfreq`（highfreq，1 分钟） | 成功，返回当日 09:30 起分钟 OHLC | `2026-10-29 09:30` 起 |
| `mx_ashare_finance_data`（自然语言） | 成功，但为日频（最新 2026-10-28 收盘） | `2026-10-28` |
| `tdx_quotes` / `tdx_lookup_stock` | 失败：`command response error (6003): list tools failed` | — |
| Wind AIFin / Tushare | 本会话无可用工具或无凭证，未实测 | — |

## 附录 C：参考资料

- Tushare 权限与价格：<https://tushare.pro/document/1?doc_id=290>
- Tushare 实时日线接口：<https://tushare.pro/wctapi/documents/372.md>
- iFinD MCP 个人订阅价目：<https://mcp.51ifind.com/#/pricing>
- iFinD 免费版权限说明：<https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center.html>
- miniQMT 开通门槛与 L2 说明：<https://www.miniqmt.com/pages/qanda.html>
- 上证所 Level-2 展示许可申请条件：<https://bsp.sseinfo.com/business/?id=1644178582138449922>
- 上证所信息网络产品服务价格：<https://www.sseinfo.com/services/cpfwjg/>
- Wind 终端年费（媒体报道）：<https://stcn.com/article/detail/3620915.html>
- Choice / iFinD 年费区间（媒体报道）：<https://www.stcn.com/article/detail/1085762.html>
- AKShare 项目声明：<https://akshare.akfamily.xyz/introduction.html>
- 本项目 README（数据声明与 API 一览）：[README.md](file:///d:/Sanchez/AI/GithubProjects/a-share-high-div-radar/README.md)
