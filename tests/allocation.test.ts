import { describe, expect, it } from 'vitest';
import { buildAllocationPlan, detectPlanStaleness, withComputedStatus } from '../src/allocation.js';
import { Component, Engine, EngineStatus, HealthAssessment, MaintenanceEvent, RulPrediction } from '../src/types.js';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const iso = (hoursOffset: number) => new Date(NOW.getTime() + hoursOffset * 3_600_000).toISOString();

function makeEngine(id: string, overrides: Partial<Engine> = {}): Engine {
  return { id, serialNumber: `SN-${id}`, model: 'X90', aircraftId: 'AC', installedAt: '2024-01-01', totalCycles: 1800, status: 'healthy', currentHealthScore: 100, ...overrides };
}

function makeAssessment(
  engineId: string,
  healthScore: number,
  status: EngineStatus = 'degraded',
  overrides: Partial<HealthAssessment> = {},
): HealthAssessment {
  return {
    assessmentId: `ASSESS-${engineId}`,
    engineId,
    modelVersion: 'health-v2',
    createdAt: iso(-2),
    sampleCount: 72,
    healthScore,
    status,
    dataQuality: { score: 95, usableSamples: 72, rejectedSamples: 0, missingIntervals: 0 },
    indicators: { exhaustTemperatureMargin: 40, fuelEfficiencyIndex: 60, vibrationRisk: 30, oilPressureMargin: 1, degradationSlope: 0.02 },
    componentRisks: [],
    anomalies: [],
    explanation: [],
    ...overrides,
  };
}

function makePrediction(
  engineId: string,
  lowerBound: number,
  limitingComponent: Component = 'compressor',
  overrides: Partial<RulPrediction> = {},
): RulPrediction {
  return {
    predictionId: `RUL-${engineId}`,
    engineId,
    modelVersion: 'health-v2',
    createdAt: iso(-1),
    horizonCycles: 240,
    estimatedRemainingCycles: lowerBound + 10,
    confidence: 80,
    lowerBound,
    upperBound: lowerBound + 40,
    limitingComponent,
    riskByHorizon: [],
    evidence: [],
    ...overrides,
  };
}

function makeMaintenance(engineId: string, occurredAt: string): MaintenanceEvent {
  return { id: `M-${engineId}-${occurredAt}`, engineId, component: 'compressor', occurredAt, action: 'repair', severity: 'important', note: 'test' };
}

