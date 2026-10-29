import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type {
  AssumptionPreviewResponse,
  DashboardResponse,
  PersistedPortfolio,
  Portfolio,
  RiskMutationResponse,
  Stock,
  StockDetailResponse,
  TradeReviewResponse,
  TradeResponse,
} from '../shared/types.ts';
import { researchPrice } from '../shared/assumptions.ts';
import { createApp, type AppOptions } from './app.ts';
import { createFileAssumptionStore, type AssumptionStore } from './assumption-store.ts';
import { createFileSettingsStore, type SettingsStore } from './settings-store.ts';
import { createFileRiskStore, type RiskStore } from './risk-store.ts';
import { createFilePortfolioStore, type PortfolioStore } from './portfolio-store.ts';
import { createDemoState } from './demo-data.ts';

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

function postAssumptionPreview(symbol: string, body: unknown, base = baseUrl, budget?: number) {
  return fetch(
    `${base}/api/stocks/${symbol}/assumption/preview${typeof budget === 'number' ? `?budget=${budget}` : ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
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
  options?: AppOptions,
) {
  const app = createApp(createDemoState(), store, riskStore, portfolioStore, options);
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

test('设置接口拒绝白名单外字段，批量赋值无法改动代码、预测分红与持仓', async () => {
  const before = await readDetail('601318.SH');
  const response = await patchSettings('601318.SH', {
    symbol: '000001.SZ',
    name: '被篡改',
    forecastDividend: 99,
    dividendYield: 99,
    holdingShares: 999999,
    holdingCost: 0.01,
    riskGate: { verified: true },
  });
  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error?: string }).error ?? '', /symbol/);

  const after = await readDetail('601318.SH');
  assert.equal(after.stock.symbol, '601318.SH');
  assert.equal(after.stock.name, before.stock.name);
  assert.equal(after.stock.forecastDividend, before.stock.forecastDividend);
  assert.equal(after.stock.dividendYield, before.stock.dividendYield);
  assert.equal(after.stock.holdingShares, before.stock.holdingShares);
  assert.equal(after.stock.holdingCost, before.stock.holdingCost);
  assert.equal(after.stock.riskGate.verified, before.stock.riskGate.verified);
});

test('设置接口要求至少一个可写字段，且数值必须合法', async () => {
  const empty = await patchSettings('600941.SH', {});
  assert.equal(empty.status, 400);
  assert.match(((await empty.json()) as { error?: string }).error ?? '', /设置项/);

  const stringValue = await patchSettings('600941.SH', { buyThreshold: '6' });
  assert.equal(stringValue.status, 400);
  assert.match(((await stringValue.json()) as { error?: string }).error ?? '', /buyThreshold/);

  const arrayBody = await patchSettings('600941.SH', []);
  assert.equal(arrayBody.status, 400);
  assert.match(((await arrayBody.json()) as { error?: string }).error ?? '', /JSON对象/);
});

test('未保存假设时设置门槛同样落盘，重启后不回到默认值', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dividend-settings-'));
  const file = join(directory, 'settings.json');
  let first: Awaited<ReturnType<typeof startServer>> | null = null;
  let second: Awaited<ReturnType<typeof startServer>> | null = null;

  try {
    first = await startServer(undefined, undefined, undefined, {
      settingsStore: createFileSettingsStore(file),
    });
    const beforeResponse = await fetch(`${first.baseUrl}/api/stocks/601318.SH`);
    const before = (await beforeResponse.json()) as StockDetailResponse;
    assert.equal(before.stock.buyThreshold, 5.5);
    assert.equal(before.assumptionSaved, false);

    const patched = await fetch(`${first.baseUrl}/api/stocks/601318.SH/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyThreshold: 6.2 }),
    });
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as Stock).buyThreshold, 6.2);

    /** 第二次设置必须保留第一只标的的门槛快照，而不是覆盖成只剩本次修改。 */
    const secondPatch = await fetch(`${first.baseUrl}/api/stocks/601088.SH/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyThreshold: 6.5 }),
    });
    assert.equal(secondPatch.status, 200);

    await new Promise<void>((resolve, reject) => {
      first!.server.close((error) => (error ? reject(error) : resolve()));
    });
    first = null;

    /** 没有正式假设也必须沿用用户设定的门槛，而不是演示默认值。 */
    second = await startServer(undefined, undefined, undefined, {
      settingsStore: createFileSettingsStore(file),
    });
    const detailResponse = await fetch(`${second.baseUrl}/api/stocks/601318.SH`);
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()) as StockDetailResponse;
    assert.equal(detail.stock.buyThreshold, 6.2);
    assert.equal(detail.assumption.requiredYield, 6.2);
    assert.equal(detail.assumption.version, 0);
    assert.equal(detail.assumptionSaved, false);

    const otherResponse = await fetch(`${second.baseUrl}/api/stocks/601088.SH`);
    const other = (await otherResponse.json()) as StockDetailResponse;
    assert.equal(other.stock.buyThreshold, 6.5);

    const dashboardResponse = await fetch(`${second.baseUrl}/api/dashboard`);
    const dashboard = (await dashboardResponse.json()) as DashboardResponse;
    const radarStock = dashboard.stocks.find((stock) => stock.symbol === '601318.SH');
    assert.equal(radarStock?.buyThreshold, 6.2);
  } finally {
    if (first) await new Promise<void>((resolve) => first!.server.close(() => resolve()));
    if (second) await new Promise<void>((resolve) => second!.server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('门槛落盘失败时不写内存，内存保持变更前的默认值', async () => {
  const settingsStore: SettingsStore = {
    load: () => null,
    save: () => {
      throw new Error('EACCES: permission denied');
    },
  };
  const started = await startServer(undefined, undefined, undefined, { settingsStore });

  try {
    const response = await fetch(`${started.baseUrl}/api/stocks/601318.SH/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyThreshold: 6.2 }),
    });
    assert.equal(response.status, 500);

    const detailResponse = await fetch(`${started.baseUrl}/api/stocks/601318.SH`);
    const detail = (await detailResponse.json()) as StockDetailResponse;
    assert.equal(detail.stock.buyThreshold, 5.5);
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
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

