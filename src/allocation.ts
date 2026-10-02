import {
  AllocationExclusion,
  AllocationExclusionReason,
  AllocationPlan,
  AllocationRequest,
  Component,
  Engine,
  HealthAssessment,
  MaintenanceEvent,
  MaintenanceSlot,
  RulPrediction,
  SlotCapacityUsage,
  StalenessCause,
} from './types.js';

const DEFAULTS = {
  totalQuota: 3,
  riskWeight: 0.6,
  urgencyWeight: 0.4,
  lifeHorizonCycles: 200,
  assessmentMaxAgeHours: 24 * 7,
  predictionMaxAgeHours: 24 * 7,
};

const STATUS_BONUS: Record<Engine['status'], number> = { healthy: 0, watch: 5, degraded: 15, critical: 30 };

const COMPONENT_LABEL: Record<Component, string> = {
  hot_section: '热端部件',
  compressor: '压气机',
  bearing: '轴承',
  lubrication: '润滑系统',
};

function ageHours(iso: string, now: Date): number | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return (now.getTime() - time) / 3_600_000;
}

function latestMaintenanceAt(events: MaintenanceEvent[]): string | null {
  return events.reduce<string | null>((latest, event) => {
    const at = event.occurredAt;
    return at && (!latest || at.localeCompare(latest) > 0) ? at : latest;
  }, null);
}

function normalizeSlots(requested: MaintenanceSlot[] | undefined, totalQuota: number): MaintenanceSlot[] {
  const totalCapacity = requested?.reduce((sum, slot) => sum + slot.totalCapacity, 0) ?? 0;
  const slots: MaintenanceSlot[] = requested?.length
    ? requested.map(slot => ({ ...slot, componentCapacities: slot.componentCapacities ? { ...slot.componentCapacities } : undefined }))
    : [{ slotId: 'SLOT-DEFAULT', name: '通用检修名额', totalCapacity: totalQuota }];
  return slots.length ? slots : [{ slotId: 'SLOT-DEFAULT', name: '通用检修名额', totalCapacity: totalCapacity || totalQuota }];
}

function exclusion(engineId: string, reason: AllocationExclusionReason, detail: string): AllocationExclusion {
  return { engineId, reason, detail };
}

export type BuildAllocationPlanInput = {
  engines: Engine[];
  assessments: HealthAssessment[];
  predictions: RulPrediction[];
  maintenance: MaintenanceEvent[];
  request?: AllocationRequest;
  now?: Date;
  planId?: string;
};

type Candidate = {
  engine: Engine;
  assessment: HealthAssessment;
  prediction: RulPrediction;
  healthRisk: number;
  riskScore: number;
  lifeUrgency: number;
  priorityScore: number;
};

/**
 * 读取各发动机最新评估、预测与维护历史，按风险、寿命下界、部件匹配和名额约束
 * 生成可追溯的维护排程方案。纯函数，时间可注入，便于测试。
 */
