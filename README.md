# 航空发动机健康状态评估与剩余寿命预测服务

这是一个可直接在主机运行的纯后端 Node.js + TypeScript 项目，不依赖 Docker、数据库、Redis、Kafka 或云服务。业务状态默认写入本地 `data/state.json`，演示数据由代码生成，适合离线测试和后续接入真实传感器数据。

## 已实现业务

- 发动机档案与型号配置
- 飞行架次和多传感器时序导入
- 时间戳、单位、范围和单调性校验
- 缺失值线性插值与异常点剔除
- 飞行阶段工况归一化
- 排气温度裕度、燃油效率、振动风险、滑油压力裕度计算
- 传感器漂移和突变检测
- 发动机健康评分与状态分级
- 部件级风险排序
- 基于退化趋势的剩余寿命估算
- 预测置信区间与解释性证据
- 维修事件回灌和风险修正
- 传感器数据按时间顺序重放
- 维护窗口推演
- 模型版本比较
- 告警事件、审计轨迹和本地结果导出
- 维护资源分配：多发动机风险排序、寿命下界、部件能力匹配与名额约束排程
- 排程方案可追溯（评分拆解、部件匹配、名额使用、基线快照）并持久化、可查询
- 重新评估/重新预测/新维护事件后自动识别方案过期；重复提交幂等

## 运行

```bash
npm install
npm run build
npm test
npm run demo
npm run allocation-demo
npm start
```

服务默认监听 `http://127.0.0.1:6195`。

## 主要 API

```text
GET  /api/health
GET  /api/models
POST /api/engines/import
GET  /api/engines/:id
GET  /api/engines/:id/telemetry
POST /api/engines/:id/health-assessment
POST /api/engines/:id/rul-prediction
POST /api/engines/:id/replay
GET  /api/replay/jobs/:id
POST /api/engines/:id/maintenance-simulation
POST /api/models/compare
GET  /api/engines/:id/risk-events
GET  /api/audit/:engineId
POST /api/maintenance-events
POST /api/maintenance-allocation/plans
GET  /api/maintenance-allocation/plans
GET  /api/maintenance-allocation/plans/:planId
```

## 维护资源分配

`POST /api/maintenance-allocation/plans` 读取各发动机最新健康评估、RUL 预测和维护历史，
生成可追溯的检修名额排程方案。核心规则：

- 合格发动机按「风险分 × riskWeight + 寿命下界紧迫度 × urgencyWeight」排序；
  并列时按寿命下界、健康评分、发动机编号确定性打破平局。
- 部件名额窗口可声明 `componentCapacities`，优先匹配预测的限制部件；
  通用窗口只受 `totalCapacity` 约束；全局还受 `totalQuota` 约束。
- 缺少评估（`missing_assessment`）、缺少预测（`missing_prediction`）、
  评估/预测过期（`*_expired`）、预测后发生维护（`prediction_superseded_by_maintenance`）、
  名额不足（`quota_exceeded`/`unmatched_capacity`）均列入 `exclusions` 并给出原因。
- 方案保存评估/预测 ID 和维护事件基线；发动机重新评估、重新预测或记录新维护后，
  再次查询会把方案标记为 `stale` 并返回 `stalenessCauses`。
- 携带相同 `clientRequestId` 的重复提交直接返回原方案（幂等）；
  状态写入采用临时文件原子替换，重启不丢失、不损坏。

```bash
curl -X POST http://127.0.0.1:6195/api/maintenance-allocation/plans \
  -H 'content-type: application/json' \
  -d '{
    "planName": "10月维护协调会排程",
    "totalQuota": 3,
    "lifeHorizonCycles": 120,
    "slots": [
      { "slotId": "SLOT-BEARING", "name": "轴承专项名额", "totalCapacity": 1, "componentCapacities": { "bearing": 1 } },
      { "slotId": "SLOT-GENERAL", "name": "通用名额", "totalCapacity": 2 }
    ],
    "clientRequestId": "meeting-2026-10-02-001"
  }'
curl http://127.0.0.1:6195/api/maintenance-allocation/plans/PLAN-0001
```

## 示例

```bash
curl http://127.0.0.1:6195/api/health
curl http://127.0.0.1:6195/api/engines/ENG-DEMO-001/health-assessment
curl -X POST http://127.0.0.1:6195/api/engines/ENG-DEMO-001/rul-prediction \
  -H 'content-type: application/json' \
  -d '{"horizonCycles":120}'
```
