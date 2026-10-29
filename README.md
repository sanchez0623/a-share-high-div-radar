# 息壤 · Dividend Atlas

以**股息率、价格位置与风险闸门**为核心的 A 股高股息研究工作台。它不预测波动，而是把「分红预测 → 研究价格 → 分级加仓 → 风险核验 → 模拟交易 → 复盘」串成一条可追溯的研究流水线。

> **数据声明**：行情支持演示/真实双模式——启动装配成功即自动切真实（东财前复权日线 + 腾讯/新浪/东财盘中快照，PE 为 TTM、ROE 为年报口径）；分红历史在拿到真实除权数据后为真实口径（腾讯 fqkline，按分红年度汇总），预测分红与质量评分始终是用户研究假设。口径来源在页面脚注与 `DataMeta` 中显式标注，不构成投资建议。

## 功能总览

| 页面 | 说明 |
| --- | --- |
| 今日机会雷达 | 观察仓评分卡、机会地图（股息率 × %B 散点）、信号灯与模拟走势 |
| 个股研究透视 | 个股详情：K 线与布林通道、分红历史（真实除权数据或演示口径，脚注标注）、六信号评分、研究计划档位 |
| 分红预测实验室 | 调整预测年度、情景（谨慎/基准/乐观）与要求股息率，实时预览研究价格与分配 |
| 分级加仓计划 | L1–L3 三档价格阶梯，含预算、现金储备与集中度约束下的资金分配 |
| 资讯与风险哨兵 | 风险事件登记、逐条人工核验（证据必填）、原文更新与核验有效期管理 |
| 持仓与现金流 | 组合账本、现金流分档（已到账/已宣告/预计）、模拟交易账本、交易复盘、CSV 导出 |
| 研究蓝图 | 内置方法论与规则说明 |

## 核心方法论

- **研究价格**：`预测每股分红 ÷ 要求股息率`，实验室与计划页共用同一公式。
- **分红预测**：以基准年每股分红为起点，按近一年增速外推并叠加情景系数（谨慎 ×0.85 / 基准 ×1 / 乐观 ×1.1）；每条预测都携带来源（已宣告/公司指引/历史外推/用户假设）、公告日期与假设说明。
- **分红质量**：派息率、经营/自由现金流覆盖、利润波动、杠杆共同给出「可持续 / 需复核 / 不达标」结论；不达标或含一次性特别分红时，研究等级封顶 L1。
- **研究等级 L0–L3**：由股息率门槛、布林超跌（%B ≤ 0.2/0.1/0.05）、风险闸门与分红质量共同派生，纯函数计算、无隐藏状态。
- **综合评分**：六信号加权（估值 25 / 分红质量 20 / 技术 20 / 趋势 10 / 风险 15 / 资金 10），按 `pass=1, watch=0.6, neutral=0.3, block=0` 折算。
- **风险闸门**：核验有效期按严重度为高 7 天、中 14 天、低 30 天；存在未关闭高风险事项时 L1–L3 全部阻断，仅中/低未关闭时阻断 L3。每次核验必须留下备注与证据链接，原文更新即作废旧核验。
- **前复权**：技术指标基于前复权收盘价，除息缺口已抹平，避免除息回落被误判为超跌。

## 技术栈

- **前端**：React 19 + TypeScript + Vite 6，lucide-react 图标，原生 CSS
- **后端**：Node.js + Express 5，`tsx` 直接运行 TypeScript
- **共享层**：`shared/` 下的类型契约与假设公式，前后端同一口径
- **测试**：Node.js 内置 test runner（`node:test`）

## 快速开始

```bash
# 安装依赖（Node ≥ 20 建议）
npm install

# 开发模式：同时启动 API（:4174，tsx watch）与前端（:5173，/api 已代理）
npm run dev

# 运行测试
npm test

# 构建前端产物（含 tsc --noEmit 类型检查）→ dist/
npm run build

# 一体化启动：Express 同时提供 /api 与 dist 静态托管（SPA 回退）
npm start

# 前后端分离启动：仅提供 /api，前端产物交由网关/静态服务器托管
npm run start:api
```

## 环境变量与安全

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `4174` | API 监听端口 |
| `HOST` | 回环地址 | 仅本机可访问；跨设备需显式设置 |
| `ACCESS_TOKEN` | 空 | 非回环监听或公开部署时**必填**，所有 `/api` 请求需携带 `Authorization: Bearer <token>` |
| `ALLOWED_ORIGINS` | 回环地址 | 额外放行的浏览器来源白名单（逗号分隔），预检请求同样受约束 |
| `PUBLIC_DEPLOYMENT` | `false` | 公开部署的显式声明（`true`/`1`/`yes`/`on`）。反向代理后 `HOST` 仍是回环地址时，只有声明后才会强制令牌认证 |

安全设计：默认只监听回环地址；拒绝无令牌对外暴露（本服务无用户隔离，组合与观察仓为单一数据）；来源白名单先于 CORS 拦截，预检请求不返回任何响应头。

反向代理/公网部署必须同时声明 `PUBLIC_DEPLOYMENT=true`、配置 `ACCESS_TOKEN`，并把对外域名加入 `ALLOWED_ORIGINS`（浏览器同源写请求同样携带 Origin，未列入白名单会返回 403）；三者缺一不可。

