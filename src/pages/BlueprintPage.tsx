import { Braces, Database, GitBranch, Layers3, Server, ShieldCheck, Workflow } from 'lucide-react';
import { SectionHeading } from '../components/UI.tsx';

const layers = [
  { index: '01', title: '数据接入层', subtitle: 'PROVIDER ADAPTER', text: '统一行情、分红与行业的数据口径。已接入东方财富（前复权日线 / 行业）、腾讯（实时快照 / fqkline 分红事件）与新浪备用源；live 装配失败自动回退演示数据，第三方字段不污染领域逻辑。', icon: Database },
  { index: '02', title: '指标与研究层', subtitle: 'RESEARCH ENGINE', text: '计算 MA20、布林带、%B、ATR 与预测股息率；聚合近 15 年真实分红历史（按分红年度合并、当前日历年排除、连续分红回数）；六项信号独立判断，评分只用于研究排序。', icon: Workflow },
  { index: '03', title: '决策编排层', subtitle: 'DECISION ORCHESTRATION', text: '按股息率门槛 × 布林超跌派生 L0–L3 研究等级；分红质量不达标或含一次性分红时封顶 L1，风险按严重度矩阵阻断，24 小时冷却只抑制重复提醒。', icon: GitBranch },
  { index: '04', title: '人工复核层', subtitle: 'HUMAN-IN-THE-LOOP', text: '风险原文、核验记录与有效期由人逐条登记；股票级闸门由全部风险事件派生，高风险未关闭时全部等级阻断。', icon: ShieldCheck },
];

const endpoints = [
  ['GET', '/api/health', '健康探针：数据模式、行情源与缓存状态'],
  ['GET', '/api/dashboard', '观察仓、组合、风险总览与阻断矩阵'],
  ['GET', '/api/catalog', '股票目录与行业分类（含停用项开关）'],
  ['POST', '/api/stocks', '登记自定义标的：校验 → 拉日线行情 → 入观察仓'],
  ['PATCH', '/api/stocks/:symbol/status', '停用 / 恢复（软删除，持仓大于 0 拒绝停用）'],
  ['GET', '/api/stocks/:symbol', '个股指标、历史与价格阶梯'],
  ['GET', '/api/quotes', '盘中实时快照：观察仓白名单内按需拉取'],
  ['POST', '/api/stocks/:symbol/assumption', '保存分红假设并重算研究价格'],
  ['POST', '/api/stocks/:symbol/assumption/preview', '临时预览假设，不写回状态'],
  ['PATCH', '/api/stocks/:symbol/settings', '更新收益率门槛（风险状态不可直写）'],
  ['POST', '/api/watchlist', '添加观察标的'],
  ['DELETE', '/api/watchlist/:symbol', '移除观察标的'],
  ['POST', '/api/risk', '登记风险事项，高风险使既有核验失效'],
  ['POST', '/api/risk/:id/verify', '逐条记录核验备注、证据与有效期'],
  ['PATCH', '/api/risk/:id/source', '原文更新并使该条旧核验失效'],
  ['POST', '/api/portfolio/trade', '校验并记录模拟交易（税前 / 税后记账口径）'],
  ['GET', '/api/portfolio/review', '交易复核：现金流水、持仓与分红到账核对'],
  ['GET', '/api/export/watchlist', '导出观察仓 CSV'],
];