export function buildAllocationPlan(input: BuildAllocationPlanInput): AllocationPlan {
  const now = input.now ?? new Date();
  const request = input.request ?? {};
  const totalQuota = Math.max(1, Math.trunc(request.totalQuota ?? DEFAULTS.totalQuota));
  const riskWeight = clamp01(request.riskWeight ?? DEFAULTS.riskWeight);
  const urgencyWeight = clamp01(request.urgencyWeight ?? DEFAULTS.urgencyWeight);
  const lifeHorizonCycles = Math.max(1, Math.trunc(request.lifeHorizonCycles ?? DEFAULTS.lifeHorizonCycles));
  const assessmentMaxAgeHours = Math.max(1, request.assessmentMaxAgeHours ?? DEFAULTS.assessmentMaxAgeHours);
  const predictionMaxAgeHours = Math.max(1, request.predictionMaxAgeHours ?? DEFAULTS.predictionMaxAgeHours);
  const slots = normalizeSlots(request.slots, totalQuota);
  const planId = input.planId ?? `PLAN-${Date.now()}`;

  const scopedEngines = request.engineIds?.length
    ? request.engineIds.map(id => input.engines.find(engine => engine.id === id)).filter((engine): engine is Engine => Boolean(engine))
    : input.engines;

  const candidates: Candidate[] = [];
  const exclusions: AllocationExclusion[] = [];

  for (const engine of scopedEngines) {
    const assessment = input.assessments.find(item => item.engineId === engine.id);
    if (!assessment) {
      exclusions.push(exclusion(engine.id, 'missing_assessment', `${engine.id} 缺少最新健康评估，无法评估风险`));
      continue;
    }
    const ageOfAssessment = ageHours(assessment.createdAt, now);
    if (ageOfAssessment === null) {
      exclusions.push(exclusion(engine.id, 'assessment_expired', `${engine.id} 评估时间戳无效`));
      continue;
    }
    if (ageOfAssessment > assessmentMaxAgeHours) {
      exclusions.push(exclusion(engine.id, 'assessment_expired', `${engine.id} 健康评估已过期 ${Math.round(ageOfAssessment)} 小时（上限 ${assessmentMaxAgeHours} 小时）`));
      continue;
    }
    const prediction = input.predictions.find(item => item.engineId === engine.id);
    if (!prediction) {
      exclusions.push(exclusion(engine.id, 'missing_prediction', `${engine.id} 缺少 RUL 预测，无法计算寿命下界`));
      continue;
    }
    const ageOfPrediction = ageHours(prediction.createdAt, now);
    if (ageOfPrediction === null) {
      exclusions.push(exclusion(engine.id, 'prediction_expired', `${engine.id} 预测时间戳无效`));
      continue;
    }
    if (ageOfPrediction > predictionMaxAgeHours) {
      exclusions.push(exclusion(engine.id, 'prediction_expired', `${engine.id} RUL 预测已过期 ${Math.round(ageOfPrediction)} 小时（上限 ${predictionMaxAgeHours} 小时）`));
      continue;
    }
    const events = input.maintenance.filter(event => event.engineId === engine.id);
    const latestAt = latestMaintenanceAt(events);
    if (latestAt && latestAt.localeCompare(prediction.createdAt) > 0) {
      exclusions.push(exclusion(engine.id, 'prediction_superseded_by_maintenance', `${engine.id} 在最新预测后于 ${latestAt} 发生维护，预测已失效`));
      continue;
    }

    const healthRisk = clamp(100 - assessment.healthScore + STATUS_BONUS[assessment.status], 0, 130);
    const riskScore = round(healthRisk / 130 * 100);
    const lifeUrgency = round(clamp(100 * (1 - prediction.lowerBound / lifeHorizonCycles), 0, 100));
    const priorityScore = round(riskScore * riskWeight + lifeUrgency * urgencyWeight);
    candidates.push({ engine, assessment, prediction, healthRisk: round(healthRisk), riskScore, lifeUrgency, priorityScore });
  }

  // 并列风险时确定性地按寿命下界、健康评分、发动机编号打破平局，保证可重复
  candidates.sort((a, b) =>
    b.priorityScore - a.priorityScore ||
    a.prediction.lowerBound - b.prediction.lowerBound ||
    a.assessment.healthScore - b.assessment.healthScore ||
    a.engine.id.localeCompare(b.engine.id),
  );

  const capacityUsage: SlotCapacityUsage[] = slots.map(slot => ({
    slotId: slot.slotId,
    slotName: slot.name,
    assigned: 0,
    totalCapacity: slot.totalCapacity,
    componentCapacity: slot.componentCapacities ? { ...slot.componentCapacities } : {},
    componentUsed: { hot_section: 0, compressor: 0, bearing: 0, lubrication: 0 },
  }));
  const usageBySlot = new Map(capacityUsage.map(usage => [usage.slotId, usage]));

  const entries: AllocationPlan['entries'] = [];
  let assignedTotal = 0;
  let rank = 0;
  for (const candidate of candidates) {
    rank += 1;
    if (assignedTotal >= totalQuota) {
      exclusions.push({
        engineId: candidate.engine.id,
        reason: 'quota_exceeded',
        detail: `${candidate.engine.id} 风险排名第 ${rank} 位，但全局检修名额 ${totalQuota} 已用尽`,
        rank,
        priorityScore: candidate.priorityScore,
      });
      continue;
    }
    const target = pickSlot(candidate.prediction.limitingComponent, slots, usageBySlot);
    if (!target) {
      exclusions.push({
        engineId: candidate.engine.id,
        reason: 'unmatched_capacity',
        detail: `${candidate.engine.id} 风险排名第 ${rank} 位，但无匹配 ${COMPONENT_LABEL[candidate.prediction.limitingComponent]} 的剩余部件名额`,
        rank,
        priorityScore: candidate.priorityScore,
      });
      continue;
    }

    const { slot, usage } = target;
    usage.assigned += 1;
    usage.componentUsed[candidate.prediction.limitingComponent] += 1;
    assignedTotal += 1;

    const reasons: string[] = [
      `综合优先级 ${candidate.priorityScore}，风险排序第 ${rank} 位（共 ${candidates.length} 台合格发动机）`,
      `健康评分 ${candidate.assessment.healthScore}（${statusLabel(candidate.assessment.status)}），风险分 ${candidate.riskScore}`,
      `RUL 寿命下界 ${candidate.prediction.lowerBound} 循环，限制部件为 ${COMPONENT_LABEL[candidate.prediction.limitingComponent]}，寿命紧迫度 ${candidate.lifeUrgency}`,
      `匹配检修窗口「${slot.name}」（${slot.slotId}）的 ${COMPONENT_LABEL[candidate.prediction.limitingComponent]} 部件能力`,
    ];
    entries.push({
      engineId: candidate.engine.id,
      rank,
      slotId: slot.slotId,
      slotName: slot.name,
      matchedComponent: candidate.prediction.limitingComponent,
      healthScore: candidate.assessment.healthScore,
      status: candidate.assessment.status,
      riskScore: candidate.riskScore,
      lifeUrgency: candidate.lifeUrgency,
      lowerBound: candidate.prediction.lowerBound,
      estimatedRemainingCycles: candidate.prediction.estimatedRemainingCycles,
      priorityScore: candidate.priorityScore,
      assessmentId: candidate.assessment.assessmentId,
      predictionId: candidate.prediction.predictionId,
      reasons,
      scoreBreakdown: {
        healthRisk: candidate.healthRisk,
        statusBonus: STATUS_BONUS[candidate.assessment.status],
        riskWeight,
        urgencyWeight,
        lifeHorizonCycles,
      },
    });
  }

  return {
    planId,
    planName: request.planName ?? `维护资源分配-${now.toISOString().slice(0, 10)}`,
    clientRequestId: request.clientRequestId,
    createdAt: now.toISOString(),
    parameters: {
      totalQuota,
      riskWeight,
      urgencyWeight,
      lifeHorizonCycles,
      assessmentMaxAgeHours,
      predictionMaxAgeHours,
      engineIds: request.engineIds?.length ? [...request.engineIds] : null,
      slots,
    },
    entries,
    exclusions,
    capacityUsage,
    baseline: {
      capturedAt: now.toISOString(),
      engines: scopedEngines.map(engine => {
        const events = input.maintenance.filter(event => event.engineId === engine.id);
        return {
          engineId: engine.id,
          assessmentId: input.assessments.find(item => item.engineId === engine.id)?.assessmentId ?? null,
          predictionId: input.predictions.find(item => item.engineId === engine.id)?.predictionId ?? null,
          maintenanceCount: events.length,
          latestMaintenanceAt: latestMaintenanceAt(events),
        };
      }),
    },
    status: 'active',
    stalenessCauses: [],
  };
}

