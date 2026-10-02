import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { demoEngine, demoMaintenance, demoModels, createDemoTelemetry } from './demo-data.js';
import { AllocationPlan, Engine, HealthAssessment, MaintenanceEvent, ModelVersion, RulPrediction, TelemetrySample } from './types.js';

type State = { engines: Engine[]; telemetry: TelemetrySample[]; maintenance: MaintenanceEvent[]; models: ModelVersion[]; assessments: HealthAssessment[]; predictions: RulPrediction[]; audit: Array<Record<string, unknown>>; allocationPlans: AllocationPlan[] };

function freshState(): State {
  return { engines: [demoEngine], telemetry: createDemoTelemetry(), maintenance: demoMaintenance, models: demoModels, assessments: [], predictions: [], audit: [], allocationPlans: [] };
}

export class LocalStore {
  private state: State = freshState();
  private writeChain: Promise<void> = Promise.resolve();
  constructor(private readonly file = resolve(process.cwd(), 'data/state.json')) {}
  async init(): Promise<void> {
    try {
      const loaded = JSON.parse(await readFile(this.file, 'utf8')) as Partial<State>;
      // 旧版本 state.json 不含 allocationPlans，做兼容迁移
      this.state = { ...freshState(), ...loaded, allocationPlans: Array.isArray(loaded.allocationPlans) ? loaded.allocationPlans : [] };
    } catch {
      await this.persist();
    }
  }
  async persist(): Promise<void> {
    // 串行化 + 临时文件原子替换：重启或并发提交不会写坏 state.json
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.then(() => this.writeAtomically(snapshot));
    await this.writeChain;
  }
  private async writeAtomically(payload: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${writeSeq++}`;
    await writeFile(tmp, payload);
    await rename(tmp, this.file);
  }
  get engines() { return this.state.engines; }
  get telemetry() { return this.state.telemetry; }
  get maintenance() { return this.state.maintenance; }
  get models() { return this.state.models; }
  get assessments() { return this.state.assessments; }
  get predictions() { return this.state.predictions; }
  get audit() { return this.state.audit; }
  get allocationPlans() { return this.state.allocationPlans; }
  addTelemetry(rows: TelemetrySample[]) { this.state.telemetry.push(...rows); }
  addEngine(engine: Engine) { this.state.engines.push(engine); }
  addMaintenance(event: MaintenanceEvent) { this.state.maintenance.push(event); }
  addAssessment(value: HealthAssessment) { this.state.assessments.unshift(value); }
  addPrediction(value: RulPrediction) { this.state.predictions.unshift(value); }
  addPlan(value: AllocationPlan) { this.state.allocationPlans.unshift(value); }
  findPlanById(planId: string) { return this.state.allocationPlans.find(plan => plan.planId === planId); }
  findPlanByRequestId(clientRequestId: string) { return this.state.allocationPlans.find(plan => plan.clientRequestId === clientRequestId); }
  log(action: string, engineId: string, detail: Record<string, unknown>) { this.state.audit.unshift({ id: `AUD-${this.state.audit.length + 1}`, action, engineId, at: new Date().toISOString(), detail }); }
}

let writeSeq = 0;
