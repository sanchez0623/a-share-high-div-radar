import { Braces, Database, GitBranch, Layers3, Server, ShieldCheck, Workflow } from 'lucide-react';
import { SectionHeading } from '../components/UI.tsx';

const layers = [
  { index: '01', title: '数据接入层', subtitle: 'PROVIDER ADAPTER', text: '统一行情、财报、分红与公告的数据口径。当前使用显式演示适配器，未来可替换为 iFinD / Tushare，不污染领域逻辑。', icon: Database },
  { index: '02', title: '指标与研究层', subtitle: 'RESEARCH ENGINE', text: '计算 MA20、布林带、%B、ATR 与预测股息率；六项信号独立判断，评分只用于研究排序。', icon: Workflow },
  { index: '03', title: '决策编排层', subtitle: 'DECISION ORCHESTRATION', text: '按股息率门槛 × 布林超跌派生 L0–L3 研究等级；分红质量不达标或含一次性分红时封顶 L1，风险按严重度矩阵阻断，24 小时冷却只抑制重复提醒。', icon: GitBranch },
  { index: '04', title: '人工复核层', subtitle: 'HUMAN-IN-THE-LOOP', text: '风险原文、核验记录与有效期由人逐条登记；股票级闸门由全部风险事件派生，高风险未关闭时全部等级阻断。', icon: ShieldCheck },
];

const endpoints = [
  ['GET', '/api/dashboard', '观察仓、组合、风险总览与阻断矩阵'],
  ['GET', '/api/stocks/:symbol', '个股指标、历史与价格阶梯'],
  ['POST', '/api/stocks/:symbol/assumption', '保存分红假设并重算研究价格'],
  ['POST', '/api/stocks/:symbol/assumption/preview', '临时预览假设，不写回状态'],
  ['PATCH', '/api/stocks/:symbol/settings', '更新收益率门槛（风险状态不可直写）'],
  ['POST', '/api/watchlist', '添加观察标的'],
  ['POST', '/api/risk/:id/verify', '逐条记录核验备注、证据与有效期'],
  ['PATCH', '/api/risk/:id/source', '原文更新并使该条旧核验失效'],
  ['POST', '/api/risk', '登记风险事项，高风险使既有核验失效'],
  ['POST', '/api/portfolio/trade', '校验并记录模拟交易'],
  ['GET', '/api/export/watchlist', '导出观察仓 CSV'],
];

export default function BlueprintPage() {
  return (
    <div className="page blueprint-page">
      <header className="blueprint-hero">
        <span className="eyebrow light">SYSTEM BLUEPRINT / V0.1</span>
        <h1>从数据到决策，<br /><em>每一步都可解释。</em></h1>
        <p>一个面向个人高股息研究的辅助系统：数据有来源、指标有口径、信号有边界、动作有复核。</p>
        <div className="blueprint-stack"><span>React 19</span><span>TypeScript</span><span>Express 5</span><span>REST API</span><span>Provider Adapter</span></div>
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
            <ul><li><b>pages/</b> 雷达、个股、实验室、计划、风险、组合</li><li><b>components/Charts.tsx</b> 原生 SVG 数据可视化</li><li><b>components/UI.tsx</b> 弹窗、状态与通用语义组件</li><li><b>api.ts</b> 统一请求、错误解析与接口类型</li><li><b>App.tsx</b> 页面编排、数据生命周期与全局交互</li></ul>
            <div><span>server/</span><p>Express 应用层</p></div>
            <ul><li><b>research.ts / indicators.ts</b> 纯计算：指标、评分、等级与价格阶梯</li><li><b>snapshot.ts / state-change.ts</b> 快照读取与显式状态变更（写入后统一重算与提醒）</li><li><b>assumptions.ts / risk-*.ts / portfolio.ts</b> 假设、风险与组合账本写入</li><li><b>app.ts / index.ts</b> 路由、输入校验、错误边界与 CSV 导出</li><li><b>engine.test.ts</b> 核心公式与领域规则单元测试</li></ul>
            <div><span>shared/types.ts</span><p>前后端共享领域契约，避免字段口径漂移</p></div>
          </div>
        </div>

        <div className="panel domain-panel">
          <SectionHeading eyebrow="DOMAIN MODEL" title="核心领域对象" aside={<Layers3 size={20} />} />
          <div className="domain-list">
            <div><strong>Stock</strong><span>行情 + 分红假设 + 五维信号</span><p>股息率只由 forecastDividend / price 推导。</p></div>
            <div><strong>DividendAssumption</strong><span>年度 + 情景 + 每股分红 + 要求股息率 + 版本</span><p>实验室、计划与交易共用同一版本，重启后从磁盘恢复。</p></div>
            <div><strong>Signal</strong><span>估值 / 分红质量 / 超跌 / 趋势 / 风险 / 预算</span><p>独立状态，不允许总分掩盖风险阻断。</p></div>
            <div><strong>PlanTier</strong><span>门槛 + 研究价 + 条件 + 解锁状态</span><p>研究价 = 预测每股分红 ÷ 目标股息率。</p></div>
            <div><strong>RiskEvent / RiskGate</strong><span>原文来源 + 严重度 + 核验记录 + 有效期</span><p>核验状态按当前时间派生，股票级闸门汇总全部风险事件。</p></div>
            <div><strong>Portfolio</strong><span>现金 + 持仓 + 预计现金流</span><p>交易校验整百股、现金与持仓约束。</p></div>
          </div>
        </div>
      </section>

      <section className="panel api-panel">
        <SectionHeading eyebrow="REST CONTRACT" title="接口契约" aside={<Server size={20} />} />
        <div className="api-list">{endpoints.map(([method, path, description]) => <div key={`${method}-${path}`}><span className={`http-method method-${method.toLowerCase()}`}>{method}</span><code>{path}</code><p>{description}</p></div>)}</div>
      </section>

      <section className="nonfunctional-section">
        <div><span>01</span><h3>可替换数据源</h3><p>Provider 接口隔离第三方字段与限流策略。</p></div>
        <div><span>02</span><h3>可复现计算</h3><p>纯函数指标引擎，输入相同则输出一致。</p></div>
        <div><span>03</span><h3>可访问交互</h3><p>语义按钮、键盘操作、响应式与减少动态效果。</p></div>
        <div><span>04</span><h3>可持续演进</h3><p>内存仓储可替换 SQLite / PostgreSQL，不改领域公式。</p></div>
      </section>
    </div>
  );
}
