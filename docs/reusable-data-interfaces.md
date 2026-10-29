# 三个本地项目的数据接口复用评估

> 项目：息壤 · Dividend Atlas（`a-share-high-div-radar`）
> 日期：2026-10-29 ｜ 性质：只读评估，未改动任何代码
> 评估对象：`ashare-limit-lens`（Node/TS）、`quan_quant`（Python）、`a-stock-momentum-trend`（Python）
> 对照缺口：本项目 B/C 类未接入项——分红质量输入、ROE、分红史/除息日、行业、交易日历、PE/PB 动态更新、动态添加股票的基础信息

## 一、三个项目一览

| 项目 | 栈 | 数据层特点 | 对本项目的价值 |
| --- | --- | --- | --- |
| ashare-limit-lens | **纯 Node/ESM**，原生 fetch，drizzle/SQLite | 交易所官方接口 + 东财/腾讯 + 自研限流闸门 | **最高**：技术栈同构，接口全部免费且 HTTP 直连 |
| a-stock-momentum-trend | Python（FastAPI + baostock/akshare/理杏仁） | 6 源熔断路由 + 能力声明 | 中高：理杏仁接口已验证可当文档；财务数据靠 baostock（不可移植） |
| quan_quant | Python（FastAPI + polars + Parquet 数据湖） | baostock 为主 + 多源降级链 | 低：核心能力都在 baostock TCP 协议上，TS 不可移植；仅机制可借鉴 |

## 二、可直接移植的接口（按缺口对照）

### ✅ 免费无凭证、HTTP 直接移植

| 本项目缺口 | 接口 | 来源项目与位置 | 说明 |
| --- | --- | --- | --- |
| **交易日历（节假日）** | 腾讯 `web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,{start},{end},,qfq`——拉上证指数实际成交日集合即为交易日 | limit-lens `backend/services/historical-providers.js` L103-140、`market.js` L320-346 | 零依赖零凭证；备源新浪 `CN_MarketData.getKLineData?symbol=sh000001&scale=240`（同文件 L350-398）。直接替换 trading-session.ts 的「只判周末」 |
| **行业分类 sector** | 东财 `push2.eastmoney.com/api/qt/ulist.np/get` 加字段 **f100**（每批 200 只） | limit-lens `backend/services/eastmoney-industry-providers.js` L10、28-88；momentum `eastmoney_src.py` L192-225 交叉验证 | **与本项目已有的 ulist 端点完全同源**，只需加一个 field；顺带覆盖东财 F10 备源 `datacenter.eastmoney.com/...RPT_F10_BASIC_ORGINFO`（BOARD_NAME_LEVEL） |
| **股票名册 / 上市日期** | 上交所 `query.sse.com.cn/sseQuery/commonQuery.do?sqlId=COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L`（JSON）；深交所 `www.szse.cn/api/report/ShowReport?SHOWTYPE=xlsx&CATALOGID=1110&TABKEY=tab1`（XLSX，需 SheetJS） | limit-lens `backend/services/stock-list-providers.js` L12-13、54-156 | 动态添加股票功能的基础信息源；新浪分页备源同文件 L14-15、165-240 |
| **除权除息信息（免费路线）** | 腾讯 fqkline 除权日返回第 7 段含分红内容 dict（momentum 项目把它丢弃了：`tencent_src.py` L31 注释可证） | momentum `tencent_src.py` L31 | 未验证字段结构；拉一次含除权日的 K 线即可确认，若可用则免费拿到分红/除权信息 |

### 🔑 需要理杏仁 token（付费，HTTP POST JSON 直连）