function pickSlot(
  component: Component,
  slots: MaintenanceSlot[],
  usageBySlot: Map<string, SlotCapacityUsage>,
): { slot: MaintenanceSlot; usage: SlotCapacityUsage } | null {
  // 第一轮：匹配声明了该部件能力的窗口（部件专属名额优先）
  for (const slot of slots) {
    const usage = usageBySlot.get(slot.slotId);
    if (!usage || usage.assigned >= slot.totalCapacity) continue;
    const componentCap = slot.componentCapacities?.[component];
    if (componentCap !== undefined && usage.componentUsed[component] < componentCap) return { slot, usage };
  }
  // 第二轮：匹配完全通用、未声明部件能力的窗口
  for (const slot of slots) {
    const usage = usageBySlot.get(slot.slotId);
    if (!usage || usage.assigned >= slot.totalCapacity) continue;
    if (slot.componentCapacities === undefined) return { slot, usage };
  }
  return null;
}

/**
 * 读取时检测方案是否过期：发动机被重新评估、重新预测，或发生了新的维护事件。
 * 不修改持久化数据，状态每次基于最新输入动态计算。
 */
export function detectPlanStaleness(
  plan: AllocationPlan,
  data: { assessments: HealthAssessment[]; predictions: RulPrediction[]; maintenance: MaintenanceEvent[]; now?: Date },
): StalenessCause[] {
  const causes: StalenessCause[] = [];
  const now = data.now ?? new Date();
  for (const baseline of plan.baseline.engines) {
    const latestAssessment = data.assessments.find(item => item.engineId === baseline.engineId);
    if (latestAssessment && baseline.assessmentId && latestAssessment.assessmentId !== baseline.assessmentId) {
      causes.push({
        engineId: baseline.engineId,
        cause: 'assessment_recreated',
        at: latestAssessment.createdAt,
        baseline: baseline.assessmentId,
        detail: `${baseline.engineId} 已重新评估（${baseline.assessmentId} → ${latestAssessment.assessmentId}），方案依据过期`,
      });
    }
    const latestPrediction = data.predictions.find(item => item.engineId === baseline.engineId);
    if (latestPrediction && baseline.predictionId && latestPrediction.predictionId !== baseline.predictionId) {
      causes.push({
        engineId: baseline.engineId,
        cause: 'prediction_recreated',
        at: latestPrediction.createdAt,
        baseline: baseline.predictionId,
        detail: `${baseline.engineId} 已重新预测（${baseline.predictionId} → ${latestPrediction.predictionId}），寿命下界依据过期`,
      });
    }
    const events = data.maintenance.filter(event => event.engineId === baseline.engineId);
    const latestAt = latestMaintenanceAt(events);
    if (latestAt && (!baseline.latestMaintenanceAt || latestAt.localeCompare(baseline.latestMaintenanceAt) > 0) && latestAt.localeCompare(plan.createdAt) > 0) {
      causes.push({
        engineId: baseline.engineId,
        cause: 'maintenance_recorded',
        at: latestAt,
        baseline: baseline.latestMaintenanceAt ?? 'none',
        detail: `${baseline.engineId} 在方案生成后于 ${latestAt} 发生维护事件，排程结果需复核`,
      });
    }
  }
  for (const entry of plan.entries) {
    const latestAssessment = data.assessments.find(item => item.engineId === entry.engineId);
    if (latestAssessment && ageHours(latestAssessment.createdAt, now) !== null && (ageHours(latestAssessment.createdAt, now) as number) > plan.parameters.assessmentMaxAgeHours) {
      if (!causes.some(cause => cause.engineId === entry.engineId)) {
        causes.push({
          engineId: entry.engineId,
          cause: 'assessment_recreated',
          at: latestAssessment.createdAt,
          baseline: entry.assessmentId,
          detail: `${entry.engineId} 入选所依据的评估数据现已超过 ${plan.parameters.assessmentMaxAgeHours} 小时有效期`,
        });
      }
    }
  }
  return causes;
}

export function withComputedStatus(
  plan: AllocationPlan,
  data: { assessments: HealthAssessment[]; predictions: RulPrediction[]; maintenance: MaintenanceEvent[]; now?: Date },
): AllocationPlan {
  const stalenessCauses = detectPlanStaleness(plan, data);
  return { ...plan, status: stalenessCauses.length ? 'stale' : 'active', stalenessCauses };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(Number(value) || 0, 0, 1);
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function statusLabel(status: Engine['status']): string {
  return { healthy: '健康', watch: '关注', degraded: '降级', critical: '危急' }[status];
}
