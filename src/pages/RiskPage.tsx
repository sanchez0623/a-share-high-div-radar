import { useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, FileSearch, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { DashboardResponse } from '../../shared/types.ts';
import { SectionHeading } from '../components/UI.tsx';

interface Props {
  data: DashboardResponse;
  onAcknowledge: (id: string) => Promise<void>;
}

export default function RiskPage({ data, onAcknowledge }: Props) {
  const [filter, setFilter] = useState<'all' | 'pending' | 'acknowledged'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const risks = data.risks.filter((risk) => filter === 'all' || risk.status === filter);
  const pending = data.risks.filter((risk) => risk.status === 'pending').length;

  const acknowledge = async (id: string) => {
    setBusyId(id);
    try {
      await onAcknowledge(id);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page risk-page">
      <header className="page-header split-header">
        <div><span className="eyebrow">HUMAN-IN-THE-LOOP</span><h1>风险哨兵</h1><p>系统负责把问题放到桌面，人负责翻开原始材料。</p></div>
        <div className="risk-counter"><strong>{pending}</strong><span>项待人工核验</span></div>
      </header>

      <section className="risk-gates">
        <div><FileSearch size={22} /><span>01 / 原始公告</span><h3>看原文，不看转述</h3><p>核对财报、分红方案、减持与监管公告。</p></div>
        <div><AlertTriangle size={22} /><span>02 / 财务质量</span><h3>分红从哪来？</h3><p>检查自由现金流、负债与一次性损益。</p></div>
        <div><LockKeyhole size={22} /><span>03 / 风险闸门</span><h3>未核验，不升级</h3><p>L3 特殊机会必须完成人工风险复核。</p></div>
        <div><ShieldCheck size={22} /><span>04 / 主动留痕</span><h3>记录核验动作</h3><p>把“我看过了”变成可追溯的研究状态。</p></div>
      </section>

      <section className="risk-events-section">
        <SectionHeading
          eyebrow="VERIFICATION QUEUE"
          title="人工核验队列"
          aside={<div className="filter-tabs">{([['all', '全部'], ['pending', '待核验'], ['acknowledged', '已复核']] as const).map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div>}
        />
        <div className="risk-event-list">
          {risks.map((risk) => (
            <article className={`risk-event severity-${risk.severity}`} key={risk.id}>
              <div className="risk-event-date"><strong>{risk.date.slice(8)}</strong><span>{risk.date.slice(0, 7)}</span></div>
              <div className="risk-event-main">
                <div className="risk-event-tags"><span>{risk.type}</span><span>{risk.symbol}</span><span className={`severity-label ${risk.severity}`}>{risk.severity === 'high' ? '高优先级' : risk.severity === 'medium' ? '中优先级' : '低优先级'}</span></div>
                <h3>{risk.title}</h3><p>{risk.summary}</p>
              </div>
              <div className="risk-event-action">
                {risk.status === 'acknowledged' ? <span className="verified-label"><CheckCircle2 size={17} />已完成复核</span> : <button className="button button-secondary" disabled={busyId === risk.id} onClick={() => acknowledge(risk.id)}><Check size={16} />{busyId === risk.id ? '正在记录…' : '确认已核验原文'}</button>}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="truth-panel">
        <div><span className="eyebrow light">DATA TRUTHFULNESS</span><h2>没有数据时，<br />宁可没有答案。</h2></div>
        <div className="truth-rules"><p><span>01</span>实时源不可用，则停止输出趋势，不以模拟价格替代。</p><p><span>02</span>资讯未接入时，风险状态保持“待人工核验”。</p><p><span>03</span>所有指标保留计算口径、数据日期与来源模式。</p><p><span>04</span>当前版本为演示研究环境，不连接交易柜台。</p></div>
      </section>
    </div>
  );
}