momentum 项目的 [lixinger_probe.py](file:///D:/Sanchez/AI/WorkbuddyProjects/a-stock-momentum-trend/backend/scripts/lixinger_probe.py) **已实测全部接口与字段名，可直接当 API 文档**：

| 本项目缺口 | 接口 | 字段 |
| --- | --- | --- |
| **分红史 / 股息率 / 除权日**（B3/B4/B6） | `POST open.lixinger.com/api/cn/company/dividend` | `metricsList: ["dividendYield","exRightDate"]`（probe L119-120） |
| **财务科目**（B1 现金流/净利润） | `POST /api/cn/company/fs/non_financial` | 如 `q.ps.toi.t` 总营收、`q.ps.np.t` 净利润（probe L74-125） |
| **估值 ROE/PE/PB/股息率**（B2/C1） | `POST /api/cn/company/fundamental/non_financial` | `pe_ttm`、`pb`、`ps_ttm`、`dyr`（股息率） |
| 上市日期 | `POST /api/cn/company` | `metricsList: ["ipoDate"]`（probe L82-83） |
| 申万 2021 三级行业（B5 增强） | `POST /api/cn/industry` + `/api/cn/industry/constituents/sw_2021` | 两次请求拿全量映射（`lixinger_src.py` L207-231） |

注意：理杏仁只有现金流比率类科目（如 CFOToNP），**无直接「每股自由现金流」字段**——本项目的质量输入需由财报科目推导或维持人工录入。

### ❌ 不可移植（仅作字段语义参考）

- **baostock 全系列**（momentum 的 ROE `roeAvg`/现金流 `CFOToNP`/PE/PB `peTTM,pbMRQ`/交易日历/业绩预告；quan_quant 的除权因子 `dividOperateDate`）：私有 TCP 协议，TS 无法直连。价值：字段语义与「逐报告期回退试探」模式（`baostock_src.py` L253-267、L424-519）可作东财/理杏仁取数的对照口径。
- **mootdx（通达信 TCP）**、akshare 封装：同上。akshare 的 `stock_zh_a_hist` 底层就是本项目已有的东财 push2his，无增量价值。

## 三、值得借鉴的工程机制（代码模式，非接口）

1. **按 host 串行限流闸门**（limit-lens `metadataHttp`，`metadata-providers.js` L35-189）：东财 1s/申万 2.5s 最小间隔、429 指数退避 + 尊重 `Retry-After` + 间隔自适应加倍（≤15s）+ 抖动、**仅传输故障才切备用端点（限流禁止绕路）**——比本项目现在的全局令牌桶更精细，建议在接入 f100/名册接口时照抄。
2. **东财防风控**（momentum `eastmoney_src.py` L64-123）：UA 池 + 首访首页取 NID cookie + 「系统繁忙」文案判定为风控错直接切源。
3. **落盘完整性守卫**（quan_quant `store.py` L33-80）：写前校验票数缩水 >10% 拒写 + 损坏文件隔离——本项目 bar-store 可加同款守卫。
4. 熔断路由（momentum `manager.py`）：本项目 quote-service 已有同款（熔断+降级链），无需重做。

## 四、建议行动（按性价比排序）

> **2026-10-29 更新：四项均已实施并端到端验证（含理杏仁 token 接入 .env），见各项 ✅ 标注。**

1. **P1.5-a（半天）**：✅ 已完成——东财 ulist 加 `f100` 解析行业（`industry-eastmoney.ts`，启动同步覆盖 sector，实测「保险Ⅱ/白色家电/银行Ⅱ…」）+ 腾讯 fqkline 推导交易日历（`tencent-fqkline.ts` + `trading-calendar.ts`，节假日 09:35 后判定，scheduler 每tick节流刷新）+ 腾讯行情 f39/f46 解析 PE/PB（`tencent.ts` → `RawQuote.pe/pb` → onUpdate 动态更新 `Stock.pe/pb`，实测与理杏仁口径一致）。
2. **P1.5-b（半天）**：✅ 已完成——fqkline 除权日 bar 末位 dict 实测确认：`{"nd":"2024","fh_sh":"16.2","djr":"2025-06-27","cqr":"2025-06-30","FHcontent":"10派16.2元"}`，**免费分红路线打通**。`fetchDividendEvents`（近5年分段拉取+去重）已接入启动装配，事件落盘 `.data/dividend-events/{SYMBOL}.json`（实测平安 11 条，最新 2026-09-10 10派9.8元）。业务口径接入（receivedDividend/dividends 预测抵扣）待后续单独实施。
3. **P2 理杏仁**：✅ 已实现为**备用源**（`providers/lixinger.ts`）——token 已配置 `.env`（LIXINGER_TOKEN，不入库），provider 串行限流 1.1s + 免费额度保护，不接主链路。实测 fundamental 接口：`{"pe_ttm":9.7733,"pb":0.9224,"dyr":0.0513}`（与腾讯口径一致）。dividend 接口实测返回空，疑似需日期范围参数，接入前再验证。**仅低频校准/人工查询使用，勿高频调用。**
4. **动态添加股票基础信息**：✅ 名册接口已就绪——`providers/stock-list.ts`（上交所官方 JSON：A_STOCK_CODE/SEC_NAME_CN/LIST_DATE/CSRC_CODE_DESC，实测 2520 只，需 Referer）。深市 XLSX 未接（需 SheetJS 依赖），深市代码名称/存在性可由腾讯行情覆盖；完整「动态添加股票」功能（store+端点+UI）按 [dynamic-stock-watchlist.md](dynamic-stock-watchlist.md) 方案另行实施。

## 五、结论

三个项目里 **ashare-limit-lens 的接口对本项目最值钱**（同构 TS、全免费、正好补交易日历/行业/名册）；momentum 的价值是「理杏仁 API 文档化」与财务字段口径；quan_quant 基本只有机制借鉴。本项目最大的剩余缺口（财务/分红基本面）在免费生态里没有现成直连接口，最短路径是理杏仁 token 或继续维持人工录入。