test('风险原文日期必须是真实日历日期，伪日期不会被登记', async () => {
  const response = await postRisk({
    symbol: '600941.SH',
    title: '演示：伪日期公告',
    type: '公告',
    severity: 'low',
    summary: '演示：2026-02-31 与 2026-13-01 都不是真实日期，必须拒绝登记。',
    source: {
      publisher: '演示公告库',
      excerpt: '演示原文摘录：发布日期为不存在的日历日期。',
      publishedAt: '2026-02-31',
    },
  });
  assert.equal(response.status, 400);
  assert.match(
    ((await response.json()) as { error?: string }).error ?? '',
    /有效的YYYY-MM-DD/,
  );

  const monthOutOfRange = await postRisk({
    symbol: '600941.SH',
    title: '演示：非法月份',
    type: '公告',
    severity: 'low',
    summary: '演示：13 月同样不是合法日历日期。',
    source: {
      publisher: '演示公告库',
      excerpt: '演示原文摘录：月份越界。',
      publishedAt: '2026-13-01',
    },
  });
  assert.equal(monthOutOfRange.status, 400);
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
  assert.equal(verified.stock.riskGate.status, 'verified');
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
  assert.equal(added.stock.riskGate.status, 'blocked');
  assert.deepEqual(added.stock.riskGate.allowedLevels, []);
  assert.equal(added.stock.level, 'L0');
  assert.equal(added.stock.action, '风险阻断');

  const detail = await readDetail('601318.SH');
  assert.equal(detail.stock.level, 'L0');
  assert.equal(detail.stock.action, '风险阻断');
  assert.equal(detail.plan.every((tier) => !tier.unlocked), true);
  /** 全部锁定时资金计划必须同步归零，不能同时给出可执行买入。 */
  assert.equal(detail.allocation.totalShares, 0);
  assert.equal(detail.allocation.totalAllocated, 0);
  assert.ok(
    detail.allocation.tiers.every(
      (tier) => tier.allocatedShares === 0 && tier.blockers.some((reason) => reason.includes('风险闸门阻断')),
    ),
    '每个锁定档位都需给出风险阻断原因',
  );
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
  /** 风险页逐条状态与股票级闸门同源：全部核验后必然同时是 verified。 */
  const gateStock = finalDashboard.stocks.find((stock) => stock.symbol === '601318.SH');
  assert.equal(gateStock?.riskGate.status, 'verified');
  assert.equal(gateStock?.riskGate.openCount, 0);
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
  assert.equal(body.stock.riskGate.status, 'blocked');
  assert.deepEqual(body.stock.riskGate.allowedLevels, []);
  assert.equal(body.stock.action, '风险阻断');
});

