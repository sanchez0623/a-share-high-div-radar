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
  Stock,
  StockDetailResponse,
} from '../shared/types.ts';
import { researchPrice } from '../shared/assumptions.ts';
import { createApp } from './app.ts';
import { createFileAssumptionStore } from './assumption-store.ts';
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

async function startServer(store?: ReturnType<typeof createFileAssumptionStore>) {
  const app = store ? createApp(createDemoState(), store) : createApp(createDemoState());
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

test('风险状态可与门槛一起更新且类型错误被拒绝', async () => {
  const accepted = await patchSettings('601318.SH', { riskVerified: true });
  assert.equal(accepted.status, 200);
  const stock = (await accepted.json()) as Stock;
  assert.equal(stock.riskVerified, true);
  assert.equal(stock.buyThreshold, 6.2);

  const rejected = await patchSettings('601318.SH', { riskVerified: 'yes' });
  assert.equal(rejected.status, 400);
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
