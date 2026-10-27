import { Braces, Database, GitBranch, Layers3, Server, ShieldCheck, Workflow } from 'lucide-react';
import { SectionHeading } from '../components/UI.tsx';

const layers = [
  { index: '01', title: '数据接入层', subtitle: 'PROVIDER ADAPTER', text: '统一行情、财报、分红与公告的数据口径。当前使用显式演示适配器，未来可替换为 iFinD / Tushare，不污染领域逻辑。', icon: Database },
  { index: '02', title: '指标与研究层', subtitle: 'RESEARCH ENGINE', text: '计算 MA20、布林带、%B、ATR 与预测股息率；五项信号独立判断，评分只用于研究排序。', icon: Workflow },
  { index: '03', title: '决策编排层', subtitle: 'DECISION ORCHESTRATION', text: '按估值 → 超跌 → 趋势 → 风险 → 预算生成 L0–L3 研究等级，并执行 24 小时冷却期。', icon: GitBranch },
  { index: '04', title: '人工复核层', subtitle: 'HUMAN-IN-THE-LOOP', text: '风险原文、分红假设与交易动作由人确认。系统不自动委托，不把高关注分包装成买入建议。', icon: ShieldCheck },
];

const endpoints = [
  ['GET', '/api/dashboard', '观察仓、组合与风险总览'],
  ['GET', '/api/stocks/:symbol', '个股指标、历史与价格阶梯'],
  ['PATCH', '/api/stocks/:symbol/settings', '更新收益率门槛与风险状态'],
  ['POST', '/api/watchlist', '添加观察标的'],
  ['POST', '/api/risk/:id/acknowledge', '记录人工风险复核'],
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
            <ul><li><b>engine.ts</b> 指标、评分、计划、冷却期与交易约束</li><li><b>index.ts</b> 路由、输入校验、错误边界与 CSV 导出</li><li><b>engine.test.ts</b> 核心公式与领域规则单元测试</li></ul>
            <div><span>shared/types.ts</span><p>前后端共享领域契约，避免字段口径漂移</p></div>
          </div>
        </div>

        <div className="panel domain-panel">
          <SectionHeading eyebrow="DOMAIN MODEL" title="核心领域对象" aside={<Layers3 size={20} />} />
          <div className="domain-list">
            <div><strong>Stock</strong><span>行情 + 分红假设 + 五维信号</span><p>股息率只由 forecastDividend / price 推导。</p></div>
            <div><strong>Signal</strong><span>估值 / 超跌 / 趋势 / 风险 / 预算</span><p>独立状态，不允许总分掩盖风险阻断。</p></div>
            <div><strong>PlanTier</strong><span>门槛 + 研究价 + 条件 + 解锁状态</span><p>研究价 = 预测每股分红 ÷ 目标股息率。</p></div>
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
