import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type {
  AssumptionPreviewResponse,
  DashboardResponse,
  Portfolio,
  RiskMutationResponse,
  Stock,
  StockDetailResponse,
  TradeReviewResponse,
} from '../shared/types.ts';
import { researchPrice } from '../shared/assumptions.ts';
import { createApp } from './app.ts';
import { createFileAssumptionStore } from './assumption-store.ts';
import { createFileRiskStore } from './risk-store.ts';
import { createFilePortfolioStore } from './portfolio-store.ts';
import { createDemoState } from './engine.ts';

let server: Server;
let baseUrl = '';

before(async () => {
  server = createApp(createDemoState()).listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务器未监听端口');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function patchSettings(symbol: string, body: unknown) {
  return fetch(`${baseUrl}/api/stocks/${symbol}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readDetail(symbol: string): Promise<StockDetailResponse> {
  const response = await fetch(`${baseUrl}/api/stocks/${symbol}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<StockDetailResponse>;
}

function postAssumption(symbol: string, body: unknown, base = baseUrl) {
  return fetch(`${base}/api/stocks/${symbol}/assumption`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postAssumptionPreview(symbol: string, body: unknown, base = baseUrl) {
  return fetch(`${base}/api/stocks/${symbol}/assumption/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postRiskVerify(id: string, body: unknown, base = baseUrl) {
  return fetch(`${base}/api/risk/${id}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postRisk(body: unknown, base = baseUrl) {
  return fetch(`${base}/api/risk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchRiskSource(id: string, body: unknown, base = baseUrl) {
  return fetch(`${base}/api/risk/${id}/source`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function startServer(
  store?: ReturnType<typeof createFileAssumptionStore>,
  riskStore?: ReturnType<typeof createFileRiskStore>,
  portfolioStore?: ReturnType<typeof createFilePortfolioStore>,
) {
  const app = createApp(createDemoState(), store, riskStore, portfolioStore);
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务器未监听端口');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('PATCH /api/stocks/:symbol/settings 保存门槛并同步雷达、详情与计划', async () => {
  const response = await patchSettings('601318.SH', { buyThreshold: 6.2 });
  assert.equal(response.status, 200);
  const saved = (await response.json()) as Stock;
  assert.equal(saved.buyThreshold, 6.2);

  const detail = await readDetail('601318.SH');
  assert.equal(detail.stock.buyThreshold, 6.2);
  assert.ok(Math.abs(detail.plan[0].yieldThreshold - 0.062) < 1e-9);
  assert.equal(detail.plan[0].targetPrice, 45.97);

  const dashboardResponse = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(dashboardResponse.status, 200);
  const dashboard = (await dashboardResponse.json()) as DashboardResponse;
  const radarStock = dashboard.stocks.find((stock) => stock.symbol === '601318.SH');
  assert.equal(radarStock?.buyThreshold, 6.2);
});

test('越界门槛返回400且不覆盖已保存值', async () => {
  const response = await patchSettings('601318.SH', { buyThreshold: 2.5 });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error?: string };
  assert.match(body.error ?? '', /3到10/);

  const detail = await readDetail('601318.SH');
  assert.equal(detail.stock.buyThreshold, 6.2);
});

test('风险状态由事件派生，PATCH 直写会被拒绝', async () => {
  const response = await patchSettings('601318.SH', { riskVerified: true });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error?: string };
  assert.match(body.error ?? '', /逐条核验/);

  const detail = await readDetail('601318.SH');
  assert.equal(detail.stock.riskGate.totalCount, 1);
  assert.equal(detail.stock.riskGate.openCount, 1);
  assert.equal(detail.stock.riskGate.verified, false);
});

test('核验接口要求备注与证据，任何严重度都不例外', async () => {
  const noNote = await postRiskVerify('risk-601318.SH', { note: '短' });
  assert.equal(noNote.status, 400);
  assert.match(((await noNote.json()) as { error?: string }).error ?? '', /备注/);

  const mediumWithoutEvidence = await postRiskVerify('risk-601318.SH', {
    note: '已核对平安公告原文',
  });
  assert.equal(mediumWithoutEvidence.status, 400);
  assert.match(
    ((await mediumWithoutEvidence.json()) as { error?: string }).error ?? '',
    /证据/,
  );

  const highWithoutEvidence = await postRiskVerify('risk-601088.SH', { note: '已核对公告原文' });
  assert.equal(highWithoutEvidence.status, 400);
  assert.match(((await highWithoutEvidence.json()) as { error?: string }).error ?? '', /证据/);

  const missing = await postRiskVerify('risk-000000.SH', { note: '已核对公告原文' });
  assert.equal(missing.status, 404);
});

test('单条核验只关闭自身；新增高风险后等级与动作按公开规则阻断', async () => {
  const verifiedResponse = await postRiskVerify('risk-601318.SH', {
    note: '已核对平安公告原文与派息口径',
    evidenceUrl: 'https://example.com/pingan/notice',
  });
  assert.equal(verifiedResponse.status, 200);
  const verified = (await verifiedResponse.json()) as RiskMutationResponse;
  assert.equal(verified.risk.status, 'verified');
  assert.equal(verified.risk.verification?.verifiedBy, '研究台用户');
  assert.equal(verified.stock.riskGate.verified, true);
  assert.deepEqual(verified.stock.riskGate.allowedLevels, ['L1', 'L2', 'L3']);

  const addedResponse = await postRisk({
    symbol: '601318.SH',
    title: '演示：监管处罚公告',
    type: '公告',
    severity: 'high',
    summary: '演示：新增高风险事项后，原有核验全部失效。',
    source: {
      publisher: '演示公告库',
      excerpt: '演示原文摘录：新增监管处罚类高风险事项。',
      publishedAt: '2026-10-26',
    },
  });
  assert.equal(addedResponse.status, 200);
  const added = (await addedResponse.json()) as RiskMutationResponse;
  assert.equal(added.risk.status, 'pending');
  assert.equal(added.stock.riskGate.highestOpenSeverity, 'high');
  assert.deepEqual(added.stock.riskGate.allowedLevels, []);
  assert.equal(added.stock.level, 'L0');
  assert.equal(added.stock.action, '风险阻断');

  const detail = await readDetail('601318.SH');
  assert.equal(detail.stock.level, 'L0');
  assert.equal(detail.stock.action, '风险阻断');
  assert.equal(detail.plan.every((tier) => !tier.unlocked), true);
  assert.equal(detail.stock.riskGate.invalidatedCount, 1);

  const dashboard = (await (await fetch(`${baseUrl}/api/dashboard`)).json()) as DashboardResponse;
  const statuses = dashboard.risks
    .filter((risk) => risk.symbol === '601318.SH')
    .map((risk) => risk.status)
    .sort();
  assert.deepEqual(statuses, ['invalidated', 'pending']);
  assert.ok(dashboard.riskPolicy.rules.length > 0);

  const highId = added.risk.id;
  const noEvidence = await postRiskVerify(highId, { note: '已核对处罚公告原文' });
  assert.equal(noEvidence.status, 400);

  const highVerifiedResponse = await postRiskVerify(highId, {
    note: '已核对处罚公告原文与影响范围',
    evidenceUrl: 'https://example.com/notice/1',
  });
  assert.equal(highVerifiedResponse.status, 200);
  const highVerified = (await highVerifiedResponse.json()) as RiskMutationResponse;
  assert.equal(highVerified.risk.status, 'verified');
  assert.equal(highVerified.risk.verification?.evidenceUrl, 'https://example.com/notice/1');
  assert.deepEqual(highVerified.stock.riskGate.allowedLevels, ['L1', 'L2']);

  const reVerifiedResponse = await postRiskVerify('risk-601318.SH', {
    note: '原文已确认，重新核验通过',
    evidenceUrl: 'https://example.com/pingan/notice-v2',
  });
  assert.equal(reVerifiedResponse.status, 200);
  const reVerified = (await reVerifiedResponse.json()) as RiskMutationResponse;
  assert.equal(reVerified.stock.riskGate.verified, true);
  assert.deepEqual(reVerified.stock.riskGate.allowedLevels, ['L1', 'L2', 'L3']);

  /** L3 放行时，该股票每条风险的核验都带证据。 */
  const finalDashboard = (await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json()) as DashboardResponse;
  const symbolRisks = finalDashboard.risks.filter((risk) => risk.symbol === '601318.SH');
  assert.ok(symbolRisks.length >= 2);
  for (const risk of symbolRisks) {
    assert.equal(risk.status, 'verified');
    assert.equal(risk.verification?.revision, risk.source.revision);
    assert.ok((risk.verification?.evidenceUrl?.length ?? 0) >= 4);
    assert.ok((risk.verification?.note.length ?? 0) >= 4);
  }
});

test('原文更新使该条核验失效并恢复阻断', async () => {
  const dashboard = (await (await fetch(`${baseUrl}/api/dashboard`)).json()) as DashboardResponse;
  const high = dashboard.risks.find((risk) => risk.title === '演示：监管处罚公告');
  assert.ok(high);
  assert.equal(high.status, 'verified');
  assert.ok(high.verification);

  const response = await patchRiskSource(high.id, {
    excerpt: '更新后的原文摘录：处罚决定补充说明。',
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as RiskMutationResponse;
  assert.equal(body.risk.source.revision, 2);
  assert.equal(body.risk.status, 'invalidated');
  assert.match(body.risk.statusReason, /原文更新/);
  assert.equal(body.stock.riskGate.highestOpenSeverity, 'high');
  assert.deepEqual(body.stock.riskGate.allowedLevels, []);
  assert.equal(body.stock.action, '风险阻断');
});

test('风险核验记录与原文版本随服务重启恢复', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dividend-risk-'));
  const file = join(directory, 'risks.json');
  let first: Awaited<ReturnType<typeof startServer>> | null = null;
  let second: Awaited<ReturnType<typeof startServer>> | null = null;

  try {
    first = await startServer(undefined, createFileRiskStore(file));
    const response = await postRiskVerify(
      'risk-600941.SH',
      {
        note: '已核对移动公告原文与派息口径',
        evidenceUrl: 'https://example.com/mobile/notice',
        verifiedBy: '研究员B',
      },
      first.baseUrl,
    );
    assert.equal(response.status, 200);
    await new Promise<void>((resolve, reject) => {
      first!.server.close((error) => (error ? reject(error) : resolve()));
    });
    first = null;

    second = await startServer(undefined, createFileRiskStore(file));
    const dashboard = (await (
      await fetch(`${second.baseUrl}/api/dashboard`)
    ).json()) as DashboardResponse;
    const risk = dashboard.risks.find((item) => item.id === 'risk-600941.SH');
    assert.ok(risk);
    assert.equal(risk.status, 'verified');
    assert.equal(risk.verification?.note, '已核对移动公告原文与派息口径');
    assert.equal(risk.verification?.evidenceUrl, 'https://example.com/mobile/notice');
    assert.equal(risk.verification?.verifiedBy, '研究员B');
    assert.equal(risk.verification?.revision, 1);
    assert.equal(risk.source.revision, 1);
  } finally {
    if (first) await new Promise<void>((resolve) => first!.server.close(() => resolve()));
    if (second) await new Promise<void>((resolve) => second!.server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('未知股票代码返回404', async () => {
  const response = await patchSettings('999999.SH', { buyThreshold: 5 });
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error?: string };
  assert.match(body.error ?? '', /不存在/);
});

test('前端旧契约 PATCH /api/stocks/:symbol 不再被接受', async () => {
  const response = await fetch(`${baseUrl}/api/stocks/601318.SH`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buyThreshold: 7 }),
  });
  assert.equal(response.status, 404);
});

test('临时预览返回与实验室一致的价格，且不写入正式假设', async () => {
  const response = await postAssumptionPreview('600941.SH', {
    forecastYear: 2026,
    scenario: 'conservative',
    requiredYield: 6,
  });
  assert.equal(response.status, 200);
  const preview = (await response.json()) as AssumptionPreviewResponse;
  assert.equal(preview.assumption.savedAt, null);
  assert.equal(preview.assumption.dividendPerShare, 3.95);
  assert.equal(preview.plan[0].assumptionVersion, 1);
  assert.deepEqual(
    preview.plan.map((tier) => tier.targetPrice),
    [6, 6.5, 7].map((requiredYield) => researchPrice(3.95, requiredYield)),
  );

  const detail = await readDetail('600941.SH');
  assert.equal(detail.assumptionSaved, false);
  assert.equal(detail.assumption.version, 0);
  assert.equal(detail.assumption.requiredYield, 6);
  assert.equal(detail.plan[0].targetPrice, researchPrice(4.65, 6));
});

test('保存假设后实验室与计划页各档研究价格完全一致', async () => {
  const response = await postAssumption('600941.SH', {
    forecastYear: 2026,
    scenario: 'conservative',
    requiredYield: 6,
  });
  assert.equal(response.status, 200);
  const saved = (await response.json()) as StockDetailResponse;
  assert.equal(saved.assumptionSaved, true);
  assert.equal(saved.assumption.version, 1);
  assert.equal(saved.stock.buyThreshold, 6);
  assert.equal(saved.stock.forecastDividend, 3.95);
  assert.equal(saved.stock.assumptionVersion, 1);
  assert.deepEqual(
    saved.plan.map((tier) => tier.targetPrice),
    [6, 6.5, 7].map((requiredYield) => researchPrice(3.95, requiredYield)),
  );

  const refreshed = await readDetail('600941.SH');
  assert.deepEqual(refreshed.plan, saved.plan);
  assert.deepEqual(refreshed.assumption, saved.assumption);

  const dashboardResponse = await fetch(`${baseUrl}/api/dashboard`);
  const dashboard = (await dashboardResponse.json()) as DashboardResponse;
  const radarStock = dashboard.stocks.find((stock) => stock.symbol === '600941.SH');
  assert.equal(radarStock?.assumptionVersion, 1);
});

test('模拟交易记录建仓时的假设版本', async () => {
  const response = await fetch(`${baseUrl}/api/portfolio/trade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: '600941.SH', side: 'buy', shares: 100, price: 100 }),
  });
  assert.equal(response.status, 200);
  const portfolio = (await response.json()) as Portfolio;
  const position = portfolio.positions.find((item) => item.symbol === '600941.SH');
  assert.equal(position?.assumptionVersion, 1);

  const trade = portfolio.trades[0];
  assert.ok(trade, '成交后账本应有记录');
  assert.equal(trade.executedAt, '2026-10-23');
  assert.equal(trade.taxBasis, 'pre_tax');
  assert.equal(trade.assumptionVersion, 1);
  assert.equal(trade.netAmount, 10_005.1);
  assert.equal(trade.fee, 5.1);
  assert.equal(trade.tax, 0);
  /** 追溯性：researchContext 冻结成交时的研究快照。 */
  assert.ok(trade.researchContext, '成交应记录完整研究快照');
  assert.equal(trade.researchContext.assumption.version, 1);
  assert.ok(['L0', 'L1', 'L2', 'L3'].includes(trade.researchContext.level));
  assert.equal(typeof trade.researchContext.dividendYield, 'number');
  assert.equal(typeof trade.researchContext.percentB, 'number');
  assert.ok(Array.isArray(trade.researchContext.riskGate.allowedLevels));
  assert.ok(Array.isArray(trade.researchContext.risks));
  assert.ok(Array.isArray(trade.researchContext.plan));
  assert.equal(trade.researchContext.plan.length, 3);
});

test('非法假设输入返回400且不覆盖已保存版本', async () => {
  const rejected = await postAssumption('600941.SH', {
    forecastYear: 2026,
    scenario: 'aggressive',
    requiredYield: 6,
  });
  assert.equal(rejected.status, 400);
  const body = (await rejected.json()) as { error?: string };
  assert.match(body.error ?? '', /情景/);

  const detail = await readDetail('600941.SH');
  assert.equal(detail.assumption.version, 1);
  assert.equal(detail.assumptionSaved, true);
});

test('连续读取 Dashboard 与详情时研究结论恒定，冷却不影响结论', async () => {
  const isolated = await startServer();
  const readRadar = async (): Promise<Stock> => {
    const response = await fetch(`${isolated.baseUrl}/api/dashboard`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardResponse;
    const stock = body.stocks.find((item) => item.symbol === '601318.SH');
    assert.ok(stock);
    return stock;
  };
  const readIsolatedDetail = async (): Promise<StockDetailResponse> => {
    const response = await fetch(`${isolated.baseUrl}/api/stocks/601318.SH`);
    assert.equal(response.status, 200);
    return response.json() as Promise<StockDetailResponse>;
  };

  try {
    const baseline = await readRadar();
    const baselineDetail = await readIsolatedDetail();
    assert.equal(baseline.level, 'L1');
    assert.equal(baseline.action, '进入人工复核');

    for (let index = 0; index < 3; index += 1) {
      const radar = await readRadar();
      const detail = await readIsolatedDetail();
      assert.equal(radar.level, baseline.level);
      assert.equal(radar.action, baseline.action);
      assert.equal(radar.summary, baseline.summary);
      assert.equal(detail.stock.level, radar.level);
      assert.equal(detail.stock.action, radar.action);
      assert.equal(detail.stock.summary, radar.summary);
      assert.deepEqual(detail.plan, baselineDetail.plan);
    }
  } finally {
    await new Promise<void>((resolve) => isolated.server.close(() => resolve()));
  }
});

test('分红下修后雷达、计划与组合预测同步，且行情口径可追溯', async () => {
  const isolated = await startServer();
  try {
    const initialResponse = await fetch(`${isolated.baseUrl}/api/dashboard`);
    assert.equal(initialResponse.status, 200);
    const initial = (await initialResponse.json()) as DashboardResponse;
    assert.equal(initial.dataMeta.priceAdjustment, 'forward');
    assert.equal(initial.dataMeta.indicatorAdjustment, 'forward');
    assert.equal(initial.dataMeta.peBasis, 'ttm');
    assert.equal(initial.dataMeta.roeBasis, 'annual');

    const beforeStock = initial.stocks.find((stock) => stock.symbol === '601318.SH')!;
    assert.ok(beforeStock.dividendForecast.hypothesis.length > 0);
    assert.equal(beforeStock.marketData.priceAdjustment, 'forward');
    const beforeDividend = initial.portfolio.annualDividend;

    const cutResponse = await postAssumption(
      '601318.SH',
      { forecastYear: 2026, scenario: 'conservative', requiredYield: 5.5 },
      isolated.baseUrl,
    );
    assert.equal(cutResponse.status, 200);
    const detail = (await cutResponse.json()) as StockDetailResponse;
    assert.equal(detail.assumption.source, 'assumption');
    assert.ok(detail.assumption.hypothesis.includes('2026'));
    assert.equal(
      detail.stock.dividendForecast.dividendPerShare,
      detail.assumption.dividendPerShare,
    );

    const afterResponse = await fetch(`${isolated.baseUrl}/api/dashboard`);
    const after = (await afterResponse.json()) as DashboardResponse;
    const afterStock = after.stocks.find((stock) => stock.symbol === '601318.SH')!;
    assert.ok(afterStock.dividendYield < beforeStock.dividendYield);
    assert.ok(after.portfolio.annualDividend < beforeDividend);

    const position = after.portfolio.positions.find((item) => item.symbol === '601318.SH');
    assert.equal(position?.forecastDividend, afterStock.forecastDividend);
    assert.equal(position?.forecastSource, 'assumption');

    assert.ok(detail.plan.every((tier) => tier.assumptionVersion === detail.assumption.version));
  } finally {
    await new Promise<void>((resolve) => isolated.server.close(() => resolve()));
  }
});

test('服务重启后已保存假设仍可恢复', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dividend-assumption-'));
  const file = join(directory, 'assumptions.json');
  let first: Awaited<ReturnType<typeof startServer>> | null = null;
  let second: Awaited<ReturnType<typeof startServer>> | null = null;

  try {
    first = await startServer(createFileAssumptionStore(file));
    const savedResponse = await postAssumption(
      '601088.SH',
      { forecastYear: 2028, scenario: 'base', requiredYield: 7 },
      first.baseUrl,
    );
    assert.equal(savedResponse.status, 200);
    const saved = (await savedResponse.json()) as StockDetailResponse;
    assert.equal(saved.assumption.version, 1);
    await new Promise<void>((resolve, reject) => {
      first!.server.close((error) => (error ? reject(error) : resolve()));
    });
    first = null;

    second = await startServer(createFileAssumptionStore(file));
    const detailResponse = await fetch(`${second.baseUrl}/api/stocks/601088.SH`);
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()) as StockDetailResponse;
    assert.equal(detail.assumptionSaved, true);
    assert.equal(detail.assumption.version, 1);
    assert.equal(detail.assumption.forecastYear, 2028);
    assert.equal(detail.stock.assumptionVersion, 1);
    assert.deepEqual(detail.plan, saved.plan);
  } finally {
    if (first) await new Promise<void>((resolve) => first!.server.close(() => resolve()));
    if (second) await new Promise<void>((resolve) => second!.server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('服务重启后观察仓、现金、持仓、交易账本与复盘均恢复', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dividend-portfolio-'));
  const file = join(directory, 'portfolio.json');
  let first: Awaited<ReturnType<typeof startServer>> | null = null;
  let second: Awaited<ReturnType<typeof startServer>> | null = null;

  try {
    first = await startServer(undefined, undefined, createFilePortfolioStore(file));

    /** 加仓观察仓，移除一只，并执行合规买入。 */
    const addResponse = await fetch(`${first.baseUrl}/api/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: '601088.SH' }),
    });
    assert.equal(addResponse.status, 200);
    const removeResponse = await fetch(`${first.baseUrl}/api/watchlist/000333.SZ`, {
      method: 'DELETE',
    });
    assert.equal(removeResponse.status, 200);

    const detail = await readDetail('601318.SH');
    const l1 = detail.plan.find((tier) => tier.level === 'L1')!;
    const tradeResponse = await fetch(`${first.baseUrl}/api/portfolio/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: '601318.SH',
        side: 'buy',
        shares: 100,
        price: (l1.targetPrice ?? 40) - 1,
        planLevel: 'L1',
      }),
    });
    assert.equal(tradeResponse.status, 200);
    const tradePortfolio = (await tradeResponse.json()) as Portfolio;
    assert.ok(tradePortfolio.trades[0].researchContext, '成交应写入研究快照');

    await new Promise<void>((resolve, reject) => {
      first!.server.close((error) => (error ? reject(error) : resolve()));
    });
    first = null;

    /** 重启后用同一文件恢复。 */
    second = await startServer(undefined, undefined, createFilePortfolioStore(file));
    const dashboardResponse = await fetch(`${second.baseUrl}/api/dashboard`);
    assert.equal(dashboardResponse.status, 200);
    const dashboard = (await dashboardResponse.json()) as DashboardResponse;
    assert.equal(dashboard.stocks.length, 3);
    assert.ok(dashboard.stocks.every((stock) => stock.symbol !== '000333.SZ'));
    assert.equal(dashboard.portfolio.cash, tradePortfolio.cash);
    assert.equal(dashboard.portfolio.trades.length, 1);
    assert.equal(dashboard.portfolio.trades[0].id, tradePortfolio.trades[0].id);
    assert.ok(dashboard.portfolio.trades[0].researchContext);

    const reviewResponse = await fetch(`${second.baseUrl}/api/portfolio/review`);
    assert.equal(reviewResponse.status, 200);
    const review = (await reviewResponse.json()) as TradeReviewResponse;
    assert.equal(review.items.length, 1);
    assert.equal(review.items[0].classification, 'open_position');
  } finally {
    if (first) await new Promise<void>((resolve) => first!.server.close(() => resolve()));
    if (second) await new Promise<void>((resolve) => second!.server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
