import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWearTelemetry } from './demo-data.js';
import { createApp } from './server.js';
import { LocalStore } from './store.js';
import { Engine, MaintenanceEvent, TelemetrySample } from './types.js';

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function makeEngine(id: string, wear: number, options: Parameters<typeof createWearTelemetry>[1]): { engine: Engine; telemetry: TelemetrySample[] } {
  const engine: Engine = {
    id, serialNumber: `SN-${id}`, model: 'AeroCore-X90', aircraftId: `AC-${id.slice(-4)}`,
    installedAt: '2024-04-12', totalCycles: 1800, status: 'healthy', currentHealthScore: 100,
  };
  return { engine, telemetry: createWearTelemetry(id, { wear, ...options }) };
}

if (process.argv[2] === 'demo') {
  const app = await createApp();
  const assessment = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/health-assessment', payload: { modelId: 'health-v2' } });
  const prediction = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/rul-prediction', payload: { horizonCycles: 240 } });
  console.log(JSON.stringify({ assessment: JSON.parse(assessment.body), prediction: JSON.parse(prediction.body) }, null, 2));
  await app.close();
}

if (process.argv[2] === 'allocation-demo') {
  const file = join(tmpdir(), `allocation-demo-${Date.now()}.json`);
  const store = new LocalStore(file);
  await store.init();
  const app = await createApp(store);

  const fleet: Array<{ id: string; wear: number; options: Parameters<typeof createWearTelemetry>[1] }> = [
    { id: 'ENG-A1', wear: 2, options: {} },                 // 最危急：压气机限制，寿命下界很低
    { id: 'ENG-A2', wear: 1.7, options: {} },               // 严重：压气机限制
    { id: 'ENG-A3', wear: 1.3, options: { vibrationBias: 1.1, fuelBias: -3 } }, // 轴承限制
    { id: 'ENG-A4', wear: 1.3, options: { oilBias: -1.2 } }, // 润滑限制
    { id: 'ENG-A5', wear: 0.3, options: {} },               // 健康
    { id: 'ENG-A6', wear: 1.5, options: {} },               // 只有评估、没有预测
    { id: 'ENG-A7', wear: 1.4, options: {} },               // 评估/预测已过期
  ];

  for (const item of fleet) {
    const { engine, telemetry } = makeEngine(item.id, item.wear, item.options);
    store.addEngine(engine);
    store.addTelemetry(telemetry);
  }
  for (const id of fleet.map(item => item.id)) {
    await app.inject({ method: 'POST', url: `/api/engines/${id}/health-assessment`, payload: { modelId: 'health-v2' } });
    if (id !== 'ENG-A6') await app.inject({ method: 'POST', url: `/api/engines/${id}/rul-prediction`, payload: { horizonCycles: 240 } });
  }
  // A7 的评估和预测回拨到 10 天前，构造“数据过期”
  {
    const a7Assessment = store.assessments.find(item => item.engineId === 'ENG-A7');
    const a7Prediction = store.predictions.find(item => item.engineId === 'ENG-A7');
    if (a7Assessment) a7Assessment.createdAt = hoursAgo(240);
    if (a7Prediction) a7Prediction.createdAt = hoursAgo(240);
    await store.persist();
  }

  const payload = {
    planName: '10月维护协调会排程',
    totalQuota: 3,
    riskWeight: 0.6,
    urgencyWeight: 0.4,
    lifeHorizonCycles: 120,
    assessmentMaxAgeHours: 24 * 7,
    predictionMaxAgeHours: 24 * 7,
    engineIds: fleet.map(item => item.id),
    slots: [
      { slotId: 'SLOT-BEARING', name: '轴承专项检修名额', totalCapacity: 1, componentCapacities: { bearing: 1 } },
      { slotId: 'SLOT-GENERAL', name: '通用检修名额', totalCapacity: 2 },
    ],
    clientRequestId: 'meeting-2026-10-02-001',
  };

  const first = await app.inject({ method: 'POST', url: '/api/maintenance-allocation/plans', payload });
  const plan = JSON.parse(first.body).plan as ReturnType<typeof JSON.parse> & { planId: string };
  console.log('=== 首次提交（HTTP', first.statusCode, '）===');
  printSummary(plan);

  // 重复提交同一 clientRequestId：必须返回原方案
  const duplicate = await app.inject({ method: 'POST', url: '/api/maintenance-allocation/plans', payload });
  const dupBody = JSON.parse(duplicate.body);
  console.log('\n=== 重复提交 ===');
  console.log(`reused=${dupBody.reused}，planId=${dupBody.plan.planId} 与首次一致：${dupBody.plan.planId === plan.planId}`);

  // A2 重新评估 → 方案过期
  await app.inject({ method: 'POST', url: '/api/engines/ENG-A2/health-assessment', payload: { modelId: 'health-v2' } });
  // A1 在方案生成后被记录一次维护 → 方案过期
  const event: MaintenanceEvent = { id: 'M-A1-001', engineId: 'ENG-A1', component: 'compressor', occurredAt: hoursAgo(-1), action: 'repair', severity: 'mandatory', note: '协调会后紧急压气机修复' };
  await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: event });

  const afterChange = await app.inject({ method: 'GET', url: `/api/maintenance-allocation/plans/${plan.planId}` });
  const changed = JSON.parse(afterChange.body);
  console.log('\n=== 重新评估 + 新维护后读取 ===');
  console.log(`status=${changed.status}`);
  for (const cause of changed.stalenessCauses) console.log(`  - [${cause.cause}] ${cause.detail}`);

  // 重新生成方案（新 clientRequestId），A1 因预测后发生维护被排除
  const regenerated = await app.inject({ method: 'POST', url: '/api/maintenance-allocation/plans', payload: { ...payload, planName: '10月维护协调会排程（修订）', clientRequestId: 'meeting-2026-10-02-002' } });
  console.log('\n=== 状态变化后重新生成 ===');
  printSummary(JSON.parse(regenerated.body).plan);

  await app.close();
  await rm(file, { force: true });
}

function printSummary(plan: any): void {
  const componentLabel: Record<string, string> = { hot_section: '热端部件', compressor: '压气机', bearing: '轴承', lubrication: '润滑系统' };
  console.log(`方案 ${plan.planId}「${plan.planName}」生成于 ${plan.createdAt}，状态 ${plan.status}`);
  console.log('入选排程：');
  for (const entry of plan.entries) {
    console.log(`  #${entry.rank} ${entry.engineId} → ${entry.slotName}（匹配 ${componentLabel[entry.matchedComponent] ?? entry.matchedComponent}）优先级=${entry.priorityScore} RUL下界=${entry.lowerBound}`);
  }
  console.log('未入选 / 数据问题：');
  for (const item of plan.exclusions) {
    console.log(`  - ${item.engineId} [${item.reason}] ${item.detail}`);
  }
  console.log('名额使用：');
  for (const usage of plan.capacityUsage) {
    console.log(`  - ${usage.slotName}: ${usage.assigned}/${usage.totalCapacity}`);
  }
}