## 目录结构

```
├── index.html              # SPA 入口
├── vite.config.ts          # Vite 配置（:5173，/api 代理到 :4174）
├── shared/                 # 前后端共享：类型契约 types.ts、假设公式 assumptions.ts、费用 costs.ts
├── server/                 # Express API
│   ├── index.ts            # 启动入口：端口/HOST/令牌校验、文件持久化装配
│   ├── app.ts              # 路由与中间件（来源守卫、令牌守卫、静态托管）
│   ├── demo-data.ts        # 演示数据种子（6 只高股息标的：平安/移动/美的/工行/神华/长电）
│   ├── indicators.ts       # 技术指标：布林带 %B、MA20、ATR
│   ├── research.ts         # 研究等级派生、六信号评分、三档价格阶梯
│   ├── dividend-quality.ts # 分红可持续性质量检查
│   ├── risk-model.ts       # 风险政策（有效期/阻断矩阵）与闸门派生
│   ├── risk-actions.ts     # 风险登记、核验、原文更新
│   ├── portfolio.ts        # 组合账本、现金流分档、模拟交易执行、加仓资金分配
│   ├── trade-review.ts     # FIFO 配对复盘与规则合规检查
│   ├── assumptions.ts      # 假设的解析、预览、保存与版本管理
│   ├── snapshot.ts / state-change.ts # 快照派生与变更后统一重算
│   ├── security.ts         # 回环判断、来源白名单、令牌守卫
│   ├── *-store.ts          # 内存/文件存储（assumptions / settings / risks / portfolio）
│   ├── .data/              # 运行时落盘：assumptions.json、settings.json、risks.json、portfolio.json（原子写入）
│   └── engine.test.ts / http.test.ts # 单元与 HTTP 集成测试
└── src/                    # React 前端
    ├── App.tsx             # 布局、导航与全局状态
    ├── api.ts              # API 客户端
    ├── pages/              # 七个页面（雷达/个股/实验室/计划/风险/持仓/蓝图）
    ├── components/         # 图表（Charts.tsx）、通用 UI 与模态框
    └── styles.css          # 全局样式
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，返回数据模式与口径元信息 |
| GET | `/api/dashboard` | 仪表盘：观察仓与交易候选快照、组合账本、风险事件与政策 |
| GET | `/api/catalog` | 全部演示标的目录（含是否在观察仓） |
| GET | `/api/stocks/:symbol?budget=` | 个股详情：行情、分红、假设、计划档位与资金分配 |
| POST | `/api/stocks/:symbol/assumption` | 保存分红假设（版本号递增） |
| POST | `/api/stocks/:symbol/assumption/preview` | 临时预览假设（不落盘，整份快照返回） |
| PATCH | `/api/stocks/:symbol/settings` | 设置项白名单更新（如买入门槛） |
| POST / DELETE | `/api/watchlist`、`/api/watchlist/:symbol` | 观察仓增删（至少保留一只） |
| POST | `/api/risk` | 登记风险事项（高风险将使既有核验失效） |
| POST | `/api/risk/:id/verify` | 逐条人工核验（备注必填，高风险必须留证据） |
| PATCH | `/api/risk/:id/source` | 原文更新（版本递增，旧核验失效） |
| POST | `/api/portfolio/trade` | 模拟交易（含费用与印花税，成交时冻结研究快照） |
| GET | `/api/portfolio/review` | 交易复盘：FIFO 配对盈亏与规则合规分类 |
| GET | `/api/export/watchlist` | 导出观察仓 CSV（`Cache-Control: no-store`） |

写操作统一返回重算后的最新快照，前端不自行拼接派生数据。

## 设计原则

- **可追溯**：每条分红预测携带来源与假设说明；每笔成交冻结当时的研究快照（假设版本、风险证据、计划档位），复盘可回溯决策现场。
- **派生一致**：研究等级、风险闸门、评分均为纯函数派生，展示层不得依据单个布尔字段重新推断；决策使用未舍入值，舍入只发生在展示快照。
- **演示诚实**：数据模式、行情时间、复权与估值口径通过 `DataMeta` 显式标注，前端常驻数据声明。

## 更新记录

- **2026-10-29 · 真实分红历史接入**：「个股研究透视 → 分红连续性」的五年柱状与「连续 N 年」改由腾讯 fqkline 除权事件聚合——分红年度口径（`nd`）求和、`fh_sh` 为每10股派息须除以10、当前日历年因年报分红未落地不计数；事件同步窗口扩至近 15 年并按 7 天新鲜度复用缓存；`Stock` 新增 `dividendHistorySource / dividendHistorySyncedAt`，面板脚注按口径如实标注；`DividendRecord.payoutRatio` 改为可空（除权数据不携带派息率，免费源无法可靠推算）。`receivedDividend / pendingDividend` 与质量评分仍为种子口径，待后续单独接入。
- 2026-10-29 · 实盘数据接入（P1/P1.5）：东财前复权日线装配、多源实时快照、交易日历与行业分类真实化；分红事件落盘缓存（`server/.data/dividend-events/`）。