describe('maintenance resource allocation', () => {
  it('ranks multiple engines by risk and RUL lower bound and respects the global quota', () => {
    const engines = ['ENG-A', 'ENG-B', 'ENG-C'].map(id => makeEngine(id));
    const assessments = [
      makeAssessment('ENG-A', 40, 'critical'),   // 风险最高
      makeAssessment('ENG-B', 60, 'degraded'),
      makeAssessment('ENG-C', 82, 'watch'),       // 最健康
    ];
    const predictions = [makePrediction('ENG-A', 20), makePrediction('ENG-B', 60), makePrediction('ENG-C', 150)];
    const plan = buildAllocationPlan({ engines, assessments, predictions, maintenance: [], now: NOW, planId: 'PLAN-T1', request: { totalQuota: 2, lifeHorizonCycles: 120 } });

    expect(plan.entries.map(entry => entry.engineId)).toEqual(['ENG-A', 'ENG-B']);
    expect(plan.entries.map(entry => entry.rank)).toEqual([1, 2]);
    expect(plan.entries[0].priorityScore).toBeGreaterThan(plan.entries[1].priorityScore);
    expect(plan.exclusions).toContainEqual(expect.objectContaining({ engineId: 'ENG-C', reason: 'quota_exceeded', rank: 3 }));
    expect(plan.capacityUsage[0]).toMatchObject({ slotId: 'SLOT-DEFAULT', assigned: 2, totalCapacity: 2 });
  });

  it('breaks equal-priority ties deterministically by lower bound, health score and id', () => {
    const makeSet = () => {
      const engines = ['ENG-Z', 'ENG-A', 'ENG-M'].map(id => makeEngine(id));
      const assessments = engines.map(engine => makeAssessment(engine.id, 60, 'degraded'));
      const predictions = engines.map(engine => makePrediction(engine.id, 40, 'compressor'));
      return buildAllocationPlan({ engines, assessments, predictions, maintenance: [], now: NOW, request: { totalQuota: 3, lifeHorizonCycles: 120 } });
    };
    const first = makeSet();
    for (let i = 0; i < 10; i += 1) expect(makeSet().entries.map(entry => entry.engineId)).toEqual(first.entries.map(entry => entry.engineId));
    expect(first.entries.map(entry => entry.engineId)).toEqual(['ENG-A', 'ENG-M', 'ENG-Z']);
  });

  it('prefers component-specific slots and falls back to general slots', () => {
    const engines = ['ENG-1', 'ENG-2', 'ENG-3'].map(id => makeEngine(id));
    const assessments = engines.map(engine => makeAssessment(engine.id, 55, 'degraded'));
    const predictions = [
      makePrediction('ENG-1', 30, 'bearing'),
      makePrediction('ENG-2', 32, 'bearing'),
      makePrediction('ENG-3', 34, 'compressor'),
    ];
    const plan = buildAllocationPlan({
      engines, assessments, predictions, maintenance: [], now: NOW,
      request: {
        totalQuota: 3,
        slots: [
          { slotId: 'SLOT-BEARING', name: '轴承专项', totalCapacity: 1, componentCapacities: { bearing: 1 } },
          { slotId: 'SLOT-GENERAL', name: '通用', totalCapacity: 2 },
        ],
      },
    });
    const bearing = plan.entries.find(entry => entry.engineId === 'ENG-1');
    const secondBearing = plan.entries.find(entry => entry.engineId === 'ENG-2');
    const compressor = plan.entries.find(entry => entry.engineId === 'ENG-3');
    expect(bearing?.slotId).toBe('SLOT-BEARING');
    expect(bearing?.matchedComponent).toBe('bearing');
    // 轴承专项名额已满，第二台轴承发动机回退到通用窗口
    expect(secondBearing?.slotId).toBe('SLOT-GENERAL');
    expect(compressor?.slotId).toBe('SLOT-GENERAL');
    expect(plan.capacityUsage.find(slot => slot.slotId === 'SLOT-BEARING')).toMatchObject({ assigned: 1, componentUsed: { bearing: 1 } });
  });

  it('excludes engines without a prediction', () => {
    const engines = [makeEngine('ENG-A'), makeEngine('ENG-B')];
    const plan = buildAllocationPlan({
      engines,
      assessments: [makeAssessment('ENG-A', 50), makeAssessment('ENG-B', 60)],
      predictions: [makePrediction('ENG-A', 40)],
      maintenance: [], now: NOW,
    });
    expect(plan.entries.map(entry => entry.engineId)).toEqual(['ENG-A']);
    expect(plan.exclusions).toContainEqual(expect.objectContaining({ engineId: 'ENG-B', reason: 'missing_prediction' }));
  });

  it('excludes engines without an assessment even when a prediction exists', () => {
    const plan = buildAllocationPlan({
      engines: [makeEngine('ENG-A')],
      assessments: [],
      predictions: [makePrediction('ENG-A', 40)],
      maintenance: [], now: NOW,
    });
    expect(plan.entries).toHaveLength(0);
    expect(plan.exclusions).toContainEqual(expect.objectContaining({ reason: 'missing_assessment' }));
  });

  it('excludes engines whose assessment or prediction is expired', () => {
    const plan = buildAllocationPlan({
      engines: [makeEngine('ENG-A'), makeEngine('ENG-B')],
      assessments: [
        makeAssessment('ENG-A', 50, 'degraded', { createdAt: iso(-200) }),
        makeAssessment('ENG-B', 55, 'degraded', { createdAt: iso(-2) }),
      ],
      predictions: [
        makePrediction('ENG-A', 30),
        makePrediction('ENG-B', 30, 'compressor', { createdAt: iso(-200) }),
      ],
      maintenance: [], now: NOW,
      request: { assessmentMaxAgeHours: 48, predictionMaxAgeHours: 48 },
    });
    expect(plan.exclusions).toContainEqual(expect.objectContaining({ engineId: 'ENG-A', reason: 'assessment_expired' }));
    expect(plan.exclusions).toContainEqual(expect.objectContaining({ engineId: 'ENG-B', reason: 'prediction_expired' }));
    expect(plan.entries).toHaveLength(0);
  });

  it('excludes engines when maintenance happened after the prediction was created', () => {
    const plan = buildAllocationPlan({
      engines: [makeEngine('ENG-A')],
      assessments: [makeAssessment('ENG-A', 50)],
      predictions: [makePrediction('ENG-A', 30, 'compressor', { createdAt: iso(-48) })],
      maintenance: [makeMaintenance('ENG-A', iso(-24))],
      now: NOW,
      request: { predictionMaxAgeHours: 24 * 30 },
    });
    expect(plan.exclusions).toContainEqual(expect.objectContaining({ reason: 'prediction_superseded_by_maintenance' }));
  });

  it('captures a traceable baseline and scored reasons for every entry', () => {
    const plan = buildAllocationPlan({
      engines: [makeEngine('ENG-A')],
      assessments: [makeAssessment('ENG-A', 50, 'critical')],
      predictions: [makePrediction('ENG-A', 20, 'bearing')],
      maintenance: [makeMaintenance('ENG-A', iso(-200))],
      now: NOW,
    });
    const entry = plan.entries[0];
    expect(entry.reasons.length).toBeGreaterThanOrEqual(3);
    expect(entry.reasons.join(' ')).toContain('20');
    expect(entry.scoreBreakdown).toMatchObject({ riskWeight: 0.6, urgencyWeight: 0.4 });
    expect(plan.baseline.engines).toContainEqual(expect.objectContaining({ engineId: 'ENG-A', assessmentId: 'ASSESS-ENG-A', predictionId: 'RUL-ENG-A', maintenanceCount: 1 }));
  });

  it('flags the plan stale after re-assessment or a new maintenance event', () => {
    const plan = buildAllocationPlan({
      engines: [makeEngine('ENG-A'), makeEngine('ENG-B')],
      assessments: [makeAssessment('ENG-A', 50), makeAssessment('ENG-B', 70)],
      predictions: [makePrediction('ENG-A', 30), makePrediction('ENG-B', 80)],
      maintenance: [], now: NOW,
    });
    expect(detectPlanStaleness(plan, { assessments: [makeAssessment('ENG-A', 50)], predictions: [makePrediction('ENG-A', 30)], maintenance: [], now: NOW })).toHaveLength(0);

    const causes = detectPlanStaleness(plan, {
      assessments: [makeAssessment('ENG-A', 45, 'critical', { assessmentId: 'ASSESS-ENG-A-V2', createdAt: iso(1) }), makeAssessment('ENG-B', 70)],
      predictions: [makePrediction('ENG-A', 30), makePrediction('ENG-B', 80)],
      maintenance: [makeMaintenance('ENG-B', iso(2))],
      now: NOW,
    });
    expect(causes.map(cause => cause.cause).sort()).toEqual(['assessment_recreated', 'maintenance_recorded']);
    const refreshed = withComputedStatus(plan, {
      assessments: [makeAssessment('ENG-A', 45, 'critical', { assessmentId: 'ASSESS-ENG-A-V2', createdAt: iso(1) }), makeAssessment('ENG-B', 70)],
      predictions: [makePrediction('ENG-A', 30), makePrediction('ENG-B', 80)],
      maintenance: [],
      now: NOW,
    });
    expect(refreshed.status).toBe('stale');
    expect(plan.status).toBe('active'); // 不修改原始对象
  });
});