export default function BlueprintPage() {
  return (
    <div className="page blueprint-page">
      <header className="blueprint-hero">
        <span className="eyebrow light">SYSTEM BLUEPRINT / V0.2</span>
        <h1>从数据到决策，<br /><em>每一步都可解释。</em></h1>
        <p>一个面向个人高股息研究的辅助系统：数据有来源、指标有口径、信号有边界、动作有复核。</p>
        <div className="blueprint-stack"><span>React 19</span><span>TypeScript</span><span>Express 5</span><span>REST API</span><span>Live Quotes</span><span>File Persistence</span></div>
      </header>

      <section className="architecture-section">
        <SectionHeading eyebrow="LOGICAL ARCHITECTURE" title="四层研究架构" aside={<span className="outline-tag">单向依赖 · 共享领域类型</span>} />
        <div className="architecture-flow">
          {layers.map((layer, index) => { const Icon = layer.icon; return <article key={layer.index} className="architecture-layer"><div className="architecture-top"><span>{layer.index}</span><Icon size={23} /></div><small>{layer.subtitle}</small><h3>{layer.title}</h3><p>{layer.text}</p>{index < layers.length - 1 && <i className="flow-arrow">→</i>}</article>; })}
        </div>
      </section>

      <section className="code-design-grid">
        <div className="panel code-tree-panel">
          <SectionHeading eyebrow="CODE ORGANIZATION" title="前后端代码设计" aside={<Braces size={20} />} />
          <div className="code-tree">
            <div><span>src/</span><p>React 表现层</p></div>
            <ul><li><b>pages/</b> 雷达、个股、实验室、计划、风险、组合、蓝图</li><li><b>hooks/useLiveQuotes.ts + QuoteBadge</b> 盘中行情轮询与实时徽标</li><li><b>Charts / UI / AppModals</b> SVG 可视化、通用语义组件与全局弹窗</li><li><b>api.ts</b> 统一请求、错误解析与接口类型</li><li><b>App.tsx</b> 页面编排、数据生命周期与全局交互</li></ul>
            <div><span>server/</span><p>Express 应用层</p></div>
            <ul><li><b>providers/</b> 多源适配：东财日线/行业、腾讯快照与分红事件、新浪备用</li><li><b>quote-*.ts / trading-*.ts / bar-store / quote-store</b> 行情子系统：缓存 TTL、限流熔断、交易日历与收盘固化</li><li><b>dividend-history / dividend-quality</b> 真实分红聚合（按年合并、当前年排除）与质量评分</li><li><b>research.ts / indicators.ts</b> 纯计算：指标、评分、等级与价格阶梯</li><li><b>snapshot.ts / state-change.ts</b> 快照读取与显式状态变更（写入后统一重算与提醒）</li><li><b>assumptions.ts / risk-*.ts / portfolio.ts / trade-review.ts</b> 假设、风险、组合账本与交易复核</li><li><b>*-store.ts</b> JSON 落盘持久化：原子写、损坏 fail-closed 拒绝启动</li><li><b>app.ts / index.ts / security.ts</b> 路由、输入校验、来源白名单与部署鉴权</li><li><b>engine / http / quote-live 测试</b> 102 个用例：口径、接口契约与行情链路</li></ul>
            <div><span>shared/</span><p>前后端共享契约与纯函数</p></div>
            <ul><li><b>types.ts / quote-types.ts</b> 领域契约与行情快照类型</li><li><b>allocation / costs / assumptions / date</b> 预算分摊、交易成本、假设派生与日期工具</li></ul>
          </div>
        </div>

        <div className="panel domain-panel">
          <SectionHeading eyebrow="DOMAIN MODEL" title="核心领域对象" aside={<Layers3 size={20} />} />
          <div className="domain-list">
            <div><strong>Stock</strong><span>行情 + 分红假设 + 五维信号</span><p>股息率只由 forecastDividend / price 推导；PE/PB 随盘中快照刷新。</p></div>
            <div><strong>DividendAssumption</strong><span>年度 + 情景 + 每股分红 + 要求股息率 + 版本</span><p>实验室、计划与交易共用同一版本，重启后从磁盘恢复。</p></div>
            <div><strong>Signal</strong><span>估值 / 分红质量 / 超跌 / 趋势 / 风险 / 预算</span><p>独立状态，不允许总分掩盖风险阻断。</p></div>
            <div><strong>PlanTier</strong><span>门槛 + 研究价 + 条件 + 解锁状态</span><p>研究价 = 预测每股分红 ÷ 目标股息率。</p></div>
            <div><strong>RiskEvent / RiskGate</strong><span>原文来源 + 严重度 + 核验记录 + 有效期</span><p>核验状态按当前时间派生，股票级闸门汇总全部风险事件。</p></div>
            <div><strong>Portfolio</strong><span>现金 + 持仓 + 预计现金流</span><p>税前 / 税后双记账口径（TaxBasis）；交易校验整百股、现金与持仓约束。</p></div>
            <div><strong>Quote / Session</strong><span>实时快照 + 交易时段</span><p>缓存 TTL、降级链与熔断由 quote-service 统一治理，陈旧度如实标注。</p></div>
          </div>
        </div>
      </section>

      <section className="panel api-panel">
        <SectionHeading eyebrow="REST CONTRACT" title="接口契约" aside={<Server size={20} />} />
        <div className="api-list">{endpoints.map(([method, path, description]) => <div key={`${method}-${path}`}><span className={`http-method method-${method.toLowerCase()}`}>{method}</span><code>{path}</code><p>{description}</p></div>)}</div>
      </section>

      <section className="nonfunctional-section">
        <div><span>01</span><h3>可替换数据源</h3><p>Provider 接口隔离第三方字段与限流策略；多源降级链，单源故障不阻断。</p></div>
        <div><span>02</span><h3>可复现计算</h3><p>纯函数指标引擎，输入相同则输出一致。</p></div>
        <div><span>03</span><h3>可访问交互</h3><p>语义按钮、键盘操作、响应式与减少动态效果。</p></div>
        <div><span>04</span><h3>可持续演进</h3><p>JSON 文件原子写落盘，损坏时 fail-closed 拒绝启动；存储介质可再替换，不改领域公式。</p></div>
      </section>
    </div>
  );
}
