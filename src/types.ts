export type FlightPhase = 'taxi' | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'landing';
export type EngineStatus = 'healthy' | 'watch' | 'degraded' | 'critical';
export type Component = 'hot_section' | 'compressor' | 'bearing' | 'lubrication';

export type TelemetrySample = {
  engineId: string;
  flightId: string;
  timestamp: string;
  cycle: number;
  phase: FlightPhase;
  rpm: number;
  exhaustGasTemp: number;
  fuelFlow: number;
  vibration: number;
  oilPressure: number;
  oilTemperature: number;
  ambientTemperature: number;
  altitude: number;
  thrust: number;
};

export type MaintenanceEvent = {
  id: string;
  engineId: string;
  component: Component;
  occurredAt: string;
  action: 'inspection' | 'replacement' | 'repair' | 'calibration';
  severity: 'routine' | 'important' | 'mandatory';
  note: string;
};

export type Engine = {
  id: string;
  serialNumber: string;
  model: string;
  aircraftId: string;
  installedAt: string;
  totalCycles: number;
  status: EngineStatus;
  currentHealthScore: number;
  lastAssessmentAt?: string;
};

export type Anomaly = {
  id: string;
  engineId: string;
  timestamp: string;
  type: 'range_violation' | 'sensor_spike' | 'sensor_drift' | 'missing_interval' | 'phase_mismatch' | 'degradation';
  severity: 'low' | 'medium' | 'high';
  sensor?: string;
  message: string;
  evidence: Record<string, number | string>;
};

export type ComponentRisk = {
  component: Component;
  score: number;
  status: EngineStatus;
  drivers: string[];
  estimatedCyclesToLimit: number;
};

export type HealthAssessment = {
  assessmentId: string;
  engineId: string;
  modelVersion: string;
  createdAt: string;
  sampleCount: number;
  healthScore: number;
  status: EngineStatus;
  dataQuality: { score: number; usableSamples: number; rejectedSamples: number; missingIntervals: number };
  indicators: {
    exhaustTemperatureMargin: number;
    fuelEfficiencyIndex: number;
    vibrationRisk: number;
    oilPressureMargin: number;
    degradationSlope: number;
  };
  componentRisks: ComponentRisk[];
  anomalies: Anomaly[];
  explanation: string[];
};

export type RulPrediction = {
  predictionId: string;
  engineId: string;
  modelVersion: string;
  createdAt: string;
  horizonCycles: number;
  estimatedRemainingCycles: number;
  confidence: number;
  lowerBound: number;
  upperBound: number;
  limitingComponent: Component;
  riskByHorizon: Array<{ cycle: number; healthScore: number; probabilityOfMaintenance: number }>;
  evidence: string[];
};

export type ReplayJob = {
  id: string;
  engineId: string;
  cursor: number;
  status: 'ready' | 'running' | 'paused' | 'completed';
  speed: number;
  eventCount: number;
  latest?: TelemetrySample;
};

export type ModelVersion = {
  id: string;
  label: string;
  weights: { temperature: number; fuel: number; vibration: number; oil: number; degradation: number };
  calibratedAt: string;
};

export type MaintenanceSlot = {
  slotId: string;
  name: string;
  totalCapacity: number;
  componentCapacities?: Partial<Record<Component, number>>;
  scheduledDate?: string;
};

export type AllocationRequest = {
  planName?: string;
  totalQuota?: number;
  riskWeight?: number;
  urgencyWeight?: number;
  lifeHorizonCycles?: number;
  assessmentMaxAgeHours?: number;
  predictionMaxAgeHours?: number;
  slots?: MaintenanceSlot[];
  engineIds?: string[];
  clientRequestId?: string;
};

export type AllocationEntry = {
  engineId: string;
  rank: number;
  slotId: string;
  slotName: string;
  matchedComponent: Component;
  healthScore: number;
  status: EngineStatus;
  riskScore: number;
  lifeUrgency: number;
  lowerBound: number;
  estimatedRemainingCycles: number;
  priorityScore: number;
  assessmentId: string;
  predictionId: string;
  reasons: string[];
  scoreBreakdown: { healthRisk: number; statusBonus: number; riskWeight: number; urgencyWeight: number; lifeHorizonCycles: number };
};

export type AllocationExclusionReason =
  | 'missing_assessment'
  | 'missing_prediction'
  | 'assessment_expired'
  | 'prediction_expired'
  | 'prediction_superseded_by_maintenance'
  | 'quota_exceeded'
  | 'unmatched_capacity';

export type AllocationExclusion = {
  engineId: string;
  reason: AllocationExclusionReason;
  detail: string;
  rank?: number;
  priorityScore?: number;
};

export type StalenessCause = {
  engineId: string;
  cause: 'assessment_recreated' | 'prediction_recreated' | 'maintenance_recorded';
  at: string;
  baseline: string;
  detail: string;
};

export type SlotCapacityUsage = {
  slotId: string;
  slotName: string;
  assigned: number;
  totalCapacity: number;
  componentCapacity: Partial<Record<Component, number>>;
  componentUsed: Record<Component, number>;
};

export type AllocationPlan = {
  planId: string;
  planName: string;
  clientRequestId?: string;
  createdAt: string;
  parameters: {
    totalQuota: number;
    riskWeight: number;
    urgencyWeight: number;
    lifeHorizonCycles: number;
    assessmentMaxAgeHours: number;
    predictionMaxAgeHours: number;
    engineIds: string[] | null;
    slots: MaintenanceSlot[];
  };
  entries: AllocationEntry[];
  exclusions: AllocationExclusion[];
  capacityUsage: SlotCapacityUsage[];
  baseline: {
    capturedAt: string;
    engines: Array<{ engineId: string; assessmentId: string | null; predictionId: string | null; maintenanceCount: number; latestMaintenanceAt: string | null }>;
  };
  status: 'active' | 'stale';
  stalenessCauses: StalenessCause[];
};