test('雷达股票级风险状态与风险页逐条状态完全同源', async () => {
  const dashboard = (await (await fetch(`${baseUrl}/api/dashboard`)).json()) as DashboardResponse;

  for (const stock of dashboard.stocks) {
    const risks = dashboard.risks.filter((risk) => risk.symbol === stock.symbol);
    const open = risks.filter((risk) => risk.status !== 'verified');
    const expected =
      risks.length === 0
        ? 'clear'
        : open.length === 0
          ? 'verified'
          : open.some((risk) => risk.severity === 'high')
            ? 'blocked'
            : 'review';
    const allowed =
      expected === 'blocked' ? [] : expected === 'review' ? ['L1', 'L2'] : ['L1', 'L2', 'L3'];

    /** 股票级闸门只由风险事件派生：数量、状态与放行等级逐项对齐风险页。 */
    assert.equal(stock.riskGate.totalCount, risks.length, stock.symbol);
    assert.equal(stock.riskGate.openCount, open.length, stock.symbol);
    assert.equal(stock.riskGate.status, expected, stock.symbol);
    assert.deepEqual(stock.riskGate.allowedLevels, allowed, stock.symbol);
    /** 已解锁的等级不会被风险页的逐条状态推翻。 */
    const riskSignal = stock.signals.find((signal) => signal.key === 'risk');
    assert.ok(riskSignal, stock.symbol);
    if (expected === 'verified') {
      assert.equal(riskSignal.status, 'pass', stock.symbol);
      assert.match(riskSignal.value, /有效核验/, stock.symbol);
    }
    if (expected === 'blocked') {
      assert.equal(riskSignal.status, 'block', stock.symbol);
    }
  }
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

test('风险文件损坏时拒绝启动，且不覆盖原文件', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dividend-risk-broken-'));
  const file = join(directory, 'risks.json');
  const broken = '{"version":1,"items":[';
  writeFileSync(file, broken, 'utf8');

  try {
    assert.throws(
      () => createApp(createDemoState(), undefined, createFileRiskStore(file)),
      /风险核验文件/,
    );
    assert.equal(readFileSync(file, 'utf8'), broken);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('单条风险记录校验失败时拒绝启动，不静默丢弃高风险', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dividend-risk-invalid-'));
  const file = join(directory, 'risks.json');
  const items = [
    {
      id: 'risk-601318.SH',
      symbol: '601318.SH',
      title: '可正常解析的风险',
      type: '公告',
      severity: 'high',
      date: '2026-01-01',
      summary: '用于验证前一条合法记录不会被部分恢复',
      source: {
        publisher: '测试来源',
        url: null,
        excerpt: '原文摘录',
        publishedAt: '2026-01-01',
        revision: 1,
      },
      verification: null,
      invalidatedAt: null,
      invalidatedReason: null,
    },
    { id: 'risk-600941.SH', symbol: '600941.SH', type: '公告' },
  ];
  const content = JSON.stringify({ version: 1, items }, null, 2);
  writeFileSync(file, content, 'utf8');

  try {
    assert.throws(
      () => createApp(createDemoState(), undefined, createFileRiskStore(file)),
      /第 2 条/,
    );
    assert.equal(readFileSync(file, 'utf8'), content);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('失效时间损坏时拒绝启动，避免旧核验被当成未失效而复活', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dividend-risk-invalidated-'));
  const file = join(directory, 'risks.json');
  const content = JSON.stringify({
    version: 1,
    items: [
      {
        id: 'risk-601318.SH',
        symbol: '601318.SH',
        title: '已核验但已作废的风险',
        type: '公告',
        severity: 'medium',
        date: '2026-01-01',
        summary: '用于验证损坏的失效时间不会被静默当作未失效',
        source: {
          publisher: '测试来源',
          url: null,
          excerpt: '原文摘录',
          publishedAt: '2026-01-01',
          revision: 2,
        },
        verification: {
          verifiedAt: '2026-01-02T00:00:00.000Z',
          verifiedBy: '研究员',
          note: '已核对原文',
          evidenceUrl: 'https://example.com/notice',
          revision: 1,
          severity: 'medium',
          expiresAt: '2026-01-16T00:00:00.000Z',
        },
        invalidatedAt: 1767225600000,
        invalidatedReason: '原文更新至 v2，原核验失效',
      },
    ],
  });
  writeFileSync(file, content, 'utf8');

  try {
    assert.throws(
      () => createApp(createDemoState(), undefined, createFileRiskStore(file)),
      /第 1 条/,
    );
    assert.equal(readFileSync(file, 'utf8'), content);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('核验时间无法解析时拒绝启动，不把损坏时间当作有效核验', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dividend-risk-timestamp-'));
  const file = join(directory, 'risks.json');
  const content = JSON.stringify({
    version: 1,
    items: [
      {
        id: 'risk-601318.SH',
        symbol: '601318.SH',
        title: '核验时间损坏的风险',
        type: '公告',
        severity: 'medium',
        date: '2026-01-01',
        summary: '用于验证无法解析的核验时间会阻止启动',
        source: {
          publisher: '测试来源',
          url: null,
          excerpt: '原文摘录',
          publishedAt: '2026-01-01',
          revision: 1,
        },
        verification: {
          verifiedAt: 'not-a-date',
          verifiedBy: '研究员',
          note: '已核对原文',
          evidenceUrl: 'https://example.com/notice',
          revision: 1,
          severity: 'medium',
          expiresAt: '2026-01-16T00:00:00.000Z',
        },
        invalidatedAt: null,
        invalidatedReason: null,
      },
    ],
  });
  writeFileSync(file, content, 'utf8');

  try {
    assert.throws(
      () => createApp(createDemoState(), undefined, createFileRiskStore(file)),
      /第 1 条/,
    );
    assert.equal(readFileSync(file, 'utf8'), content);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('风险文件存在但为空时按空状态恢复，不回退演示种子', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dividend-risk-empty-'));
  const file = join(directory, 'risks.json');
  writeFileSync(file, JSON.stringify({ version: 1, items: [] }), 'utf8');
  const started = await startServer(undefined, createFileRiskStore(file));

  try {
    const dashboard = (await (
      await fetch(`${started.baseUrl}/api/dashboard`)
    ).json()) as DashboardResponse;
    assert.equal(dashboard.risks.length, 0);
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('默认拒绝非本机来源，回环来源按原样放行', async () => {
  const denied = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);

  /** 预检同样不放行：浏览器拿不到任何 CORS 头，写接口无法被跨站调用。 */
  const preflight = await fetch(`${baseUrl}/api/portfolio/trade`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 403);

  const allowed = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(allowed.headers.get('x-powered-by'), null);
});

test('显式白名单来源可访问，白名单外的来源仍被拒绝', async () => {
  const isolated = await startServer(undefined, undefined, undefined, {
    allowedOrigins: ['https://radar.example.com'],
  });
  try {
    const allowed = await fetch(`${isolated.baseUrl}/api/dashboard`, {
      headers: { Origin: 'https://radar.example.com' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://radar.example.com');

    const denied = await fetch(`${isolated.baseUrl}/api/dashboard`, {
      headers: { Origin: 'https://other.example.com' },
    });
    assert.equal(denied.status, 403);
  } finally {
    await new Promise<void>((resolve) => isolated.server.close(() => resolve()));
  }
});

test('配置访问令牌后读接口与写接口都必须带令牌', async () => {
  const guarded = await startServer(undefined, undefined, undefined, {
    accessToken: 's3cret-token',
  });
  try {
    const anonymous = await fetch(`${guarded.baseUrl}/api/dashboard`);
    assert.equal(anonymous.status, 401);

    const wrong = await fetch(`${guarded.baseUrl}/api/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: JSON.stringify({ symbol: '601318.SH' }),
    });
    assert.equal(wrong.status, 401);

    const bearer = await fetch(`${guarded.baseUrl}/api/dashboard`, {
      headers: { Authorization: 'Bearer s3cret-token' },
    });
    assert.equal(bearer.status, 200);

    const headerToken = await fetch(`${guarded.baseUrl}/api/dashboard`, {
      headers: { 'X-Access-Token': 's3cret-token' },
    });
    assert.equal(headerToken.status, 200);

    const exportAnonymous = await fetch(`${guarded.baseUrl}/api/export/watchlist`);
    assert.equal(exportAnonymous.status, 401);
  } finally {
    await new Promise<void>((resolve) => guarded.server.close(() => resolve()));
  }
});

test('卖出候选包含全部现有持仓，移出观察仓后仍可卖出', async () => {
  const isolated = await startServer();
  try {
    const buyResponse = await fetch(`${isolated.baseUrl}/api/portfolio/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: '000333.SZ', side: 'buy', shares: 100, price: 70 }),
    });
    assert.equal(buyResponse.status, 200);
    const bought = (await buyResponse.json()) as TradeResponse;
    /** 交易响应携带重算后的快照，持仓字段随成交同步。 */
    assert.equal(
      bought.stocks.find((stock) => stock.symbol === '000333.SZ')?.holdingShares,
      100,
    );

    const removeResponse = await fetch(`${isolated.baseUrl}/api/watchlist/000333.SZ`, {
      method: 'DELETE',
    });
    assert.equal(removeResponse.status, 200);

    const dashboard = (await (
      await fetch(`${isolated.baseUrl}/api/dashboard`)
    ).json()) as DashboardResponse;
    assert.ok(dashboard.stocks.every((stock) => stock.symbol !== '000333.SZ'));
    const candidate = dashboard.tradeStocks.find((stock) => stock.symbol === '000333.SZ');
    assert.ok(candidate, '移出观察仓的持仓仍必须出现在交易候选里');
    assert.equal(candidate.holdingShares, 100);

    const sellResponse = await fetch(`${isolated.baseUrl}/api/portfolio/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: '000333.SZ', side: 'sell', shares: 100, price: 70 }),
    });
    assert.equal(sellResponse.status, 200);
    const sold = (await sellResponse.json()) as TradeResponse;
    assert.equal(sold.positions.some((position) => position.symbol === '000333.SZ'), false);
    assert.equal(sold.trades[0].side, 'sell');
    assert.equal(
      sold.stocks.find((stock) => stock.symbol === '000333.SZ')?.holdingShares ?? 0,
      0,
    );
  } finally {
    await new Promise<void>((resolve) => isolated.server.close(() => resolve()));
  }
});

test('交易接口拒绝非法价格，导出CSV禁用缓存且按最新账本重算', async () => {
  const isolated = await startServer();
  try {
    const rejected = await fetch(`${isolated.baseUrl}/api/portfolio/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: '601318.SH', side: 'sell', shares: 100, price: 0.001 }),
    });
    assert.equal(rejected.status, 400);
    const body = (await rejected.json()) as { error?: string };
    assert.match(body.error ?? '', /0\.01/);

    const before = await fetch(`${isolated.baseUrl}/api/export/watchlist`);
    assert.equal(before.status, 200);
    assert.equal(before.headers.get('cache-control'), 'no-store');
    await before.text();

    const sellResponse = await fetch(`${isolated.baseUrl}/api/portfolio/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: '601318.SH', side: 'sell', shares: 100, price: 48.6 }),
    });
    assert.equal(sellResponse.status, 200);

    const after = await fetch(`${isolated.baseUrl}/api/export/watchlist`);
    assert.equal(after.headers.get('cache-control'), 'no-store');
    const rows = (await after.text()).split('\r\n');
    const header = rows[0].replaceAll('"', '').split(',');
    const sharesIndex = header.indexOf('holdingShares');
    const row = rows.find((line) => line.includes('601318.SH'))!;
    assert.equal(row.replaceAll('"', '').split(',')[sharesIndex], '1900');
  } finally {
    await new Promise<void>((resolve) => isolated.server.close(() => resolve()));
  }
});

test('跨源导出暴露 Content-Disposition，前端可保留服务端文件名', async () => {
  const response = await fetch(`${baseUrl}/api/export/watchlist`, {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') ?? '', /filename="watchlist-/);
  assert.match(
    response.headers.get('access-control-expose-headers') ?? '',
    /Content-Disposition/i,
  );
  await response.text();
});

test('非法成交日期直接拒绝，不会静默替换成行情日', async () => {
  const isolated = await startServer();
  try {
    const readDashboard = async () =>
      (await (await fetch(`${isolated.baseUrl}/api/dashboard`)).json()) as DashboardResponse;
    const before = await readDashboard();

    const trade = (body: unknown) =>
      fetch(`${isolated.baseUrl}/api/portfolio/trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const pseudoDay = await trade({
      symbol: '601318.SH',
      side: 'buy',
      shares: 100,
      price: 48.6,
      executedAt: '2026-02-31',
    });
    assert.equal(pseudoDay.status, 400);
    assert.match(((await pseudoDay.json()) as { error?: string }).error ?? '', /成交日期/);

    const malformed = await trade({
      symbol: '601318.SH',
      side: 'buy',
      shares: 100,
      price: 48.6,
      executedAt: '2026/10/23',
    });
    assert.equal(malformed.status, 400);

    const rejected = await readDashboard();
    assert.equal(rejected.portfolio.cash, before.portfolio.cash);
    assert.equal(rejected.portfolio.trades.length, before.portfolio.trades.length);
    assert.equal(
      rejected.portfolio.positions.find((item) => item.symbol === '601318.SH')?.shares,
      before.portfolio.positions.find((item) => item.symbol === '601318.SH')?.shares,
    );

    /** 省略成交日期仍按行情日记录，但这是缺省值而不是对非法输入的替换。 */
    const accepted = await trade({ symbol: '601318.SH', side: 'buy', shares: 100, price: 48.6 });
    assert.equal(accepted.status, 200);
    const portfolio = (await accepted.json()) as TradeResponse;
    assert.equal(portfolio.trades.at(-1)?.executedAt, '2026-10-23');
  } finally {
    await new Promise<void>((resolve) => isolated.server.close(() => resolve()));
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
  /** 预览快照与分配必须同属一套预览口径，不能拼上旧等级与旧股数。 */
  assert.equal(preview.stock.forecastDividend, 3.95);
  assert.equal(preview.stock.buyThreshold, 6);
  assert.equal(preview.stock.assumptionVersion, 1);
  assert.deepEqual(
    preview.allocation.tiers.map((tier) => tier.targetPrice),
    preview.plan.map((tier) => tier.targetPrice),
  );

  const budgeted = await postAssumptionPreview(
    '600941.SH',
    { forecastYear: 2026, scenario: 'conservative', requiredYield: 6 },
    baseUrl,
    10_000,
  );
  assert.equal(budgeted.status, 200);
  const budgetedPreview = (await budgeted.json()) as AssumptionPreviewResponse;
  assert.equal(budgetedPreview.allocation.approvedBudget, 10_000);
  assert.deepEqual(
    budgetedPreview.allocation.tiers.map((tier) => tier.targetPrice),
    preview.plan.map((tier) => tier.targetPrice),
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

test('组合落盘失败时交易与观察仓变更整体回滚，重试只记账一次', async () => {
  /** 注入磁盘满：落盘抛错，恢复后才真正写入。 */
  let diskFull = true;
  const writes: PersistedPortfolio[] = [];
  const portfolioStore: PortfolioStore = {
    load: () => null,
    save: (next) => {
      if (diskFull) throw new Error('ENOSPC: no space left on device');
      writes.push(structuredClone(next));
    },
  };
  const started = await startServer(undefined, undefined, portfolioStore);
  const tradeBody = {
    symbol: '000333.SZ',
    side: 'buy',
    shares: 100,
    price: 70,
    executedAt: '2026-10-29',
  };

  try {
    const failedTrade = await fetch(`${started.baseUrl}/api/portfolio/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tradeBody),
    });
    assert.equal(failedTrade.status, 500);

    const failedAdd = await fetch(`${started.baseUrl}/api/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: '601088.SH' }),
    });
    assert.equal(failedAdd.status, 500);

    /** 内存必须保持变更前：现金未扣、账本为空、持仓与观察仓未动。 */
    const afterFailure = (await (
      await fetch(`${started.baseUrl}/api/dashboard`)
    ).json()) as DashboardResponse;
    assert.equal(afterFailure.portfolio.cash, 50_000);
    assert.equal(afterFailure.portfolio.trades.length, 0);
    assert.equal(
      afterFailure.tradeStocks.find((stock) => stock.symbol === '000333.SZ')?.holdingShares,
      0,
    );
    assert.ok(afterFailure.stocks.every((stock) => stock.symbol !== '601088.SH'));
    assert.equal(writes.length, 0, '落盘失败时不应产生任何写入');

    diskFull = false;
    const retriedTrade = await fetch(`${started.baseUrl}/api/portfolio/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tradeBody),
    });
    assert.equal(retriedTrade.status, 200);
    const traded = (await retriedTrade.json()) as TradeResponse;
    /** 失败的那一笔没有留在内存里，重试后账本只有一笔成交。 */
    assert.equal(traded.trades.length, 1);
    assert.equal(
      traded.stocks.find((stock) => stock.symbol === '000333.SZ')?.holdingShares,
      100,
    );
    assert.ok(traded.cash < 50_000);

    const retriedAdd = await fetch(`${started.baseUrl}/api/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: '601088.SH' }),
    });
    assert.equal(retriedAdd.status, 200);
    const catalog = (await retriedAdd.json()) as Array<{ symbol: string; inWatchlist: boolean }>;
    assert.equal(catalog.find((item) => item.symbol === '601088.SH')?.inWatchlist, true);
    assert.equal(writes.length, 2);
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
});

test('假设与风险落盘失败时不升版本、不写核验，恢复后重试只生效一次', async () => {
  let diskFull = true;
  const persistedAssumptions: unknown[] = [];
  const assumptionStore: AssumptionStore = {
    load: () => [],
    save: (items) => {
      if (diskFull) throw new Error('EACCES: permission denied');
      persistedAssumptions.push(structuredClone(items));
    },
  };
  const riskStore: RiskStore = {
    load: () => null,
    save: () => {
      if (diskFull) throw new Error('EACCES: permission denied');
    },
  };
  const started = await startServer(assumptionStore, riskStore);
  const verifyBody = {
    note: '已核对平安公告原文与派息口径',
    evidenceUrl: 'https://example.com/pingan/notice',
  };

  try {
    const failedAssumption = await postAssumption(
      '601088.SH',
      { forecastYear: 2028, scenario: 'base', requiredYield: 7 },
      started.baseUrl,
    );
    assert.equal(failedAssumption.status, 500);
    const failedVerify = await postRiskVerify('risk-601318.SH', verifyBody, started.baseUrl);
    assert.equal(failedVerify.status, 500);

    /** 内存必须保持变更前：假设未保存、版本仍为0，风险仍待核验。 */
    const detailResponse = await fetch(`${started.baseUrl}/api/stocks/601088.SH`);
    const detail = (await detailResponse.json()) as StockDetailResponse;
    assert.equal(detail.assumptionSaved, false);
    assert.equal(detail.assumption.version, 0);
    assert.equal(detail.stock.assumptionVersion, 0);

    const afterFailure = (await (
      await fetch(`${started.baseUrl}/api/dashboard`)
    ).json()) as DashboardResponse;
    const unfixed = afterFailure.risks.find((risk) => risk.id === 'risk-601318.SH');
    assert.equal(unfixed?.status, 'pending');
    assert.equal(unfixed?.verification, null);
    assert.equal(persistedAssumptions.length, 0, '落盘失败时不应产生任何写入');

    diskFull = false;
    const retriedAssumption = await postAssumption(
      '601088.SH',
      { forecastYear: 2028, scenario: 'base', requiredYield: 7 },
      started.baseUrl,
    );
    assert.equal(retriedAssumption.status, 200);
    const saved = (await retriedAssumption.json()) as StockDetailResponse;
    /** 失败的那一次没有递增版本，重试后仍是 v1。 */
    assert.equal(saved.assumption.version, 1);
    assert.equal(persistedAssumptions.length, 1);

    const retriedVerify = await postRiskVerify('risk-601318.SH', verifyBody, started.baseUrl);
    assert.equal(retriedVerify.status, 200);
    const verified = (await retriedVerify.json()) as RiskMutationResponse;
    assert.equal(verified.risk.status, 'verified');
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
});
