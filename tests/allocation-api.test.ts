import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWearTelemetry } from '../src/demo-data.js';
import { createApp } from '../src/server.js';
import { LocalStore } from '../src/store.js';
import { Engine, MaintenanceEvent, TelemetrySample } from '../src/types.js';

type App = Awaited<ReturnType<typeof createApp>>;

function engineFixture(id: string, wear: number, options: Parameters<typeof createWearTelemetry>[1] = {}): { engine: Engine; telemetry: TelemetrySample[] } {
  const engine: Engine = {
    id, serialNumber: `SN-${id}`, model: 'AeroCore-X90', aircraftId: 'AC-X',
    installedAt: '2024-04-12', totalCycles: 1800, status: 'healthy', currentHealthScore: 100,
  };
  return { engine, telemetry: createWearTelemetry(id, { wear, ...options }) };
}

describe('allocation API and persistence', () => {
  let dir: string;
  let file: string;
  let app: App;
  let store: LocalStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'alloc-test-'));
    file = join(dir, 'state.json');
    store = new LocalStore(file);
    app = await createApp(store);
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function seedEngine(id: string, wear: number, options: Parameters<typeof createWearTelemetry>[1] = {}): Promise<void> {
    const { engine, telemetry } = engineFixture(id, wear, options);
    await app.inject({ method: 'POST', url: '/api/engines/import', payload: { engine, telemetry } });
    await app.inject({ method: 'POST', url: `/api/engines/${id}/health-assessment`, payload: { modelId: 'health-v2' } });
    await app.inject({ method: 'POST', url: `/api/engines/${id}/rul-prediction`, payload: { horizonCycles: 240 } });
  }

  it('runs the full pipeline across a multi-engine fleet and exposes exclusions', async () => {
    await seedEngine('ENG-S1', 2);
    await seedEngine('ENG-S2', 1.3, { vibrationBias: 1.1, fuelBias: -3 });
    await seedEngine('ENG-S3', 0.3);
    // 只有评估没有预测
    const s4 = engineFixture('ENG-S4', 1.5);
    await app.inject({ method: 'POST', url: '/api/engines/import', payload: { engine: s4.engine, telemetry: s4.telemetry } });
    await app.inject({ method: 'POST', url: '/api/engines/ENG-S4/health-assessment', payload: { modelId: 'health-v2' } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/maintenance-allocation/plans',
      payload: {
        totalQuota: 2,
        lifeHorizonCycles: 120,
        slots: [
          { slotId: 'SLOT-BEARING', name: '轴承专项', totalCapacity: 1, componentCapacities: { bearing: 1 } },
          { slotId: 'SLOT-GENERAL', name: '通用', totalCapacity: 1 },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.reused).toBe(false);
    expect(body.plan.entries[0].engineId).toBe('ENG-S1');
    const bearingEntry = body.plan.entries.find((entry: { engineId: string }) => entry.engineId === 'ENG-S2');
    expect(bearingEntry.slotId).toBe('SLOT-BEARING');
    const reasons = body.plan.exclusions.map((item: { reason: string }) => item.reason);
    expect(reasons).toContain('missing_prediction'); // ENG-S4
    expect(reasons).toContain('quota_exceeded');    // ENG-S3 或其他落选
  });

  it('deduplicates repeated submissions carrying the same clientRequestId', async () => {
    await seedEngine('ENG-D1', 1.7);
    const payload = { totalQuota: 1, clientRequestId: 'idem-001' };
    const first = await app.inject({ method: 'POST', url: '/api/maintenance-allocation/plans', payload });
    const second = await app.inject({ method: 'POST', url: '/api/maintenance-allocation/plans', payload });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);
    const secondBody = JSON.parse(second.body);
    expect(secondBody.reused).toBe(true);
    expect(secondBody.plan.planId).toBe(firstBody.plan.planId);
    const list = await app.inject({ method: 'GET', url: '/api/maintenance-allocation/plans' });
    expect(JSON.parse(list.body)).toHaveLength(1);
  });

  it('marks a saved plan stale after re-assessment, and after a maintenance event', async () => {
    await seedEngine('ENG-R1', 1.4);
    const created = await app.inject({ method: 'POST', url: '/api/maintenance-allocation/plans', payload: { totalQuota: 1, clientRequestId: 'stale-001' } });
    const planId = JSON.parse(created.body).plan.planId;

    const before = await app.inject({ method: 'GET', url: `/api/maintenance-allocation/plans/${planId}` });
    expect(JSON.parse(before.body).status).toBe('active');

    await app.inject({ method: 'POST', url: '/api/engines/ENG-R1/health-assessment', payload: { modelId: 'health-v2' } });
    const afterAssessment = await app.inject({ method: 'GET', url: `/api/maintenance-allocation/plans/${planId}` });
    const stale1 = JSON.parse(afterAssessment.body);
    expect(stale1.status).toBe('stale');
    expect(stale1.stalenessCauses.map((cause: { cause: string }) => cause.cause)).toContain('assessment_recreated');

    const event: MaintenanceEvent = { id: 'M-R1', engineId: 'ENG-R1', component: 'bearing', occurredAt: new Date(Date.now() + 3_600_000).toISOString(), action: 'replacement', severity: 'mandatory', note: 'replace' };
    await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: event });
    const afterMaintenance = await app.inject({ method: 'GET', url: `/api/maintenance-allocation/plans/${planId}` });
    const stale2 = JSON.parse(afterMaintenance.body);
    expect(stale2.stalenessCauses.map((cause: { cause: string }) => cause.cause)).toContain('maintenance_recorded');
  });

  it('survives restart: plans persist, duplicate submission stays idempotent, old state files migrate', async () => {
    await seedEngine('ENG-P1', 1.6);
    const created = await app.inject({ method: 'POST', url: '/api/maintenance-allocation/plans', payload: { totalQuota: 1, clientRequestId: 'restart-001' } });
    const planId = JSON.parse(created.body).plan.planId;

    // 重启：用同一个 state.json 新建 store 与 app
    await app.close();
    store = new LocalStore(file);
    app = await createApp(store);

    const fetched = await app.inject({ method: 'GET', url: `/api/maintenance-allocation/plans/${planId}` });
    expect(fetched.statusCode).toBe(200);
    expect(JSON.parse(fetched.body).planId).toBe(planId);

    const resubmitted = await app.inject({ method: 'POST', url: '/api/maintenance-allocation/plans', payload: { totalQuota: 1, clientRequestId: 'restart-001' } });
    const resubmittedBody = JSON.parse(resubmitted.body);
    expect(resubmittedBody.reused).toBe(true);
    expect(resubmittedBody.plan.planId).toBe(planId);
    const list = await app.inject({ method: 'GET', url: '/api/maintenance-allocation/plans' });
    expect(JSON.parse(list.body)).toHaveLength(1);
  });

  it('migrates a legacy state file without allocationPlans', async () => {
    await app.close();
    const legacy = JSON.parse(await readFile(file, 'utf8'));
    delete legacy.allocationPlans;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify(legacy));

    store = new LocalStore(file);
    app = await createApp(store);
    const list = await app.inject({ method: 'GET', url: '/api/maintenance-allocation/plans' });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body)).toEqual([]);
  });

  it('rejects invalid quota, weights and unknown engines', async () => {
    const badQuota = await app.inject({ method: 'POST', url: '/api/maintenance-allocation/plans', payload: { totalQuota: 0 } });
    expect(badQuota.statusCode).toBe(400);
    const badWeight = await app.inject({ method: 'POST', url: '/api/maintenance-allocation/plans', payload: { riskWeight: 1.5 } });
    expect(badWeight.statusCode).toBe(400);
    const badEngine = await app.inject({ method: 'POST', url: '/api/maintenance-allocation/plans', payload: { engineIds: ['ENG-NOPE'] } });
    expect(badEngine.statusCode).toBe(400);
    const badSlot = await app.inject({ method: 'POST', url: '/api/maintenance-allocation/plans', payload: { slots: [{ slotId: 'S1', totalCapacity: 0 }] } });
    expect(badSlot.statusCode).toBe(400);
  });
});
