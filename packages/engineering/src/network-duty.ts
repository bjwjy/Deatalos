import { serviceMode, serviceStudies, type ServiceInput } from './network-duty-calibrated.js';
import type { TransientInput } from './network-duty-transient.js';
import { loadStudies, type LoadStudy } from './network-duty-overrunning.js';
import { sourceControlMode, sourceControlConditions } from './network-duty-source-control.js';
import {
  checkJson,
  checkNetworkParameterRules,
  componentDisplayName,
  ContractReader,
  diagnostic,
  immutable,
  isLinearActuatorType,
  isNetworkActuatorType,
  networkDisplacementRange,
  networkDisplacementValue,
  networkValvePositions,
  parseNetworkProject,
  type NetworkComponent,
  type NetworkProject,
  type Result,
  type ValvePositionId,
} from '@hyd/domain';
import {
  calculationSubstitution,
  type CalculationInput,
  type CalculationRecord,
  type CalculationStep,
} from './network-learning.js';
import type { SizingChange } from './network-sizing.js';
import { dutyMainTank, networkDutyAutomaticDefaults, type DutyAutomaticNumber } from './network-duty-defaults.js';
import { solvePilotReturn } from './network-duty-pilot-return.js';
import {
  dutyAccessoryConditions,
  dutyAccessoryTypes,
  dutyPhasePaths,
  dutyPressureMeasurementSteps,
  estimateDutyAccessories,
} from './network-duty-accessories.js';
import {
  bufferedDutyConditions,
  dutyBufferedCylinderTypes,
  dutyCylinderAreas,
  dutyCylinderTravel,
  springDutyConditions,
} from './network-duty-cylinders.js';
import {
  controlValveDutyConditions,
  controlValveModelConditions,
  dutyControlValveTypes,
  estimateSeriesControlValves,
  hasControlDrain,
} from './network-duty-control-valves.js';
import { pressurizedControlDrainCondition, resolveControlDrain } from './network-duty-control-return.js';
import {
  dutyMultiPortValveTypes,
  estimateDutyMultiPortValve,
  multiPortValveCommonConditions,
  multiPortValveConditions,
  pilotCheckFilterCondition,
  pilotCheckOutletPipeCondition,
  threeWayDutyFlowMatches,
} from './network-duty-multi-port-valves.js';
import {
  multiReturnAccessoryConditions,
  returnThrottleConditions,
  parallelFlowConditions,
  sharedReturnFlowConditions,
  parallelFlowTargets,
  solveParallelCylinderFlow,
  type ParallelFlowResult,
} from './network-duty-flow-split.js';
import { isReturnTreeAccessory, type DutyFilterBypassSetting } from './network-duty-return-pipes.js';
import { hasPhysicalSupplyPath, supplyPipeFlowConditions } from './network-duty-supply-pipes.js';
import {
  hasWorkingPipe,
  solveWorkingLines,
  springAccessoryConditions,
  springAccessoryPoint,
  workingLineConditions,
} from './network-duty-working-lines.js';
import { pilotReliefSplitConditions } from './network-duty-pilot-relief.js';
import { dutyLogicValveTypes, estimateDutyLogicValve, logicValveDutyConditions } from './network-duty-logic-valves.js';
import { dividerDutyConditions, dutyDividerTypes, solveDutyDivider } from './network-duty-divider.js';
import { dutyProtectionTypes, estimateDutyProtection, protectionDutyConditions } from './network-duty-protection.js';
import { boundaryDutyConditions, checkBoundaryDuty } from './network-duty-supply-storage.js';
import {
  pumpPressureDutyConditions,
  solveDutyPumpPressure,
  type DutyPumpPressureControl,
  type DutyPumpPressurePoint,
} from './network-duty-pump-pressure.js';
import {
  displacementDutyConditions,
  dutyExternalMotorBoundary,
  dutyMotorPoint,
  dutyRotaryPoint,
  rotaryDutyConditions,
  type DutyMotorSetting,
} from './network-duty-displacement.js';

export interface DutyAction {
  readonly componentId: string;
  readonly direction: 'forward' | 'reverse';
  /** m/s for cylinders; rad/s for motors. Magnitude, resisting load only. */
  readonly speed: number;
  readonly resistingLoad: number;
  readonly supplyLossPa: number;
  readonly returnPressurePa: number;
  readonly mechanicalEfficiency: number;
  readonly volumetricEfficiency: number;
  readonly positionM?: number;
  readonly rotaryAngleRad?: number;
  readonly motorSetting?: DutyMotorSetting;
}
export interface DutyPhase {
  readonly name: string;
  readonly valves: readonly { readonly componentId: string; readonly positionId: ValvePositionId }[];
  readonly actions: readonly DutyAction[];
  readonly flowSplit?: true;
  readonly filterBypass?: DutyFilterBypassSetting;
  readonly dividerEnd?: { readonly componentId: string; readonly pressurePa: number };
  readonly pumpCommandPercent?: number;
  readonly loadSenseMarginPa?: number;
  readonly switchPrevious?: 'on' | 'off';
  readonly pumpPressureControl?: DutyPumpPressureControl;
  readonly loadStudy?: LoadStudy;
  readonly minimumInletPa?: number;
  readonly service?: ServiceInput;
  readonly transient?: TransientInput;
  readonly drainLeakM3PerS?: number;
  readonly pumpStorage?: true;
  readonly resetStudy?: { readonly sweptM3?: number; readonly flowM3PerS?: number; readonly backPa?: number };
  readonly cycleThermal?: {
    readonly capacity?: number;
    readonly conductance?: number;
    readonly ambient?: number;
    readonly initial?: number;
    readonly cycles?: number;
  };
  readonly accumulatorOilVolumeM3?: number;
  readonly accumulatorTargetOilVolumeM3?: number;
  readonly shutoffs?: readonly (
    | { readonly componentId: string; readonly state: 'open' | 'closed' }
    | { readonly componentId: string; readonly state: 'partial'; readonly openingAreaM2: number }
  )[];
}
export interface NetworkDutyRequest {
  readonly pumpId: string;
  readonly boundary?: true;
  readonly angularSpeedRadPerS: number;
  readonly pumpVolumetricEfficiency: number;
  readonly totalEfficiency: number;
  readonly pressureLimitPa: number;
  /** Each phase is simultaneous; successive phases never have their flows added. */
  readonly phases: readonly DutyPhase[];
  /** Exact request field paths that were filled by the declared teaching policy. */
  readonly automaticFields?: readonly string[];
}
export interface DutySupplyDemand {
  readonly name: string;
  readonly pressurePa: number;
  readonly flowM3PerS: number;
  readonly shaftPowerW: number;
  readonly supplyBalanceIssue?: string;
  readonly availableFlowM3PerS?: number;
  readonly pumpPressurePoint?: DutyPumpPressurePoint;
  readonly flowSplit?: ParallelFlowResult;
  readonly springReturn?: never;
  readonly boundaryAssessment?: never;
}
export interface DutyBoundaryDemand {
  readonly name: string;
  readonly boundaryAssessment: {
    readonly summary: string;
    readonly satisfied: boolean;
    readonly controlPending?: true;
    readonly loadPending?: true;
    readonly transientStudy?: true;
    readonly study?: 'reset' | 'cycle';
    readonly transfer?: 'timed' | 'blocked' | 'pending';
  };
  readonly flowSplit?: never;
  readonly springReturn?: never;
}
export type DutyDemand =
  | DutySupplyDemand
  | DutyBoundaryDemand
  | {
      readonly name: string;
      readonly flowSplit?: never;
      readonly boundaryAssessment?: never;
      readonly springReturn: {
        readonly flowM3PerS: number;
        readonly backPressurePa: number;
        readonly forceMarginN: number;
        readonly actual?: {
          readonly flowM3PerS: number;
          readonly speedMPerS: number;
          readonly targetSpeedMPerS: number;
          readonly backPressurePa: number;
        };
      };
    };
export const isDutySupplyDemand = (demand: DutyDemand): demand is DutySupplyDemand =>
  demand.springReturn === undefined && demand.boundaryAssessment === undefined;
export interface NetworkDutyPlan {
  readonly request: NetworkDutyRequest;
  readonly phases: readonly DutyDemand[];
  readonly requiredDisplacementM3PerRev: number;
  readonly availableFlowM3PerS: number;
  readonly changes: readonly SizingChange[];
  readonly document: NetworkProject;
  readonly record: CalculationRecord;
  readonly constraints: readonly DutyConstraint[];
  readonly reliefLimits: readonly DutyReliefLimit[];
}
export interface DutyReliefLimit {
  readonly phase: string;
  readonly phaseIndex: number;
  readonly componentId: string;
  readonly kind: 'internal' | 'external';
  readonly returnPressurePa: number;
  readonly differentialPa: number;
}
export interface DutyConstraint {
  readonly kind: 'pressure-budget' | 'relief-limit';
  readonly phase: string;
  readonly componentId: string;
  readonly requiredPa: number;
  readonly limitPa: number;
}
export interface DutyPendingPhase {
  readonly name: string;
  readonly kind: 'incomplete' | 'excluded';
  readonly reason: string;
}
export interface NetworkDutyReportRequest {
  readonly duty: NetworkDutyRequest | null;
  readonly pendingPhases: readonly DutyPendingPhase[];
}
export type DutyPhaseCoverage =
  | DutyPendingPhase
  | {
      readonly name: string;
      readonly kind: 'blocked';
      readonly reason: string;
    }
  | {
      readonly name: string;
      readonly kind: 'unsupported';
      readonly reason: string;
      readonly flowSplit?: ParallelFlowResult;
    }
  | {
      readonly name: string;
      readonly kind: 'calculated';
      readonly demand: DutyDemand;
      readonly limits?: readonly string[];
    };
export interface DutyComponentLimit {
  readonly componentId: string;
  readonly label: string;
  readonly typeId: string;
  readonly reason: string;
}
export interface NetworkDutyCoverage {
  readonly hasServiceStudy?: true;
  readonly transientScope?: 'only' | 'mixed';
  readonly phases: readonly DutyPhaseCoverage[];
  readonly componentLimits: readonly DutyComponentLimit[];
  readonly complete: boolean;
}
const steadyTypes = new Set([
  'pump',
  'tank',
  'valve',
  'cylinder',
  'motor',
  'limited-rotary-actuator',
  'relief',
  'throttle',
  'one-way-throttle',
  'check-valve',
  'volume',
  'dynamic-controller',
  ...dutyAccessoryTypes,
  ...dutyBufferedCylinderTypes,
  ...dutyControlValveTypes,
  ...dutyMultiPortValveTypes,
  ...dutyLogicValveTypes,
  ...dutyDividerTypes,
  ...dutyProtectionTypes,
  'single-acting-cylinder',
]);
const componentReasons: Readonly<Record<string, string>> = {
  'limited-rotary-actuator': 'A、B 须完整接线，并给定有限转角内的核算位置。',
  'shuttle-valve': 'A、B、C 须完整接线，才能确定入口压差、梭阀选通与反向隔离。',
  'two-pressure-valve': 'A、B、C 须完整接线，才能判断两路同时供压和 C 口通路。',
  'pilot-check-close': 'A、B、X 须完整接线，才能判定关闭先导压差与主通路。',
  'flow-divider-combiner': 'P、A、B 须完整接线，才能按分流、集流比例及两缸负载核算。',
  'synchronizing-flow-divider': 'P、A、B 须完整接线，末端纠偏还需指定到位缸及其无杆腔压力。',
  'shock-makeup-valve': 'A/B/T 须完整接线，才能联立两向冲击溢流、补油开启与油量平衡。',
  'pressure-intensifier': 'IN 口供油、H 口驱动负载、R 口回油时，尚未核算增压与回程阶段的出口流量、压力及补油。',
  'pilot-unloading-valve':
    '此拓扑的卸荷核算待支持。高低压双泵当前设计入口要求大泵止回阀前卸荷，并从公共母线取先导压力。',
  'pressure-source': '供压边界由压力源决定，当前核算采用单泵供流和统一回油基准。',
  accumulator: '工况法未求解预充气体、储能状态及随时间变化的充放油。',
  counterbalance: 'A/B/X 须完整接线，才能联立负载压力、先导比与回油压力。',
};
function dutyComponentReason(
  document: NetworkProject,
  component: NetworkComponent,
  request: NetworkDutyRequest | null,
  boundary: ReturnType<typeof dutyExternalMotorBoundary>,
): string | undefined {
  if (boundary?.ids.has(component.id)) return undefined;
  if (
    dutyLogicValveTypes.has(component.typeId) ||
    dutyDividerTypes.has(component.typeId) ||
    dutyProtectionTypes.has(component.typeId) ||
    component.typeId === 'limited-rotary-actuator'
  ) {
    const ports = new Set(
      document.design.connections
        .filter((edge) => edge.kind !== 'signal')
        .flatMap((edge) => [edge.from, edge.to])
        .flatMap((endpoint) =>
          endpoint.kind === 'port' && endpoint.componentId === component.id ? [endpoint.portId] : [],
        ),
    );
    if (component.typeId === 'limited-rotary-actuator')
      return ports.has('A') && ports.has('B') ? undefined : componentReasons[component.typeId];
    const thirdPort = dutyDividerTypes.has(component.typeId)
      ? 'P'
      : component.typeId === 'pilot-check-close' || component.typeId === 'counterbalance'
        ? 'X'
        : component.typeId === 'shock-makeup-valve'
          ? 'T'
          : 'C';
    if (['A', 'B', thirdPort].some((port) => !ports.has(port))) return componentReasons[component.typeId];
  }
  if (component.typeId === 'motor') {
    if (component.externalMotorControl?.kind === 'pressure' && boundary?.motor.id !== component.id)
      return 'X 口接先导压力时，需联立取压点和实际排量，当前工况不能用保存排量替代。';
    if (component.externalMotorControl?.kind === 'voltage' && boundary?.motor.id !== component.id)
      return 'U 口接电压控制时，需知道实际电压及其对应排量，当前工况不能用保存排量替代。';
    if (
      component.motorDisplacementCurve?.enabled &&
      !request?.phases.some((phase) =>
        phase.actions.some(
          (action) => action.componentId === component.id && action.motorSetting?.kind === 'differential',
        ),
      )
    )
      return '启用压力差—排量曲线时，需联立 A/B 压力差与实际排量，当前工况不能用保存排量替代。';
  }
  if (component.typeId === 'adjustable-pressure-switch') {
    const connections = document.design.connections.filter((edge) =>
      [edge.from, edge.to].some((end) => end.kind === 'port' && end.componentId === component.id),
    );
    if (connections.some((edge) => edge.kind === 'signal'))
      return 'OUT 口接入信号回路时，需核算反馈改变的控制状态。稳态核算仅支持 H 口旁接取压且 OUT 未接线。';
    if (connections.length > 1) return 'H 口应通过单条连接旁接取压。直接把多条油路汇在 H 口时，不能把它视为独立测点。';
  }
  return steadyTypes.has(component.typeId)
    ? undefined
    : (componentReasons[component.typeId] ?? '当前稳态工况法未登记该元件的通路与需求模型。');
}
function dutyComponentLimits(document: NetworkProject, request: NetworkDutyRequest | null): DutyComponentLimit[] {
  const boundary = dutyExternalMotorBoundary(document, request);
  return document.design.components.flatMap((component) => {
    if (
      request?.phases.every((p) => p.pumpStorage) &&
      ['accumulator', 'adjustable-pressure-switch', 'pilot-unloading-valve'].includes(component.typeId)
    )
      return [];
    if (component.typeId === 'pressure-source' && request && sourceControlMode(document, request)) return [];
    if (request?.boundary && ['pressure-source', 'accumulator', 'pressure-intensifier'].includes(component.typeId))
      return [];
    const reason = dutyComponentReason(document, component, request, boundary);
    if (!reason) return [];
    const type = componentDisplayName(component.typeId, component.definition.id);
    return [
      {
        componentId: component.id,
        label: component.label.trim() && component.label !== type ? component.label + ' · ' + type : type,
        typeId: component.typeId,
        reason,
      },
    ];
  });
}
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty', message)],
});
function readDutyPhases(r: ContractReader, input: unknown, boundary = false): readonly DutyPhase[] {
  const number = (v: unknown, p: string, min = Number.MIN_VALUE, max = Number.MAX_VALUE) => r.number(v, p, min, max);
  const phases = r.array(input, '/duty/phases', 24).map((item, i): DutyPhase => {
    const p = '/duty/phases/' + i;
    const phase = r.object(item, p, [
      'name',
      'valves',
      'actions',
      'shutoffs',
      'flowSplit',
      'filterBypass',
      'dividerEnd',
      'pumpCommandPercent',
      'pumpPressureControl',
      'loadSenseMarginPa',
      'switchPrevious',
      'loadStudy',
      'minimumInletPa',
      'pumpStorage',
      'drainLeakM3PerS',
      'transient',
      'service',
      'resetStudy',
      'cycleThermal',
      'accumulatorOilVolumeM3',
      'accumulatorTargetOilVolumeM3',
    ]);
    const loadStudy = Object.keys(loadStudies).find((key): key is LoadStudy => key === phase.loadStudy);
    if (phase.loadStudy !== undefined && !loadStudy) r.fail('DUTY_INVALID', p + '/loadStudy', '未知功率方向专项。');
    if (phase.minimumInletPa !== undefined && loadStudy !== 'suction')
      r.fail('DUTY_INVALID', p + '/minimumInletPa', '最低入口绝压仅用于吸油管。');
    if (phase.pumpStorage !== undefined && phase.pumpStorage !== true)
      r.fail('DUTY_INVALID', p, '定量泵储能标记须为 true。');
    const inputs = (key: string, limits: Record<string, [number, number]>) => {
      if (phase[key] === undefined) return undefined;
      const raw = r.object(phase[key], p + '/' + key, Object.keys(limits));
      return Object.fromEntries(
        Object.entries(limits)
          .filter(([k]) => raw[k] !== undefined)
          .map(([k, [min, max]]) => [k, number(raw[k], p + '/' + key + '/' + k, min, max)]),
      );
    };
    let service: ServiceInput | undefined;
    if (phase.service !== undefined) {
      const v = r.object(phase.service, p + '/service', ['mode', 'target', 'values']);
      if (!serviceMode(v.mode)) r.fail('DUTY_INVALID', p + '/service/mode', '未知标定试验。');
      else {
        const fields = serviceStudies[v.mode].fields,
          values = r.object(
            v.values,
            p + '/service/values',
            fields.map((f) => f.key),
          );
        service = {
          mode: v.mode,
          target: r.text(v.target, p + '/service/target', 1, 160),
          values: Object.fromEntries(
            fields
              .filter((f) => values[f.key] !== undefined)
              .map((f) => [
                f.key,
                number(values[f.key], p + '/service/values/' + f.key, f.min * f.scale, f.max * f.scale),
              ]),
          ),
        };
        if (
          Object.keys(phase).some((k) => !['name', 'valves', 'actions', 'service'].includes(k)) ||
          r.array(phase.actions, p + '/actions', 32).length ||
          r.array(phase.valves, p + '/valves', 64).length
        )
          r.fail('DUTY_INVALID', p + '/service', '标定试验须单列，不能同时指定阀位及其他工况命令。');
      }
    }
    const transient = inputs('transient', {
      windowS: [1e-4, 5],
      switchAtS: [0, 5],
      rampS: [0, 5],
      cutoffPa: [1, 70e6],
      bandPa: [1, 70e6],
      responseS: [1e-5, 5],
      finalAreaM2: [0, 1],
    });
    const resetStudy = inputs('resetStudy', { sweptM3: [0, 1], flowM3PerS: [0, 1], backPa: [0, 70e6] });
    const cycleThermal = inputs('cycleThermal', {
      capacity: [1e-12, 1e12],
      conductance: [0, 1e8],
      ambient: [-273, 2000],
      initial: [-273, 2000],
      cycles: [1, 1e9],
    });
    if (
      cycleThermal &&
      (!phase.pumpStorage || (cycleThermal.cycles !== undefined && !Number.isInteger(cycleThermal.cycles)))
    )
      r.fail('DUTY_INVALID', p, '循环热边界须配定量泵储能工况，循环次数须为整数。');
    if (resetStudy && (!boundary || phase.accumulatorOilVolumeM3 !== undefined || phase.pumpStorage))
      r.fail('DUTY_INVALID', p, '增压器复位须为独立工况。');
    if (phase.switchPrevious !== undefined && phase.switchPrevious !== 'on' && phase.switchPrevious !== 'off')
      r.fail('DUTY_INVALID', p + '/switchPrevious', '开关前态须为已动作或已复位。');
    if (phase.flowSplit !== undefined && phase.flowSplit !== true)
      r.fail('DUTY_INVALID', p + '/flowSplit', '实际分流标记须为 true 或省略。');
    const filterBypass =
      phase.filterBypass === undefined
        ? undefined
        : r.object(phase.filterBypass, p + '/filterBypass', [
            'componentId',
            'ratedDropPa',
            'crackingPressurePa',
            'effectiveAreaM2',
          ]);
    if (filterBypass && phase.flowSplit !== true)
      r.fail('DUTY_INVALID', p + '/filterBypass', '滤芯内置旁通须启用双缸实际分流。');
    const pressureControl =
      phase.pumpPressureControl === undefined
        ? undefined
        : r.object(phase.pumpPressureControl, p + '/pumpPressureControl', ['cutoffDifferentialPa', 'bandPa']);
    const dividerEnd =
      phase.dividerEnd === undefined
        ? undefined
        : r.object(phase.dividerEnd, p + '/dividerEnd', ['componentId', 'pressurePa']);
    if (dividerEnd && phase.flowSplit !== true) r.fail('DUTY_INVALID', p + '/dividerEnd', '末端纠偏须启用实际分流。');
    const shutoffs =
      phase.shutoffs === undefined
        ? undefined
        : r.array(phase.shutoffs, p + '/shutoffs', 100).map((entry, j): NonNullable<DutyPhase['shutoffs']>[number] => {
            const q = p + '/shutoffs/' + j;
            const item = r.object(entry, q, ['componentId', 'state', 'openingAreaM2']);
            if (item.state !== 'open' && item.state !== 'closed' && item.state !== 'partial')
              r.fail('DUTY_INVALID', q + '/state', '截止阀须指定全开、关闭或中间有效开口。');
            const componentId = r.id(item.componentId, q + '/componentId');
            if (item.state === 'partial')
              return {
                componentId,
                state: 'partial',
                openingAreaM2: number(item.openingAreaM2, q + '/openingAreaM2', 1e-12, 1),
              };
            if (item.openingAreaM2 !== undefined)
              r.fail('DUTY_INVALID', q + '/openingAreaM2', '有效开口只适用于中间开度工况。');
            return {
              componentId,
              state: item.state === 'open' ? 'open' : 'closed',
            };
          });
    const valves = r.array(phase.valves, p + '/valves', 100).map((v, j): DutyPhase['valves'][number] => {
      const q = p + '/valves/' + j,
        valve = r.object(v, q, ['componentId', 'positionId']);
      const slot = valve.positionId;
      if (slot !== 'extend' && slot !== 'neutral' && slot !== 'retract')
        r.fail('DUTY_INVALID', q + '/positionId', '请选择明确阀位。');
      return {
        componentId: r.id(valve.componentId, q + '/componentId'),
        positionId: slot === 'extend' || slot === 'retract' ? slot : 'neutral',
      };
    });
    const actions = r.array(phase.actions, p + '/actions', 100).map((v, j): DutyAction => {
      const q = p + '/actions/' + j,
        a = r.object(v, q, [
          'componentId',
          'direction',
          'speed',
          'resistingLoad',
          'supplyLossPa',
          'returnPressurePa',
          'mechanicalEfficiency',
          'volumetricEfficiency',
          'positionM',
          'rotaryAngleRad',
          'motorSetting',
        ]);
      if (a.direction !== 'forward' && a.direction !== 'reverse')
        r.fail('DUTY_INVALID', q + '/direction', '方向须明确。');
      const setting =
        a.motorSetting === undefined ? undefined : r.object(a.motorSetting, q + '/motorSetting', ['kind', 'value']);
      const kind = setting?.kind;
      if (setting && kind !== 'command' && kind !== 'differential' && kind !== 'pilot' && kind !== 'voltage')
        r.fail('DUTY_INVALID', q + '/motorSetting/kind', '马达给定须为排量指令、压差、先导压力或电压。');
      const motorSetting: DutyMotorSetting | undefined =
        setting && (kind === 'command' || kind === 'differential' || kind === 'pilot' || kind === 'voltage')
          ? {
              kind,
              value: number(
                setting.value,
                q + '/motorSetting/value',
                0,
                kind === 'command' ? 100 : kind === 'voltage' ? 10 : 70e6,
              ),
            }
          : undefined;
      return {
        componentId: r.id(a.componentId, q + '/componentId'),
        direction: a.direction === 'reverse' ? 'reverse' : 'forward',
        speed:
          dividerEnd && a.componentId === dividerEnd.componentId
            ? number(a.speed, q + '/speed', 0, 0)
            : number(a.speed, q + '/speed'),
        resistingLoad: number(a.resistingLoad, q + '/resistingLoad', 0),
        supplyLossPa: number(a.supplyLossPa, q + '/supplyLossPa', 0, 70e6),
        returnPressurePa: number(a.returnPressurePa, q + '/returnPressurePa', 0, 70e6),
        mechanicalEfficiency: number(a.mechanicalEfficiency, q + '/mechanicalEfficiency', Number.MIN_VALUE, 1),
        volumetricEfficiency: number(a.volumetricEfficiency, q + '/volumetricEfficiency', Number.MIN_VALUE, 1),
        ...(a.positionM === undefined ? {} : { positionM: number(a.positionM, q + '/positionM', 0, 5) }),
        ...(a.rotaryAngleRad === undefined
          ? {}
          : { rotaryAngleRad: number(a.rotaryAngleRad, q + '/rotaryAngleRad', 0, 2 * Math.PI + 1e-9) }),
        ...(motorSetting ? { motorSetting } : {}),
      };
    });
    r.unique(
      valves.map((v) => v.componentId),
      p + '/valves',
    );
    r.unique(
      actions.map((a) => a.componentId),
      p + '/actions',
    );
    if (
      !actions.length &&
      phase.accumulatorOilVolumeM3 === undefined &&
      !resetStudy &&
      !service &&
      !transient &&
      loadStudy !== 'suction'
    )
      r.fail('DUTY_INVALID', p + '/actions', '每个工况须指定动作或蓄能器状态。');
    if (phase.accumulatorTargetOilVolumeM3 !== undefined && phase.accumulatorOilVolumeM3 === undefined)
      r.fail('DUTY_INVALID', p + '/accumulatorOilVolumeM3', '蓄能器充放油时间需要起始油量。');
    if (phase.accumulatorTargetOilVolumeM3 !== undefined && !boundary && !phase.pumpStorage)
      r.fail('DUTY_INVALID', p + '/accumulatorTargetOilVolumeM3', '蓄能器充放油时间需要独立恒压边界。');
    if (shutoffs)
      r.unique(
        shutoffs.map((entry) => entry.componentId),
        p + '/shutoffs',
      );
    return {
      name: r.text(phase.name, p + '/name', 1, 80),
      valves,
      actions,
      ...(loadStudy ? { loadStudy } : {}),
      ...(phase.minimumInletPa === undefined
        ? {}
        : { minimumInletPa: number(phase.minimumInletPa, p + '/minimumInletPa', Number.MIN_VALUE, 70e6) }),
      ...(phase.pumpStorage === true ? { pumpStorage: true } : {}),
      ...(phase.drainLeakM3PerS === undefined
        ? {}
        : { drainLeakM3PerS: number(phase.drainLeakM3PerS, p + '/drainLeakM3PerS', 0, 1) }),
      ...(service ? { service } : {}),
      ...(transient ? { transient } : {}),
      ...(resetStudy ? { resetStudy } : {}),
      ...(cycleThermal ? { cycleThermal } : {}),
      ...(shutoffs ? { shutoffs } : {}),
      ...(phase.flowSplit === true ? { flowSplit: true } : {}),
      ...(filterBypass
        ? {
            filterBypass: {
              componentId: r.id(filterBypass.componentId, p + '/filterBypass/componentId'),
              ratedDropPa: number(filterBypass.ratedDropPa, p + '/filterBypass/ratedDropPa', Number.MIN_VALUE, 70e6),
              crackingPressurePa: number(
                filterBypass.crackingPressurePa,
                p + '/filterBypass/crackingPressurePa',
                0,
                70e6,
              ),
              effectiveAreaM2: number(filterBypass.effectiveAreaM2, p + '/filterBypass/effectiveAreaM2', 1e-12, 1),
            },
          }
        : {}),
      ...(phase.accumulatorOilVolumeM3 === undefined
        ? {}
        : {
            accumulatorOilVolumeM3: number(phase.accumulatorOilVolumeM3, p + '/accumulatorOilVolumeM3', 0, 1),
          }),
      ...(phase.accumulatorTargetOilVolumeM3 === undefined
        ? {}
        : {
            accumulatorTargetOilVolumeM3: number(
              phase.accumulatorTargetOilVolumeM3,
              p + '/accumulatorTargetOilVolumeM3',
              0,
              1,
            ),
          }),
      ...(phase.loadSenseMarginPa === undefined
        ? {}
        : { loadSenseMarginPa: number(phase.loadSenseMarginPa, p + '/loadSenseMarginPa', Number.MIN_VALUE, 70e6) }),
      ...(phase.switchPrevious === undefined
        ? {}
        : { switchPrevious: phase.switchPrevious === 'on' ? ('on' as const) : ('off' as const) }),
      ...(phase.pumpCommandPercent === undefined
        ? {}
        : { pumpCommandPercent: number(phase.pumpCommandPercent, p + '/pumpCommandPercent', 0, 100) }),
      ...(pressureControl
        ? {
            pumpPressureControl: {
              cutoffDifferentialPa: number(
                pressureControl.cutoffDifferentialPa,
                p + '/pumpPressureControl/cutoffDifferentialPa',
                Number.MIN_VALUE,
                70e6,
              ),
              bandPa: number(pressureControl.bandPa, p + '/pumpPressureControl/bandPa', Number.MIN_VALUE, 70e6),
            },
          }
        : {}),
      ...(dividerEnd
        ? {
            dividerEnd: {
              componentId: r.id(dividerEnd.componentId, p + '/dividerEnd/componentId'),
              pressurePa: number(dividerEnd.pressurePa, p + '/dividerEnd/pressurePa', 0, 70e6),
            },
          }
        : {}),
    };
  });
  r.unique(
    phases.map((p) => p.name),
    '/duty/phases',
  );
  return phases;
}

export function parseNetworkDutyPhases(input: unknown): Result<readonly DutyPhase[]> {
  const checked = checkJson(input);
  if (!checked.ok) return checked;
  const reader = new ContractReader();
  return reader.finish(readDutyPhases(reader, input));
}

export function parseNetworkDutyRequest(input: unknown): Result<NetworkDutyRequest> {
  const json = checkJson(input);
  if (!json.ok) return json;
  const r = new ContractReader();
  const o = r.object(input, '/duty', [
    'pumpId',
    'boundary',
    'angularSpeedRadPerS',
    'pumpVolumetricEfficiency',
    'totalEfficiency',
    'pressureLimitPa',
    'phases',
    'automaticFields',
  ]);
  if (o.boundary !== undefined && o.boundary !== true)
    r.fail('DUTY_INVALID', '/duty/boundary', '独立边界标记须为 true。');
  const number = (v: unknown, p: string, min = Number.MIN_VALUE, max = Number.MAX_VALUE) => r.number(v, p, min, max);
  const phases = readDutyPhases(r, o.phases, o.boundary === true);
  if (!phases.length) r.fail('DUTY_INVALID', '/duty/phases', '至少指定一个工况。');
  const automaticFields =
    o.automaticFields === undefined
      ? []
      : r
          .array(o.automaticFields, '/duty/automaticFields', 15000)
          .map((value, index) => r.text(value, '/duty/automaticFields/' + index, 1, 180));
  r.unique(automaticFields, '/duty/automaticFields');
  const independentInputs = o.boundary === true || (phases.length > 0 && phases.every((p) => p.service));
  return r.finish({
    pumpId: r.id(o.pumpId, '/duty/pumpId'),
    ...(o.boundary === true ? { boundary: true as const } : {}),
    angularSpeedRadPerS: independentInputs
      ? 0
      : number(o.angularSpeedRadPerS, '/duty/angularSpeedRadPerS', Number.MIN_VALUE, 5000),
    pumpVolumetricEfficiency: independentInputs
      ? 1
      : number(o.pumpVolumetricEfficiency, '/duty/pumpVolumetricEfficiency', Number.MIN_VALUE, 1),
    totalEfficiency: independentInputs ? 1 : number(o.totalEfficiency, '/duty/totalEfficiency', Number.MIN_VALUE, 1),
    pressureLimitPa: independentInputs ? 0 : number(o.pressureLimitPa, '/duty/pressureLimitPa', Number.MIN_VALUE, 70e6),
    phases,
    automaticFields,
  });
}
export function parseNetworkDutyReportRequest(duty: unknown, pendingPhases: unknown): Result<NetworkDutyReportRequest> {
  const parsed = duty === null ? null : parseNetworkDutyRequest(duty);
  if (parsed && !parsed.ok) return parsed;
  const r = new ContractReader();
  const pending = (pendingPhases === undefined ? [] : r.array(pendingPhases, '/pendingPhases', 24)).map(
    (item, i): DutyPendingPhase => {
      const path = '/pendingPhases/' + i,
        phase = r.object(item, path, ['name', 'kind', 'reason']);
      if (phase.kind !== 'incomplete' && phase.kind !== 'excluded')
        r.fail('DUTY_INVALID', path + '/kind', '工况状态须为条件未齐或未纳入。');
      return {
        name: r.text(phase.name, path + '/name', 1, 80),
        kind: phase.kind === 'excluded' ? 'excluded' : 'incomplete',
        reason: r.text(phase.reason, path + '/reason', 1, 1600),
      };
    },
  );
  if ((parsed?.value.phases.length ?? 0) + pending.length > 24)
    r.fail('DUTY_INVALID', '/pendingPhases', '工况及未核算记录合计最多24项。');
  return r.finish({ duty: parsed?.value ?? null, pendingPhases: pending });
}

/** A report can retain independent successful phases. Whole-circuit selection still requires complete coverage. */
export function reviewNetworkDuty(document: NetworkProject, input: NetworkDutyReportRequest) {
  const componentLimits = dutyComponentLimits(document, input.duty);
  const phases: DutyPhaseCoverage[] = [];
  const steps: CalculationStep[] = [];
  const request = input.duty;
  const result = request === null ? null : checkNetworkDuty(document, request);
  const completePlan =
    result?.ok && !input.pendingPhases.some((phase) => phase.kind === 'incomplete') ? result.value : null;
  const calculated = (plan: NetworkDutyPlan, demand: DutyDemand): DutyPhaseCoverage => {
    const limits = plan.constraints
      .filter((item) => item.phase === demand.name)
      .map((item) =>
        item.kind === 'pressure-budget'
          ? `供油压力需求超过试算预算 ${Number((item.limitPa / 1e6).toPrecision(6))} MPa。`
          : `达到或超过 ${item.componentId} 的溢流开启压差 ${Number((item.limitPa / 1e6).toPrecision(6))} MPa。`,
      );
    if (isDutySupplyDemand(demand)) {
      if (demand.supplyBalanceIssue) limits.push(demand.supplyBalanceIssue);
      else if (
        !demand.flowSplit &&
        demand.flowM3PerS - (demand.availableFlowM3PerS ?? plan.availableFlowM3PerS) > demand.flowM3PerS * 1e-10
      )
        limits.push(
          `估计供给流量不足，差 ${Number(((demand.flowM3PerS - (demand.availableFlowM3PerS ?? plan.availableFlowM3PerS)) * 60000).toPrecision(6))} L/min。`,
        );
    }
    return { name: demand.name, kind: 'calculated', demand, ...(limits.length ? { limits } : {}) };
  };
  if (result?.ok) {
    const plan = result.value;
    phases.push(...plan.phases.map((demand) => calculated(plan, demand)));
    steps.push(
      ...(completePlan
        ? result.value.record.steps
        : result.value.record.steps.filter((step) => step.key.startsWith('phase'))),
    );
  } else if (request) {
    for (const [index, phase] of request.phases.entries()) {
      const prefix = `/phases/${index}/`;
      const automaticFields =
        request.automaticFields?.flatMap((field) =>
          field.startsWith(prefix)
            ? ['/phases/0/' + field.slice(prefix.length)]
            : field.startsWith('/phases/')
              ? []
              : [field],
        ) ?? [];
      const attempt = calculateNetworkDuty(document, { ...request, phases: [phase], automaticFields }, 'check', index);
      const demand = attempt.ok ? attempt.value.phases[0] : undefined;
      if (attempt.ok && demand) {
        phases.push(calculated(attempt.value, demand));
        steps.push(...attempt.value.record.steps.filter((step) => step.key.startsWith('phase')));
      } else if (!attempt.ok) {
        const reason = attempt.diagnostics
          .map((item) =>
            item.code === 'DUTY_COMPONENT_UNSUPPORTED' ? '整图含未覆盖元件，详见元件清单。' : item.message,
          )
          .join('；');
        if (attempt.diagnostics.every((item) => item.code === 'DUTY_TARGET_BLOCKED')) {
          phases.push({ name: phase.name, kind: 'blocked', reason });
          continue;
        }
        phases.push({
          name: phase.name,
          kind: 'unsupported',
          reason,
          ...(phase.flowSplit
            ? {
                flowSplit: {
                  kind: 'pending',
                  targets: parallelFlowTargets(document, phase.actions),
                  reasons: [reason],
                },
              }
            : {}),
        });
      }
    }
  }
  phases.push(
    ...input.pendingPhases.map((phase): DutyPhaseCoverage =>
      phase.kind === 'incomplete' && componentLimits.length
        ? { ...phase, kind: 'unsupported', reason: '整图含未覆盖元件，详见元件清单。' + phase.reason }
        : phase,
    ),
  );
  const splitPending = phases.some(
    (phase) =>
      phase.kind === 'calculated' &&
      (phase.demand.flowSplit?.kind === 'pending' ||
        phase.demand.boundaryAssessment?.transfer === 'pending' ||
        phase.demand.boundaryAssessment?.controlPending ||
        phase.demand.boundaryAssessment?.loadPending),
  );
  const dynamic = request?.phases.filter((p) => p.transient) ?? [];
  const other = request?.phases.filter((p) => !p.transient) ?? [];
  const coverage: NetworkDutyCoverage = {
    ...(request?.phases.some((p) => p.service) ? { hasServiceStudy: true as const } : {}),
    phases,
    componentLimits,
    complete: completePlan !== null && !splitPending,
    ...(dynamic.length ? { transientScope: other.length ? ('mixed' as const) : ('only' as const) } : {}),
  };
  const ordinaryConditions = (request: NetworkDutyRequest | null) => {
    const mode = request && sourceControlMode(document, request);
    return mode
      ? sourceControlConditions(mode)
      : request && (request.boundary || request.phases.some((p) => p.pumpStorage || p.loadStudy || p.transient))
        ? boundaryDutyConditions(document, request)
        : dutyConditions(
            document,
            request?.phases.some((phase) => phase.flowSplit),
            request === null ? false : hasDisplacementCommands(request),
            request?.phases.some((phase) => phase.pumpPressureControl),
          );
  };
  const conditions =
    dynamic.length && request
      ? [
          ...boundaryDutyConditions(document, { ...request, phases: dynamic }),
          ...(other.length ? (ordinaryConditions({ ...request, phases: other }) ?? []) : []),
        ]
      : ordinaryConditions(request);
  const supplements = (request?.phases ?? []).flatMap((p) =>
    p.service ? [serviceStudies[p.service.mode].condition] : [],
  );
  return {
    coverage,
    completePlan,
    steps,
    conditions: supplements.length
      ? [...new Set([...(request?.phases.every((p) => p.service) ? [] : (conditions ?? [])), ...supplements])]
      : conditions,
  };
}
function hasDisplacementCommands(request: NetworkDutyRequest): boolean {
  return request.phases.some(
    (phase) => phase.pumpCommandPercent !== undefined || phase.actions.some((action) => action.motorSetting),
  );
}

function dutyConditions(
  document: NetworkProject,
  split = false,
  controlled = false,
  pressureControl = false,
): readonly string[] | undefined {
  const parts = document.design.components;
  const rotary = parts.some((part) => part.typeId === 'limited-rotary-actuator');
  if (rotary || controlled || pressureControl)
    return [
      ...(rotary || controlled
        ? ['适用单泵、单油箱、单执行器的理想主油路。按已知等效供油损失和回油腔压力估算目标点。']
        : []),
      ...(rotary ? rotaryDutyConditions : []),
      ...(parts.some((part) => part.parameters.workProtection?.enabled === 1)
        ? [
            '摆动执行器内置保护的溢流设定以所选内置油箱或实际 T 口压力为参考。稳态目标点核算不计入保护支路流量，制动和限压需按动态回路复核。',
          ]
        : []),
      ...(controlled ? displacementDutyConditions : []),
      ...(pressureControl ? pumpPressureDutyConditions : []),
    ];
  if (parts.some((part) => dutyProtectionTypes.has(part.typeId))) return protectionDutyConditions;
  if (parts.some((part) => dutyDividerTypes.has(part.typeId))) return dividerDutyConditions;
  if (parts.filter((part) => part.typeId === 'pilot-check').length === 2)
    return [
      '两阀 B 口分别接两缸腔，X 交叉取对侧阀 A 口。按给定目标速度核对自由进油压降和排油阀维持开启裕量，内泄参考本阀 A 口，外泄 Y 直回同箱。缸容积效率取 1，回油基础压力取排油阀 A 口，手填供油损失不含两只液控阀。起动瞬态、静态保压与余流分配待核。',
    ];
  const splitAccessories = split && parts.some(isReturnTreeAccessory);
  const hasExternalPilot = parts.some((part) => part.definition.id === 'teaching:pilot-check');
  const valves = new Set(
    parts.filter((component) => dutyControlValveTypes.has(component.typeId)).map((component) => component.typeId),
  );
  const conditions = [
    ...(!split &&
    parts.filter((part) => part.typeId === 'cylinder').length === 1 &&
    parts.filter((part) => part.typeId === 'valve').length === 1 &&
    parts.every((part) => ['pump', 'tank', 'valve', 'cylinder', 'volume', 'relief'].includes(part.typeId)) &&
    document.design.connections.some((edge) => edge.kind === 'pipe')
      ? workingLineConditions
      : []),
    ...(splitAccessories
      ? multiReturnAccessoryConditions
      : !hasExternalPilot &&
          !parts.some((part) => part.typeId === 'single-acting-cylinder') &&
          parts.some((component) => dutyAccessoryTypes.has(component.typeId))
        ? dutyAccessoryConditions
        : []),
    ...(split && parts.some((part) => part.typeId === 'one-way-throttle') ? returnThrottleConditions : []),
    ...(split && parts.some((part) => part.definition.id === 'teaching:pilot-relief')
      ? pilotReliefSplitConditions
      : []),
    ...(parts.some(
      (component) =>
        component.typeId === 'adjustable-pressure-switch' &&
        !document.design.connections.some(
          (edge) => edge.kind === 'signal' && edge.from.kind === 'port' && edge.from.componentId === component.id,
        ),
    )
      ? [
          '可调压力开关限 H 口单支路旁接且 OUT 未接线。H 口压力及动作阈值差取自目标工况；开关回差状态、模拟电压和闭环控制不在本次核算范围。',
        ]
      : []),
    ...(parts.some((component) => dutyBufferedCylinderTypes.has(component.typeId)) ? bufferedDutyConditions : []),
    ...(parts.some((component) => component.typeId === 'single-acting-cylinder')
      ? parts.some((part) => part.typeId === 'return-filter' || part.typeId === 'flow-meter')
        ? springDutyConditions.slice(0, 2)
        : springDutyConditions
      : []),
    ...(parts.some((component) => component.typeId === 'single-acting-cylinder') &&
    parts.some((component) => component.typeId === 'return-filter' || component.typeId === 'flow-meter')
      ? springAccessoryConditions
      : []),
    ...(valves.size ? controlValveDutyConditions : []),
    ...(parts.some(hasControlDrain) ? [pressurizedControlDrainCondition] : []),
    ...[...valves].flatMap((type) => {
      const note = controlValveModelConditions[type];
      return note ? [note] : [];
    }),
    ...(parts.some((part) => dutyMultiPortValveTypes.has(part.typeId)) ? multiPortValveCommonConditions : []),
    ...(parts.some((part) => dutyLogicValveTypes.has(part.typeId)) ? logicValveDutyConditions : []),
    ...(hasExternalPilot ||
    (parts.some((part) => part.typeId === 'pilot-check') && parts.some((part) => part.typeId === 'return-filter'))
      ? [pilotCheckFilterCondition, ...(hasExternalPilot ? [pilotCheckOutletPipeCondition] : [])]
      : []),
    ...parts.flatMap((part) => {
      const note = multiPortValveConditions[part.typeId];
      return note ? [note] : [];
    }),
  ];
  if (split) {
    const hasPipes = document.design.connections.some((edge) => edge.kind === 'pipe');
    const flowConditions = splitAccessories || hasPipes ? sharedReturnFlowConditions : parallelFlowConditions;
    const pump = hasPipes && parts.find((part) => part.typeId === 'pump');
    const paths = pump && dutyPhasePaths(document, { name: '供油管', actions: [], valves: [] }, false, true);
    const supplyConditions =
      paths &&
      paths.ok &&
      pump &&
      hasPhysicalSupplyPath(
        paths.value,
        pump,
        parts.filter((part) => part.typeId === 'valve'),
      )
        ? supplyPipeFlowConditions
        : [];
    return [...flowConditions, ...supplyConditions, ...conditions];
  }
  const variable = parts.some((part) =>
    ['teaching:variable-pump', 'teaching:variable-motor'].includes(part.definition.id),
  );
  if (!conditions.length && !variable) return undefined;
  return [
    ...(conditions.length
      ? [
          '本批按单泵、单执行器的稳态阻性负载和给定阀位计算。',
          ...(hasExternalPilot ? ['四口外泄液控单向阀可设独立 Y 泄油箱。'] : []),
          ...conditions,
        ]
      : []),
    ...(variable ? displacementDutyConditions : []),
  ];
}
export function planNetworkDuty(document: unknown, input: unknown): Result<NetworkDutyPlan> {
  return calculateNetworkDuty(document, input, 'sizing');
}
/** Same canonical equations, but reports supply constraints and never constructs parameter changes. */
export function checkNetworkDuty(document: unknown, input: unknown): Result<NetworkDutyPlan> {
  return calculateNetworkDuty(document, input, 'check');
}
function calculateNetworkDuty(
  document: unknown,
  input: unknown,
  purpose: 'sizing' | 'check',
  phaseOffset = 0,
): Result<NetworkDutyPlan> {
  const parsed = parseNetworkProject(document);
  if (!parsed.ok) return parsed;
  const request = parseNetworkDutyRequest(input);
  if (!request.ok) return request;
  const project = parsed.value,
    req = request.value;
  const hasPressureControl = req.phases.some((phase) => phase.pumpPressureControl);
  if (hasPressureControl && (purpose === 'sizing' || req.boundary))
    return fail('变量泵压力调节限校核当前设计，不能用于排量初选或其他供压边界。');
  if (req.phases.some((p) => p.service))
    return purpose === 'check' && req.phases.every((p) => p.service)
      ? checkBoundaryDuty(project, req, phaseOffset)
      : fail('标定试验逐工况出书，不提供泵排量初选。');
  if (req.phases.some((p) => p.transient))
    return purpose === 'check' && req.phases.every((p) => p.transient)
      ? checkBoundaryDuty(project, req, phaseOffset)
      : fail('瞬态工况须校核当前设计，不能用于泵排量初选。');
  if (req.phases.some((p) => p.loadStudy))
    return purpose === 'check' && req.phases.every((p) => p.loadStudy)
      ? checkBoundaryDuty(project, req, phaseOffset)
      : fail('功率方向和吸油专项须分工况校核当前设计。');
  if (req.phases.some((p) => p.pumpStorage))
    return purpose === 'check' && !req.boundary && req.phases.every((p) => p.pumpStorage)
      ? checkBoundaryDuty(project, req, phaseOffset)
      : fail('定量泵储能限独立校核当前设计。');
  if (
    sourceControlMode(project, req) ||
    req.phases.some((p) => p.loadSenseMarginPa !== undefined || p.switchPrevious !== undefined)
  )
    return purpose === 'check' && sourceControlMode(project, req)
      ? checkBoundaryDuty(project, req, phaseOffset)
      : fail('负载敏感及多源稳态控制须在对应回路校核当前设计。');
  if (req.boundary)
    return purpose === 'check' ? checkBoundaryDuty(project, req, phaseOffset) : fail('恒压及储能边界限校核当前设计。');
  if (req.phases.some((phase) => phase.accumulatorOilVolumeM3 !== undefined))
    return fail('蓄能器状态需要独立边界核算。');
  const hasFlowSplit = req.phases.some((phase) => phase.flowSplit);
  if (purpose === 'sizing' && hasFlowSplit) return fail('多缸实际分流仅核算当前设计，请按阀口条件核对。');
  const pumps = project.design.components.filter((c) => c.typeId === 'pump'),
    tanks = project.design.components.filter((c) => c.typeId === 'tank');
  const pump = pumps[0],
    tank = dutyMainTank(project, req.pumpId);
  if (pumps.length !== 1 || !pump)
    return fail(`工程中检测到${pumps.length}个泵；当前工况计算只支持一个泵，包含未连接的元件。`);
  if (pump.id !== req.pumpId) return fail('所选目标泵与工程中的唯一泵不匹配，请重新选择目标泵。');
  if (!tank)
    return fail(`工程中检测到${tanks.length}个油箱。主油箱须唯一，四口外泄液控单向阀的第二油箱仅可用于独立 Y 泄油。`);
  const limits = dutyComponentLimits(project, req);
  if (limits.length)
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'DUTY_COMPONENT_UNSUPPORTED',
          '/duty',
          '回路含当前工况计算未覆盖的元件。' +
            limits.map((item) => `${item.label} [${item.componentId}]：${item.reason}`).join('；'),
        ),
      ],
    };
  const tankPressure = tank.parameters.hydraulic?.pressurePa;
  const controlled = hasDisplacementCommands(req);
  const rotary = project.design.components.some((part) => part.typeId === 'limited-rotary-actuator');
  const boundary = dutyExternalMotorBoundary(project, req);
  if (purpose === 'sizing' && controlled) return fail('逐工况排量给定限校核当前设计。');
  if (rotary || controlled) {
    const allowed = new Set([
      'pump',
      'tank',
      'valve',
      'volume',
      'relief',
      'cylinder',
      'motor',
      'limited-rotary-actuator',
    ]);
    if (
      tanks.length !== 1 ||
      project.design.components.filter((part) => isNetworkActuatorType(part.typeId)).length !== 1 ||
      project.design.components.some((part) => !allowed.has(part.typeId) && !boundary?.ids.has(part.id)) ||
      project.design.connections.some((edge) => edge.kind === 'pipe') ||
      hasFlowSplit
    )
      return fail('摆角或逐工况排量核算限单泵、单油箱及单执行器的理想主油路。');
  }
  if (tankPressure === undefined) return fail('回油箱压力缺失，不能推断计算基准。');
  if (req.totalEfficiency > req.pumpVolumetricEfficiency) return fail('泵总效率不能大于容积效率。');
  const accessories = project.design.components.filter(
    (component) => dutyAccessoryTypes.has(component.typeId) && !boundary?.ids.has(component.id),
  );
  const hasAccessories = accessories.length > 0;
  const hasSpring = project.design.components.some((component) => component.typeId === 'single-acting-cylinder');
  const controlValves = project.design.components.filter((component) => dutyControlValveTypes.has(component.typeId));
  const controlValve = controlValves[0];
  const multiPortValves = project.design.components.filter((part) => dutyMultiPortValveTypes.has(part.typeId));
  const multiPortValve = multiPortValves[0];
  const logicValves = project.design.components.filter((part) => dutyLogicValveTypes.has(part.typeId));
  const logicValve = logicValves[0];
  const divider = project.design.components.find((part) => dutyDividerTypes.has(part.typeId));
  const protectionValves = project.design.components.filter((part) => dutyProtectionTypes.has(part.typeId));
  const protection = protectionValves[0];
  if (protection) {
    const types = new Set(['pump', 'tank', 'valve', 'cylinder', 'volume', 'relief', ...dutyProtectionTypes]);
    if (
      protectionValves.length !== 1 ||
      tanks.length !== 1 ||
      pump.definition.id !== 'teaching:pump' ||
      project.design.components.filter((part) => part.typeId === 'cylinder').length !== 1 ||
      project.design.components.filter((part) => part.typeId === 'valve').length !== 1 ||
      project.design.components.some((part) => !types.has(part.typeId)) ||
      project.design.connections.some(
        (edge) => edge.kind !== 'ideal' && !(edge.kind === 'pipe' && protection.typeId === 'counterbalance'),
      ) ||
      hasFlowSplit
    )
      return fail(
        (protection.label || protection.id) +
          ' 限单定量泵、单油箱、单四通换向阀、单普通双作用缸和一只保护阀的理想回路。',
      );
  }
  if (logicValve) {
    const simpleTypes = new Set(['pump', 'tank', 'valve', 'cylinder', 'volume', 'relief', ...dutyLogicValveTypes]);
    if (
      logicValves.length !== 1 ||
      tanks.length !== 1 ||
      pump.definition.id !== 'teaching:pump' ||
      project.design.components.filter((part) => part.typeId === 'cylinder').length !== 1 ||
      project.design.components.some((part) => !simpleTypes.has(part.typeId)) ||
      project.design.connections.some((edge) => edge.kind !== 'ideal') ||
      hasFlowSplit
    )
      return fail(
        (logicValve.label || logicValve.id) +
          ' 的通路判定限单定量泵、单油箱、单普通双作用缸及一只通路判定阀，混接和有损管待核。',
      );
  }
  const crossPilot = multiPortValves.length === 2 && multiPortValves.every((part) => part.typeId === 'pilot-check');
  if (
    crossPilot &&
    (hasAccessories ||
      hasFlowSplit ||
      tanks.length !== 1 ||
      pump.definition.id !== 'teaching:pump' ||
      project.design.components.filter((part) => part.typeId === 'valve').length !== 1 ||
      project.design.components.some(
        (part) => !['pump', 'tank', 'cylinder', 'valve', 'volume', 'relief', 'pilot-check'].includes(part.typeId),
      ) ||
      project.design.connections.some((edge) => edge.kind !== 'ideal'))
  )
    return fail('双阀交叉先导限单定量泵、单油箱、单四通阀与单普通双作用缸的理想主油路。');
  const externalPilot =
    !crossPilot && multiPortValve?.definition.id === 'teaching:pilot-check' ? multiPortValve : undefined;
  const filters = accessories.filter((part) => part.typeId === 'return-filter');
  const filter = filters[0];
  if (
    controlValves.length > 1 &&
    (controlValves.length !== 2 ||
      controlValves.some((c) => !hasControlDrain(c)) ||
      hasAccessories ||
      project.design.connections.some((e) => e.kind !== 'ideal') ||
      req.phases.some((p) => p.drainLeakM3PerS !== undefined))
  )
    return fail('双压力阀限理想管路正向串联、两只 Y 口独立直回同箱。其他组合或逐阀泄流待核。');
  if (multiPortValve && ((multiPortValves.length > 1 && !crossPilot) || controlValve || hasSpring))
    return fail(
      '多口阀稳态限单只液控单向阀、三通溢流减压阀或三通调速阀。成对液控阀仅支持指定交叉先导接法，其他控制阀混接待核。',
    );
  if (
    multiPortValve &&
    hasAccessories &&
    (multiPortValve.typeId !== 'pilot-check' ||
      (!externalPilot && (accessories.length !== 1 || !filter)) ||
      (externalPilot && accessories.some((part) => part.typeId !== 'return-filter' && part.typeId !== 'flow-meter')))
  )
    return fail(
      `${multiPortValve.label || multiPortValve.id} [${multiPortValve.id}] 与附件混接待核。液控单向阀支持回油过滤器，四口外泄型另支持回油流量计。`,
    );
  if (multiPortValve?.typeId === 'three-way-flow-control' && pump.definition.id === 'teaching:variable-pump')
    return fail('三通调速阀当前按定量泵稳态供流核算，变量泵调节条件暂未纳入。');
  if (controlValve && hasSpring) return fail('控制阀限双作用缸主供油路，单作用缸的单腔供油与弹簧回程组合暂未纳入。');
  const parallelReturnAccessories =
    hasAccessories &&
    accessories.every(isReturnTreeAccessory) &&
    project.design.components.filter((component) => component.typeId === 'cylinder').length >= 2;
  const scopedCylinders =
    (hasAccessories && !parallelReturnAccessories) ||
    logicValve !== undefined ||
    protection !== undefined ||
    hasSpring ||
    controlValve !== undefined ||
    multiPortValve !== undefined ||
    project.design.components.some((component) => dutyBufferedCylinderTypes.has(component.typeId));
  if (scopedCylinders) {
    const cylinders = project.design.components.filter((component) => isLinearActuatorType(component.typeId));
    if (cylinders.length !== 1 || project.design.components.some((component) => component.typeId === 'motor'))
      return fail('新增附件、油缸及控制阀的稳态核算目前限单执行器油缸回路。');
    if (
      hasSpring &&
      hasAccessories &&
      (accessories.length !== 1 ||
        accessories.some((part) => part.typeId !== 'return-filter' && part.typeId !== 'flow-meter') ||
        project.design.connections.some((edge) => edge.kind === 'pipe'))
    )
      return fail('单作用缸附件限一只清洁滤芯或流量计与理想油路串联，其他混接待核。');
  }
  const defaults = networkDutyAutomaticDefaults(project, req.pumpId);
  const automaticCandidates = new Map<string, { readonly value: number; readonly source: string }>();
  const registerDefault = (path: string, value: number, candidate: DutyAutomaticNumber) => {
    if (
      candidate.kind !== 'unavailable' &&
      Math.abs(candidate.value - value) <= 1e-12 * Math.max(1, Math.abs(candidate.value), Math.abs(value))
    )
      automaticCandidates.set(path, { value, source: candidate.source });
  };
  for (const key of ['angularSpeedRadPerS', 'pumpVolumetricEfficiency', 'totalEfficiency', 'pressureLimitPa'] as const)
    registerDefault('/' + key, req[key], defaults.global[key]);
  for (const [phaseIndex, phase] of req.phases.entries())
    for (const [actionIndex, action] of phase.actions.entries()) {
      const preset = defaults.actions.find((entry) => entry.componentId === action.componentId);
      if (!preset) continue;
      for (const key of [
        'speed',
        'resistingLoad',
        'supplyLossPa',
        'returnPressurePa',
        'mechanicalEfficiency',
        'volumetricEfficiency',
      ] as const)
        registerDefault(`/phases/${phaseIndex}/actions/${actionIndex}/${key}`, action[key], preset[key]);
    }
  const automaticSources = new Map<string, string>();
  for (const path of req.automaticFields ?? []) {
    const candidate = automaticCandidates.get(path);
    if (!candidate) return fail('自动配置来源已失效或与实际输入不符：' + path + '；请重新预览，不能冒充系统默认。');
    automaticSources.set(path, candidate.source);
  }
  const sourceFor = (path: string) => automaticSources.get(path) ?? 'user-requirement';
  const steps: CalculationStep[] = [];
  const add = (
    k: string,
    label: string,
    formula: string,
    value: number,
    unit: string,
    dependencies: readonly CalculationInput[],
    scale = 1,
    displayUnit = unit,
  ) => {
    steps.push({
      key: k,
      label,
      source: 'preliminary',
      formula,
      inputs: dependencies,
      substitution: calculationSubstitution(dependencies),
      unit,
      value: { kind: 'known', value },
      display: {
        unit: displayUnit,
        value: { kind: 'known', value: value * scale },
        conversion: `显示值=SI值×${scale}`,
      },
    });
  };
  const known = (reference: string, value: number, unit: string, source = 'user-requirement'): CalculationInput => ({
    reference,
    value: { kind: 'known', value },
    unit,
    source,
  });
  const demands: DutyDemand[] = [];
  const conditions = dutyConditions(project, hasFlowSplit, controlled, hasPressureControl);
  const constraints: DutyConstraint[] = [];
  const reliefLimits: DutyReliefLimit[] = [];
  const beforeD = pump.parameters.hydraulic?.displacementM3PerRev,
    beforeSpeed = pump.parameters.drive?.angularSpeedRadPerS;
  if (beforeD === undefined || beforeSpeed === undefined) return fail('泵参数缺失。');
  const available = ((beforeD * req.angularSpeedRadPerS) / (2 * Math.PI)) * req.pumpVolumetricEfficiency;
  phases: for (const [requestIndex, phase] of req.phases.entries()) {
    const index = requestIndex + phaseOffset;
    if (phase.pumpPressureControl) {
      const result = solveDutyPumpPressure(project, pump, tank, tankPressure, phase, req, phase.pumpPressureControl);
      if (!result.ok) return result;
      const point = result.value;
      if (point.pressurePa > req.pressureLimitPa)
        constraints.push({
          kind: 'pressure-budget',
          phase: phase.name,
          componentId: pump.id,
          requiredPa: point.pressurePa,
          limitPa: req.pressureLimitPa,
        });
      const issues = [
        ...(!point.matchesSpeed
          ? [point.cylinderFlowM3PerS === 0 ? '油缸未建立通流。' : '实际缸速未达目标允差。']
          : []),
        ...(point.aboveCutoff ? ['已到最小排量，实际泵压差仍高于截压设定。'] : []),
      ];
      demands.push({
        name: phase.name,
        pressurePa: point.pressurePa,
        flowM3PerS: point.deliveryFlowM3PerS,
        shaftPowerW: point.shaftPowerW,
        availableFlowM3PerS: point.deliveryFlowM3PerS,
        pumpPressurePoint: point,
        ...(issues.length ? { supplyBalanceIssue: issues.join(' ') } : {}),
      });
      const prefix = 'phase' + index + ':pressure-control:';
      for (const [key, label, value, unit, scale, displayUnit] of [
        ['pressure', '泵出口稳态压力', point.pressurePa, 'Pa', 1e-6, 'MPa'],
        ['displacement', '实际泵排量', point.displacementM3PerRev, 'm³/rev', 1e6, 'cm³/rev'],
        ['pump-flow', '扣泄漏前泵供流', point.pumpFlowM3PerS, 'm³/s', 60000, 'L/min'],
        ['outlet-flow', '泵出口供流', point.deliveryFlowM3PerS, 'm³/s', 60000, 'L/min'],
        ['cylinder-flow', '油缸实际进油', point.cylinderFlowM3PerS, 'm³/s', 60000, 'L/min'],
        ['leakage', '泵压力泄漏', point.leakageM3PerS, 'm³/s', 60000, 'L/min'],
        ['relief', '直动溢流回箱', point.reliefFlowM3PerS, 'm³/s', 60000, 'L/min'],
        ['speed', '油缸实际速度', point.cylinderSpeedMPerS, 'm/s', 1000, 'mm/s'],
        ['power', '估计轴功率', point.shaftPowerW, 'W', 1e-3, 'kW'],
      ] as const)
        add(prefix + key, phase.name + ' / ' + label, '压力调节稳态联立结果', value, unit, [], scale, displayUnit);
      continue;
    }
    const command = phase.pumpCommandPercent;
    const range = networkDisplacementRange(pump);
    if (command !== undefined && !range) return fail(phase.name + '：指定泵没有可调排量范围。');
    const phaseD =
      command === undefined || !range
        ? beforeD
        : networkDisplacementValue(range, {
            kind: 'displacement',
            componentId: pump.id,
            source: 'controller',
            value: command / 100,
          });
    const phaseAvailable = ((phaseD * req.angularSpeedRadPerS) / (2 * Math.PI)) * req.pumpVolumetricEfficiency;
    const valves = project.design.components.filter((c) => c.typeId === 'valve');
    if (divider && !phase.flowSplit) return fail(phase.name + '：分流集流阀须勾选两缸并启用实际分流。');
    if (!divider && phase.dividerEnd) return fail(phase.name + '：末端纠偏须有同步分流集流阀。');
    if (parallelReturnAccessories && !phase.flowSplit)
      return fail(phase.name + '：多缸回油附件须启用实际分流，才能确定各附件的实际回油量。');
    if (phase.valves.length !== valves.length || phase.valves.some((v) => !valves.some((c) => c.id === v.componentId)))
      return fail(phase.name + '：须明确列出回路所有换向阀的工况阀位。');
    if (
      phase.valves.some(
        (v) => !networkValvePositions(valves.find((c) => c.id === v.componentId)!).includes(v.positionId),
      )
    )
      return fail(phase.name + '：二位阀没有中位，请重新选择。');
    const phaseGraph = dutyPhasePaths(
      project,
      phase,
      scopedCylinders,
      externalPilot !== undefined ||
        logicValve !== undefined ||
        (hasSpring && hasAccessories) ||
        (controlValve !== undefined && hasControlDrain(controlValve)) ||
        project.design.connections.some((edge) => edge.kind === 'pipe'),
    );
    if (!phaseGraph.ok) return phaseGraph;
    const paths = phaseGraph.value;
    const reachable = paths.reachable;
    if (!phase.flowSplit && valves.length > 1 && hasPhysicalSupplyPath(paths, pump, valves))
      return fail(phase.name + '：多缸有损供油须启用双缸实际分流，才能核算供油干线及支管压降。');
    if (scopedCylinders && phase.actions.length !== 1)
      return fail(phase.name + '：当前核算范围要求每个工况明确选择一个油缸动作。');
    const closed = paths.states.filter((state) => state.area === 0).map((state) => state.component.id);
    const cutoff = closed.length ? ' 本工况关闭的截止阀：' + closed.join('、') + '。' : '';
    if (!reachable(tank.id + ':T', pump.id + ':S') || reachable(pump.id + ':P', tank.id + ':T'))
      return fail(phase.name + '：吸油不通或存在卸荷/供回油短接，不能用共源压力需求代替。' + cutoff);
    let pressure = 0,
      flow = 0;
    let supplyBalanceIssue: string | undefined;
    const dependencies: CalculationInput[] = [];
    for (const [actionIndex, action] of phase.actions.entries()) {
      const c = project.design.components.find((c) => c.id === action.componentId);
      if (!c || !isNetworkActuatorType(c.typeId)) return fail(phase.name + '：动作对象须为明确的液压执行器。');
      if (action.motorSetting && c.typeId !== 'motor') return fail(phase.name + '：排量给定须用于变量马达。');
      if (action.rotaryAngleRad !== undefined && c.typeId !== 'limited-rotary-actuator')
        return fail(phase.name + '：核算角度须用于有限角度摆动执行器。');
      if (divider && c.id === phase.dividerEnd?.componentId) continue;
      const cylinder = isLinearActuatorType(c.typeId);
      const [workingValve] = valves;
      if (
        c.typeId === 'cylinder' &&
        workingValve &&
        valves.length === 1 &&
        !phase.flowSplit &&
        hasWorkingPipe(paths, workingValve, c)
      ) {
        if (purpose === 'sizing') return fail(phase.name + '：有损工作管限当前设计核算，泵自动选配待核。');
        const solved = solveWorkingLines(project, phase, paths, workingValve, c, {
          pump,
          tank,
          tankPressurePa: tankPressure,
          flowM3PerS: available,
          totalEfficiency: req.totalEfficiency,
          pressureBudgetPa: req.pressureLimitPa,
        });
        if (!solved.ok) return solved;
        const point = solved.value;
        const [branch] = point.branches;
        if (branch) {
          for (const [key, label, value, unit, scale, displayUnit] of [
            ['pressure', '泵出口压力', point.pressurePa, 'Pa', 1e-6, 'MPa'],
            ['flow', '油缸实际进油', branch.flowM3PerS, 'm³/s', 60000, 'L/min'],
            ['return', '缸排油腔背压', branch.returnPressurePa, 'Pa', 1e-6, 'MPa'],
            ['speed', '油缸实际速度', branch.speedMPerS, 'm/s', 1000, 'mm/s'],
            ['relief', '溢流回箱流量', point.reliefFlowM3PerS, 'm³/s', 60000, 'L/min'],
          ] as const)
            add(
              `phase${index}:working:${key}`,
              phase.name + ' / ' + label,
              '有损工作管稳态联立',
              value,
              unit,
              [],
              scale,
              displayUnit,
            );
        }
        demands.push({
          name: phase.name,
          pressurePa: point.pressurePa,
          flowM3PerS: point.pumpFlowM3PerS,
          shaftPowerW: point.shaftPowerW,
          flowSplit: point,
          ...(!point.matchesTargets ? { supplyBalanceIssue: '工作管稳态点未满足目标速度或压力预算。' } : {}),
        });
        continue phases;
      }
      const single = c.typeId === 'single-acting-cylinder';
      const springReturn = single && action.direction === 'reverse';
      if ((!single || springReturn) && action.returnPressurePa < tankPressure)
        return fail(phase.name + '：回油腔压力不能低于已保存回油箱压力，当前不支持回油负压/回馈工况。');
      const supply = single || action.direction === 'forward' ? 'A' : 'B',
        ret = supply === 'A' ? 'B' : 'A';
      const pumpPort = pump.id + ':P',
        tankPort = tank.id + ':T',
        aPort = c.id + ':A';
      const supplied = reachable(pumpPort, c.id + ':' + supply);
      if (
        !springReturn &&
        !logicValve &&
        !divider &&
        !protection &&
        (!supplied ||
          (single
            ? reachable(aPort, tankPort)
            : !reachable(c.id + ':' + ret, tankPort) || reachable(pumpPort, c.id + ':' + ret)))
      )
        return fail(phase.name + '：' + c.id + ' 的供回油方向与接线/工况阀位不符。' + cutoff);
      const inputPath = `/phases/${requestIndex}/actions/${actionIndex}/`;
      const prefix = 'phase' + index + ':' + c.id;
      const modelInputs: CalculationInput[] = [];
      let supplyLoss = action.supplyLossPa;
      let returnPressure = action.returnPressurePa;
      let p: number, q: number;
      let pumpFlow: number | undefined;
      let flowReference = prefix + ':flow';
      if (single) {
        const label = phase.name + ' / ' + c.label;
        const travel = dutyCylinderTravel(c, action.positionM, phase.name);
        if (!travel.ok) return travel;
        const { positionM } = travel.value;
        const area = c.parameters.geometry?.capAreaM2;
        const stiffness = c.parameters.mechanics?.returnSpringNPerM;
        const preload = c.parameters.mechanics?.returnPreloadN;
        if (area === undefined || stiffness === undefined || preload === undefined)
          return fail(label + ' 缺少 A 腔面积、弹簧刚度或预紧力。');
        const springForce = preload + stiffness * positionM;
        add(
          prefix + ':travel-position',
          label + ' 核算位置（自完全缩回端）',
          'model parameter',
          positionM,
          'm',
          [],
          1000,
          'mm',
        );
        add(prefix + ':spring-force', label + ' 当前点弹簧力', 'Fs=F0+k*x', springForce, 'N', [
          known('F0', preload, 'N', 'saved-parameter:' + c.id),
          known('k', stiffness, 'N/m', 'saved-parameter:' + c.id),
          known('x', positionM, 'm', 'user-requirement'),
        ]);
        if (springReturn) {
          const route = paths.path(aPort, tankPort);
          if (supplied || !route || route.some((arc) => paths.path(aPort, tankPort, arc)))
            return fail(label + ' 弹簧回程要求 A 口有唯一回油路径，且与泵出口隔离。');
          const internal = pump.parameters.relief;
          const protectedPump =
            (internal?.enabled === 1 &&
              internal.settingDifferentialPa !== undefined &&
              internal.settingDifferentialPa > 0) ||
            project.design.components.some(
              (part) =>
                part.typeId === 'relief' &&
                part.parameters.hydraulic?.settingDifferentialPa !== undefined &&
                paths.idealReachable(pumpPort, part.id + ':P') &&
                paths.idealReachable(part.id + ':T', tankPort),
            );
          if (!protectedPump) return fail(label + ' 回程时泵支路缺少可确认的内置或直连外置限压。');
          if (action.volumetricEfficiency !== 1)
            return fail(label + ' 回程排油量按扫掠体积计算，要求执行器容积效率为 1。');
          const [returnAccessory] = accessories;
          if (returnAccessory && Math.abs(action.returnPressurePa - tankPressure) > 1e-6)
            return fail(label + ' 附件回程的回油基准须取油箱压力，阀口与附件压降由软件计算。');
          const resisting = action.resistingLoad / action.mechanicalEfficiency;
          const modeled =
            returnAccessory &&
            springAccessoryPoint(project, route, returnAccessory, c, {
              area,
              springForce,
              resistingForce: resisting,
              targetSpeed: action.speed,
              tankPa: tankPressure,
            });
          if (modeled && !modeled.ok) return modeled;
          const actual = modeled?.value;
          const targetBackPressure = actual?.targetBackPressurePa ?? action.returnPressurePa;
          const margin = actual?.margin ?? springForce - targetBackPressure * area - resisting;
          const returnFlow = area * action.speed;
          if (purpose === 'sizing' && margin < 0) return fail(label + ' 弹簧回程力裕量不足，改变泵规格无法补足。');
          add(
            prefix + ':spring-return-flow',
            label + ' 目标速度对应的 A 腔排油量',
            'Qreturn=Aout*v',
            returnFlow,
            'm³/s',
            [
              known('Aout', area, 'm²', 'saved-parameter:' + c.id),
              known('speed', action.speed, 'm/s', sourceFor(inputPath + 'speed')),
            ],
            60000,
            'L/min',
          );
          add(
            prefix + ':spring-return-margin',
            label + ' 回程力裕量',
            actual ? 'Fmargin=Fs-pA*A-F/eta_m-c*v' : 'Fmargin=Fs-pA*A-F/eta_m',
            margin,
            'N',
            [
              known('Fspring', springForce, 'N', '弹簧力计算'),
              known(
                'returnPressure',
                targetBackPressure,
                'Pa',
                actual ? '目标点联立阀口及附件压降' : sourceFor(inputPath + 'returnPressurePa'),
              ),
              known('Ain', area, 'm²', 'saved-parameter:' + c.id),
              known('resistingLoad', action.resistingLoad, 'N', sourceFor(inputPath + 'resistingLoad')),
              known('eta_m', action.mechanicalEfficiency, '1', sourceFor(inputPath + 'mechanicalEfficiency')),
              ...(actual
                ? [known('c', actual.damping, 'N·s/m', '保存阻尼'), known('v', action.speed, 'm/s', '目标速度')]
                : []),
            ],
          );
          if (actual)
            for (const [key, title, value, unit, scale, displayUnit] of [
              ['flow', '实际回油量', actual.flow, 'm³/s', 60000, 'L/min'],
              ['speed', '实际回程速度', actual.speed, 'm/s', 1000, 'mm/s'],
              ['pressure', 'A 腔实际背压', actual.actualBackPressurePa, 'Pa', 1e-6, 'MPa'],
              ['valve-drop', '换向阀实际压降', actual.valveDropPa, 'Pa', 1e-3, 'kPa'],
              ['accessory-drop', actual.label + ' 实际压降', actual.accessoryDropPa, 'Pa', 1e-3, 'kPa'],
            ] as const)
              add(
                `${prefix}:spring-actual-${key}`,
                label + ' ' + title,
                '弹簧、阻力与回油压降稳态联立',
                value,
                unit,
                [],
                scale,
                displayUnit,
              );
          demands.push({
            name: phase.name,
            springReturn: {
              flowM3PerS: returnFlow,
              backPressurePa: targetBackPressure,
              forceMarginN: margin,
              ...(actual
                ? {
                    actual: {
                      flowM3PerS: actual.flow,
                      speedMPerS: actual.speed,
                      backPressurePa: actual.actualBackPressurePa,
                      targetSpeedMPerS: action.speed,
                    },
                  }
                : {}),
            },
          });
          continue phases;
        }
        if (
          hasAccessories &&
          paths.path(pumpPort, aPort)?.some((arc) => arc.component && dutyAccessoryTypes.has(arc.component.typeId))
        )
          return fail(label + ' 单作用缸附件限回油支路，伸出供油路串联附件待核。');
        p = (action.resistingLoad / action.mechanicalEfficiency + springForce) / area + supplyLoss;
        q = (area * action.speed) / action.volumetricEfficiency;
        modelInputs.push(
          known('Ain', area, 'm²', 'saved-parameter:' + c.id),
          known('Fspring', springForce, 'N', '弹簧力计算'),
        );
      } else if (cylinder) {
        if (dutyBufferedCylinderTypes.has(c.typeId)) {
          const travel = dutyCylinderTravel(c, action.positionM, phase.name);
          if (!travel.ok) return travel;
          const { positionM, lowerM, upperM } = travel.value;
          const label = phase.name + ' / ' + c.label;
          add(
            prefix + ':travel-position',
            label + ' 核算位置（自完全缩回端）',
            'model parameter',
            positionM,
            'm',
            [],
            1000,
            'mm',
          );
          add(prefix + ':travel-lower', label + ' 缓冲区外下界', 'model parameter', lowerM, 'm', [], 1000, 'mm');
          add(prefix + ':travel-upper', label + ' 缓冲区外上界', 'model parameter', upperM, 'm', [], 1000, 'mm');
        }
        const { areaA, areaB } = dutyCylinderAreas(c);
        const a = supply === 'A' ? areaA : areaB,
          b = supply === 'A' ? areaB : areaA;
        if (a === undefined || b === undefined) return fail('液压缸面积缺失。');
        modelInputs.push(
          known('Ain', a, 'm²', 'saved-parameter:' + c.id),
          known('Aout', b, 'm²', 'saved-parameter:' + c.id),
        );
        q = (a * action.speed) / action.volumetricEfficiency;
        const inlet = c.id + ':' + supply,
          outlet = c.id + ':' + ret;
        const returnPath = externalPilot ? paths.uniquePath(outlet, tankPort) : null;
        const yPort = externalPilot?.id + ':Y';
        const yAtTank = externalPilot && paths.idealReachable(yPort, tankPort);
        const yAtFilter = externalPilot && filter && paths.idealReachable(yPort, filter.id + ':A');
        const filterArc = filter ? (returnPath?.findIndex((arc) => arc.component?.id === filter.id) ?? -1) : -1;
        const needsReturnSolve =
          externalPilot &&
          (tanks.length > 1 ||
            !returnPath ||
            (!yAtTank && !yAtFilter) ||
            filters.length > 1 ||
            accessories.some((part) => part.typeId === 'flow-meter') ||
            returnPath.some(
              (arc, i) =>
                (arc.component &&
                  arc.component.id !== filter?.id &&
                  arc.component.id !== externalPilot.id &&
                  arc.component.typeId !== 'valve') ||
                (arc.physicalPipe && (yAtTank || i < filterArc)),
            ));
        const solved = needsReturnSolve
          ? solvePilotReturn(project, paths, {
              outlet,
              tankId: tank.id,
              tankPressurePa: tankPressure,
              valveId: externalPilot.id,
              flow: b * action.speed,
            })
          : undefined;
        if (solved && !solved.ok) return solved;
        if (solved && action.volumetricEfficiency !== 1)
          return fail(phase.name + '：回油分流按缸排油量核算，执行器容积效率须为 1。');
        const accessory =
          hasAccessories && !parallelReturnAccessories && !solved
            ? estimateDutyAccessories(project, phase, index, paths, {
                pumpId: pump.id,
                tankId: tank.id,
                inlet,
                outlet,
                inletFlow: q,
                outletArea: b,
                speed: action.speed,
                volumetricEfficiency: action.volumetricEfficiency,
              })
            : undefined;
        if (accessory && !accessory.ok) return accessory;
        const losses = accessory?.value;
        if (losses) {
          supplyLoss += losses.supplyLossPa;
          returnPressure += losses.returnLossPa;
          steps.push(...losses.steps);
        }
        let valveSupplyDropPa = 0;
        let returnPipeDropPa = 0;
        if (multiPortValve) {
          const valve = estimateDutyMultiPortValve(
            project,
            paths,
            {
              component: multiPortValve,
              ...(crossPilot ? { pilotPartner: multiPortValves[1] } : {}),
              phaseName: phase.name,
              phaseIndex: index,
              pumpId: pump.id,
              tankId: tank.id,
              inlet,
              outlet,
              tankPressurePa: tankPressure,
              baseReturnPa: action.returnPressurePa,
              baseReturnSource: sourceFor(inputPath + 'returnPressurePa'),
              // The only supported multi-port accessory is one return filter. Its drop carries the actual path ports.
              returnFilter: losses?.drops[0],
              ...(solved ? { solvedReturn: solved.value } : {}),
              supplyLossPa: supplyLoss,
              drivePressurePa: action.resistingLoad / action.mechanicalEfficiency / a,
              areaRatio: b / a,
              inletFlow: q,
              outletFlow: b * action.speed,
              actuatorEfficiency: action.volumetricEfficiency,
              density: project.design.fluid.densityKgPerM3,
              pumpFlow: available,
            },
            add,
          );
          if (!valve.ok) return valve;
          valveSupplyDropPa = valve.value.supplyDropPa;
          returnPipeDropPa = valve.value.returnPipeDropPa;
          supplyLoss += valveSupplyDropPa;
          returnPressure = valve.value.returnPressurePa;
          if (multiPortValve.typeId === 'three-way-flow-control') {
            pumpFlow = valve.value.pumpFlow;
            flowReference = 'phase' + index + ':' + multiPortValve.id + ':flow';
            supplyBalanceIssue = valve.value.supplyBalanceIssue;
          }
        }
        if (logicValve) {
          if (action.volumetricEfficiency !== 1 || Math.abs(action.returnPressurePa - tankPressure) > 1e-6)
            return fail(phase.name + '：通路判定要求缸容积效率为 1，回油基础压力取油箱压力。');
          const logic = estimateDutyLogicValve(
            paths,
            {
              component: logicValve,
              phase: phase.name,
              index,
              pumpPort,
              tankPort,
              inlet,
              outlet,
              tankPa: tankPressure,
              drivePa: action.resistingLoad / action.mechanicalEfficiency / a,
              areaRatio: b / a,
              supplyLossPa: supplyLoss,
              inletFlow: q,
              outletFlow: b * action.speed,
              density: project.design.fluid.densityKgPerM3,
              budgetPa: req.pressureLimitPa,
            },
            add,
          );
          if (!logic.ok) return logic;
          supplyLoss += logic.value.supplyDropPa;
          returnPressure += logic.value.returnDropPa;
        }
        if (protection) {
          const valve = valves[0];
          if (
            project.design.components.some(
              (part) =>
                part.typeId === 'relief' &&
                (paths.uniquePath(pumpPort, part.id + ':P')?.every((arc) => arc.ideal) !== true ||
                  paths.uniquePath(part.id + ':T', tankPort)?.every((arc) => arc.ideal) !== true),
            )
          )
            return fail(phase.name + '：主溢流阀须直接取泵出口并回同一油箱，工作口溢流由本批保护阀核算。');
          if (
            !valve ||
            action.volumetricEfficiency !== 1 ||
            supplyLoss !== 0 ||
            Math.abs(action.returnPressurePa - tankPressure) > 1e-6
          )
            return fail(phase.name + '：保护阀核算要求缸容积效率为 1，回油基准取油箱压力，其余供油压降填 0。');
          const result = estimateDutyProtection(
            project,
            paths,
            {
              component: protection,
              valve,
              phase: phase.name,
              index,
              pumpPort,
              tankPort,
              inlet,
              outlet,
              forward: supply === 'A',
              tankPa: tankPressure,
              drivePa: action.resistingLoad / action.mechanicalEfficiency / a,
              areaRatio: b / a,
              inletFlow: q,
              outletFlow: b * action.speed,
              density: project.design.fluid.densityKgPerM3,
              budgetPa: req.pressureLimitPa,
            },
            add,
          );
          if (!result.ok) return result;
          supplyLoss = result.value.supplyDropPa;
          returnPressure = result.value.returnPressurePa;
          pumpFlow = result.value.pumpFlow;
          if (pumpFlow !== undefined) flowReference = 'phase' + index + ':' + protection.id + ':pump-flow';
          const required = pumpFlow ?? q;
          if (purpose === 'check' && Math.abs(available - required) > 1e-8 * required)
            supplyBalanceIssue = '固定泵供流与本工况目标工作点不匹配。已列目标点需求，实际缸速与主泵溢流联立待核。';
        }
        if (phase.drainLeakM3PerS !== undefined && (!controlValve || !hasControlDrain(controlValve)))
          return fail('给定 Y 泄流需一只减压阀或顺序阀。');
        const drain =
          controlValve && hasControlDrain(controlValve)
            ? resolveControlDrain(project, paths, {
                component: controlValve,
                pump,
                tankId: tank.id,
                tankPa: tankPressure,
                outlet,
                returnBasePa: action.returnPressurePa,
                efficiency: action.volumetricEfficiency,
                returnFlow: b * action.speed,
                ...(phase.drainLeakM3PerS !== undefined ? { drainLeak: phase.drainLeakM3PerS } : {}),
                seriesDrops: losses?.drops ?? [],
              })
            : undefined;
        if (drain && !drain.ok) return drain;
        if (drain?.ok) {
          returnPipeDropPa = drain.value.pipeDropPa;
          returnPressure += returnPipeDropPa;
          if (phase.drainLeakM3PerS !== undefined) {
            pumpFlow = q + phase.drainLeakM3PerS;
            flowReference = 'phase' + index + ':pump-with-drain';
            add(flowReference, '阀 P 口所需总供流', 'Q缸+QY', pumpFlow, 'm³/s', [], 60000, 'L/min');
          }
          if (drain.value.coupled && purpose === 'check' && Math.abs(available - (pumpFlow ?? q)) > q * 1e-8)
            supplyBalanceIssue = '泵估计供流与目标缸流量不匹配。已列目标点需求，实际缸速及溢流分配待核。';
        }
        const chamberPressure = (action.resistingLoad / action.mechanicalEfficiency + returnPressure * b) / a;
        if (controlValve) {
          const valve = estimateSeriesControlValves(
            paths,
            {
              component: controlValve,
              phaseName: phase.name,
              phaseIndex: index,
              pumpId: pump.id,
              tankId: tank.id,
              actuatorInlet: inlet,
              actuatorOutlet: outlet,
              flowM3PerS: q,
              cylinderPressurePa: chamberPressure,
              downstreamLossPa: action.supplyLossPa,
              downstreamLossSource: sourceFor(inputPath + 'supplyLossPa'),
              seriesDrops: losses?.drops ?? [],
              tankPressurePa: tankPressure,
              ...(drain?.ok ? { drainBoundary: drain.value } : {}),
              budgetPa: req.pressureLimitPa,
              densityKgPerM3: project.design.fluid.densityKgPerM3,
            },
            controlValves,
          );
          if (!valve.ok) return valve;
          valveSupplyDropPa = valve.value.dropPa;
          supplyLoss += valveSupplyDropPa;
          if (valve.value.budgetIssue)
            supplyBalanceIssue = supplyBalanceIssue
              ? supplyBalanceIssue + ' ' + valve.value.budgetIssue
              : valve.value.budgetIssue;
          steps.push(...valve.value.steps);
        }
        p = chamberPressure + supplyLoss;
        if (losses) {
          steps.push(
            ...dutyPressureMeasurementSteps(
              project,
              phase,
              index,
              paths,
              controlValve
                ? [
                    ...losses.drops,
                    { from: controlValve.id + ':P', to: controlValve.id + ':A', dropPa: valveSupplyDropPa },
                  ]
                : losses.drops,
              new Map([
                [pump.id + ':P', p],
                [tank.id + ':T', tankPressure],
                [inlet, chamberPressure],
                [outlet, returnPressure],
              ]),
            ),
          );
        }
        if (losses?.supplyLossPa || losses?.returnLossPa || returnPipeDropPa) {
          const accessoryReturnDrop = losses?.returnLossPa ?? 0;
          const valveReturnDropPa = returnPressure - (action.returnPressurePa + accessoryReturnDrop + returnPipeDropPa);
          add(
            prefix + ':total-supply-loss',
            phase.name + ' / ' + c.label + ' 供油总压降',
            'sum=pBase+dpDevices',
            supplyLoss,
            'Pa',
            [
              known('pBase', action.supplyLossPa, 'Pa', sourceFor(inputPath + 'supplyLossPa')),
              known(
                'dpDevices',
                (losses?.supplyLossPa ?? 0) + valveSupplyDropPa,
                'Pa',
                valveSupplyDropPa ? '串联附件与阀本体压降' : '串联仪表压降',
              ),
            ],
            1e-3,
            'kPa',
          );
          add(
            prefix + ':total-return-pressure',
            phase.name + ' / ' + c.label + ' 回油腔总压力',
            'sum=pBase+dpDevices' + (returnPipeDropPa > 0 ? '+dpPipe' : '') + (valveReturnDropPa > 0 ? '+dpValve' : ''),
            returnPressure,
            'Pa',
            [
              known('pBase', action.returnPressurePa, 'Pa', sourceFor(inputPath + 'returnPressurePa')),
              known('dpDevices', accessoryReturnDrop, 'Pa', '串联回油元件压降'),
              ...(returnPipeDropPa > 0 ? [known('dpPipe', returnPipeDropPa, 'Pa', '已核算回油通路压降')] : []),
              ...(valveReturnDropPa > 0 ? [known('dpValve', valveReturnDropPa, 'Pa', '液控单向阀 B→A 压降')] : []),
            ],
            1e-3,
            'kPa',
          );
        }
      } else {
        const title = phase.name + ' / ' + (c.label || c.id);
        const display = (key: string, label: string, value: number, unit: string, scale = 1, displayUnit = unit) =>
          add(prefix + ':' + key, title + ' ' + label, '工况计算值', value, unit, [], scale, displayUnit);
        const swing = c.typeId === 'limited-rotary-actuator' ? dutyRotaryPoint(c, action, title) : undefined;
        if (swing && !swing.ok) return swing;
        const point = swing ? undefined : dutyMotorPoint(c, action, phase.name, boundary);
        if (point && !point.ok) return point;
        const d = swing ? 2 * Math.PI * swing.value.swept : point?.value.displacement;
        if (!d) return fail('旋转执行器排量缺失。');
        const viscous = swing?.value.viscousTorque ?? 0;
        if (swing) {
          const protection = c.parameters.workProtection;
          if (protection?.enabled === 1) {
            if (protection.reliefASettingPa === undefined || protection.reliefBSettingPa === undefined)
              return fail(title + '：内置溢流设定缺失。');
            const reference = c.parameters.protectionReturn?.internalTank === 1 ? '内置油箱' : 'T 口';
            display(
              'work-protection-a',
              'A 口相对' + reference + '的溢流设定',
              protection.reliefASettingPa,
              'Pa',
              1e-6,
              'MPa',
            );
            display(
              'work-protection-b',
              'B 口相对' + reference + '的溢流设定',
              protection.reliefBSettingPa,
              'Pa',
              1e-6,
              'MPa',
            );
          }
          display('angle', '核算摆角', swing.value.angle, 'rad', 180 / Math.PI, '°');
          display('travel', '最大摆角', swing.value.limit, 'rad', 180 / Math.PI, '°');
          display('viscous', '黏性阻矩', viscous, 'N·m');
          display('torque', '总阻性扭矩', action.resistingLoad + viscous, 'N·m');
          display('speed', '目标转速', action.speed, 'rad/s', 30 / Math.PI, 'r/min');
        } else if (c.definition.id === 'teaching:variable-motor' && point) {
          display('displacement', point.value.origin + '对应的实际排量', d, 'm³/rev', 1e6, 'cm³/rev');
          if (action.motorSetting) {
            const { kind, value } = action.motorSetting;
            const isPressure = kind === 'pilot' || kind === 'differential';
            display(
              'setting',
              point.value.origin + '给定',
              value,
              isPressure ? 'Pa' : kind === 'command' ? '%' : 'V',
              isPressure ? 1e-6 : 1,
              isPressure ? 'MPa' : kind === 'command' ? '%' : 'V',
            );
          }
          if (point.value.torque !== undefined) {
            display('torque', '给定压差下输出扭矩', point.value.torque, 'N·m');
            if (point.value.torque - action.resistingLoad > Math.max(1, action.resistingLoad) * 1e-6)
              supplyBalanceIssue = '给定压差的输出扭矩高于目标阻矩，目标转速的稳态平衡待核。';
          }
        }
        modelInputs.push(
          known(
            'D',
            d,
            'm³/rev',
            swing ? '保存每弧度排量换算' : action.motorSetting ? point?.value.origin : 'saved-parameter:' + c.id,
          ),
        );
        if (swing) modelInputs.push(known('Tviscous', viscous, 'N·m', '保存黏性阻力与给定转速'));
        if (point?.value.differential !== undefined)
          modelInputs.push(known('dpGiven', point.value.differential, 'Pa', '工况给定压差'));
        const dp =
          point?.value.differential ??
          (2 * Math.PI * (action.resistingLoad + viscous)) / (d * action.mechanicalEfficiency);
        p = dp + returnPressure + supplyLoss;
        q = (d * action.speed) / (2 * Math.PI * action.volumetricEfficiency);
      }
      const inputs = [
        known('speed', action.speed, cylinder ? 'm/s' : 'rad/s', sourceFor(inputPath + 'speed')),
        known('resistingLoad', action.resistingLoad, cylinder ? 'N' : 'N·m', sourceFor(inputPath + 'resistingLoad')),
        known(
          'supplyLoss',
          supplyLoss,
          'Pa',
          supplyLoss === action.supplyLossPa ? sourceFor(inputPath + 'supplyLossPa') : '含阀本体的供油总压降',
        ),
        known(
          'returnPressure',
          returnPressure,
          'Pa',
          returnPressure === action.returnPressurePa
            ? sourceFor(inputPath + 'returnPressurePa')
            : '含阀本体的回油腔总压力',
        ),
        known('eta_m', action.mechanicalEfficiency, '1', sourceFor(inputPath + 'mechanicalEfficiency')),
        known('eta_v', action.volumetricEfficiency, '1', sourceFor(inputPath + 'volumetricEfficiency')),
        ...modelInputs,
      ];
      add(
        prefix + ':pressure',
        phase.name + ' / ' + c.label + (phase.flowSplit ? ' 基础目标供油压力（未含分流阀口损失）' : ' 供油压力需求'),
        single
          ? 'p=(F/eta_m+Fs)/Ain+dpSupply'
          : cylinder
            ? 'p=(F/eta_m+pReturn*Aout)/Ain+dpSupply'
            : c.typeId === 'limited-rotary-actuator'
              ? 'p=2*pi*(T+Tviscous)/(D*eta_m)+pReturn+dpSupply'
              : action.motorSetting?.kind === 'differential'
                ? 'p=dpGiven+pReturn+dpSupply'
                : 'p=2*pi*T/(D*eta_m)+pReturn+dpSupply',
        p,
        'Pa',
        inputs,
        1e-6,
        'MPa',
      );
      add(
        prefix + ':flow',
        phase.name + ' / ' + c.label + ' 入口流量需求',
        cylinder ? 'Q=Ain*v/eta_v' : 'Q=D*omega/(2*pi*eta_v)',
        q,
        'm³/s',
        inputs,
        60000,
        'L/min',
      );
      pressure = Math.max(pressure, p);
      flow += pumpFlow ?? q;
      dependencies.push(
        known(prefix + ':pressure', p, 'Pa', 'preliminary-step'),
        known(flowReference, pumpFlow ?? q, 'm³/s', 'preliminary-step'),
      );
    }
    for (const c of project.design.components.filter((c) => isNetworkActuatorType(c.typeId)))
      if (
        !phase.actions.some((a) => a.componentId === c.id) &&
        (reachable(pump.id + ':P', c.id + ':A') || reachable(pump.id + ':P', c.id + ':B'))
      )
        return fail(phase.name + '：' + c.id + ' 接通供油但未列入动作，需求不完整。');
    for (const relief of project.design.components.filter((c) => c.typeId === 'relief'))
      if (reachable(pump.id + ':P', relief.id + ':P') && reachable(relief.id + ':T', tank.id + ':T')) {
        // The split solver checks both ports and reports the actual two-stage state.
        if (phase.flowSplit && relief.definition.id === 'teaching:pilot-relief') continue;
        if (
          (hasAccessories || controlValve || multiPortValve) &&
          (!paths.idealReachable(pump.id + ':P', relief.id + ':P') ||
            !paths.idealReachable(relief.id + ':T', tank.id + ':T'))
        )
          return fail(
            phase.name +
              '：外置溢流阀 ' +
              relief.id +
              ' 的取压或排油路径存在未分配压降，当前须直接取自泵出口并回油箱。',
          );
        const setting = relief.parameters.hydraulic?.settingDifferentialPa;
        if (setting === undefined) return fail('已连接溢流设定缺失。');
        reliefLimits.push({
          phase: phase.name,
          phaseIndex: index,
          componentId: relief.id,
          kind: 'external',
          returnPressurePa: tankPressure,
          differentialPa: setting,
        });
        if (pressure - tankPressure >= setting) {
          if (purpose === 'sizing')
            return fail(phase.name + '：需求达到/超过已连接溢流设定；不保证有限开口下的供油能力。');
          constraints.push({
            kind: 'relief-limit',
            phase: phase.name,
            componentId: relief.id,
            requiredPa: pressure - tankPressure,
            limitPa: setting,
          });
        }
      }
    if (pressure > req.pressureLimitPa) {
      if (purpose === 'sizing')
        return fail(
          `${phase.name}：供油压力需求${(pressure / 1e6).toPrecision(6)} MPa，超过预算${(req.pressureLimitPa / 1e6).toPrecision(6)} MPa，差${((pressure - req.pressureLimitPa) / 1e6).toPrecision(6)} MPa。`,
        );
      constraints.push({
        kind: 'pressure-budget',
        phase: phase.name,
        componentId: pump.id,
        requiredPa: pressure,
        limitPa: req.pressureLimitPa,
      });
    }
    if (pump.parameters.relief?.enabled === 1) {
      const setting = pump.parameters.relief.settingDifferentialPa;
      if (setting === undefined) return fail('泵内置溢流设定缺失。');
      reliefLimits.push({
        phase: phase.name,
        phaseIndex: index,
        componentId: pump.id,
        kind: 'internal',
        returnPressurePa: tankPressure,
        differentialPa: setting,
      });
      if (pressure - tankPressure >= setting) {
        if (purpose === 'sizing')
          return fail(
            phase.name +
              '：需求达到/超过泵内置溢流开启压差；本稳态初选不保证有限泄放下的供油能力，请调整设计并运行验证。',
          );
        constraints.push({
          kind: 'relief-limit',
          phase: phase.name,
          componentId: pump.id,
          requiredPa: pressure - tankPressure,
          limitPa: setting,
        });
      }
    }
    if (pressure < tankPressure) return fail(phase.name + '：需求低于回油基准，当前不支持负泵压差/回馈。');
    const supply = {
      pump,
      tank,
      tankPressurePa: tankPressure,
      flowM3PerS: available,
      totalEfficiency: req.totalEfficiency,
      pressureBudgetPa: req.pressureLimitPa,
    };
    const split = !phase.flowSplit
      ? undefined
      : divider
        ? solveDutyDivider(project, phase, paths, divider, supply)
        : solveParallelCylinderFlow(project, phase, supply);
    if (split && (split.kind === 'pending' || !split.matchesTargets))
      supplyBalanceIssue = split.kind === 'pending' ? '实际分流待核。' : '实际分流点未满足全部目标或供油预算。';
    if (split?.kind === 'solved') {
      for (const branch of split.branches) {
        const key = 'phase' + index + ':' + branch.componentId;
        const label = phase.name + ' / ' + branch.label;
        const { startPa, resistance } = branch;
        if (startPa !== undefined && resistance !== undefined)
          add(
            key + ':actual-flow',
            label + ' 实际分流',
            branch.closed ? '节流关闭' : 'q=sqrt(max(pP-p0,0)/K)',
            branch.flowM3PerS,
            'm³/s',
            branch.closed
              ? []
              : [
                  known(
                    'pP',
                    branch.valveInletPressurePa ?? split.pressurePa,
                    'Pa',
                    branch.valveInletPressurePa === undefined ? '稳态公共压力' : '本支路换向阀 P 口实际压力',
                  ),
                  known('p0', startPa, 'Pa', '本支路负载及回油背压'),
                  known('K', resistance, 'Pa·s²/m⁶', '本支路等效阀口系数'),
                ],
            60000,
            'L/min',
          );
        add(
          key + ':actual-speed',
          label + ' 实际缸速',
          'v=q/Ain',
          branch.speedMPerS,
          'm/s',
          [
            known('q', branch.flowM3PerS, 'm³/s', '实际分流'),
            known('Ain', branch.inletAreaM2, 'm²', 'saved-parameter:' + branch.componentId),
          ],
          1000,
          'mm/s',
        );
      }
    }
    const power = ((pressure - tankPressure) * flow) / req.totalEfficiency;
    if (range) {
      add(
        'phase' + index + ':pump-displacement',
        phase.name + (command === undefined ? ' 泵保存排量' : ' 泵指令 ' + command + '% 对应的实际排量'),
        '工况排量设定',
        phaseD,
        'm³/rev',
        [],
        1e6,
        'cm³/rev',
      );
      add(
        'phase' + index + ':pump-available',
        phase.name + ' 变量泵估计供流',
        'Qavailable=Dphase*(omega/(2*pi))*eta_v',
        phaseAvailable,
        'm³/s',
        [
          known('Dphase', phaseD, 'm³/rev'),
          known('omega', req.angularSpeedRadPerS, 'rad/s'),
          known('eta_v', req.pumpVolumetricEfficiency, '1'),
        ],
        60000,
        'L/min',
      );
    }
    add(
      'phase' + index + ':pressure',
      phase.name + (split ? ' 基础目标供油压力（未含实际分流阀口及干线压降）' : ' 共源压力'),
      'pSource=max(pBranch)',
      pressure,
      'Pa',
      dependencies,
      1e-6,
      'MPa',
    );
    add(
      'phase' + index + ':flow',
      phase.name +
        (protection?.typeId === 'shock-makeup-valve'
          ? ' 泵出口总流量（计入溢流及补油）'
          : multiPortValve?.typeId === 'three-way-flow-control'
            ? ' 泵出口总流量（含旁通）'
            : ' 同时流量'),
      'Qsource=sum(QBranch)，包含经核算的阀旁通流量',
      flow,
      'm³/s',
      dependencies,
      60000,
      'L/min',
    );
    add(
      'phase' + index + ':power',
      phase.name + (split ? ' 基础目标轴功率（未含分流阀口损失）' : ' 共源轴功率预算'),
      'P=(pSource-pTank)*Qsource/eta_total',
      power,
      'W',
      [
        known('pSource', pressure, 'Pa', 'preliminary-step'),
        known('Qsource', flow, 'm³/s', 'preliminary-step'),
        known('pTank', tankPressure, 'Pa', 'saved-parameter:' + tank.id),
        known('eta_total', req.totalEfficiency, '1', sourceFor('/totalEfficiency')),
      ],
      0.001,
      'kW',
    );
    demands.push({
      name: phase.name,
      pressurePa: pressure,
      flowM3PerS: flow,
      shaftPowerW: power,
      ...(range ? { availableFlowM3PerS: phaseAvailable } : {}),
      ...(supplyBalanceIssue ? { supplyBalanceIssue } : {}),
      ...(split ? { flowSplit: split } : {}),
    });
  }
  const driven = demands
    .filter(isDutySupplyDemand)
    .filter(
      (demand) =>
        !demand.pumpPressurePoint && !(demand.flowSplit?.kind === 'solved' && demand.flowSplit.workingSegments),
    );
  if (purpose === 'sizing' && !driven.length) return fail('本次只有弹簧回程，无需生成液压缸泵规格。');
  const maxFlow = Math.max(0, ...driven.map((d) => d.flowM3PerS)),
    displacement = driven.length
      ? maxFlow / ((req.angularSpeedRadPerS / (2 * Math.PI)) * req.pumpVolumetricEfficiency)
      : 0;
  if (
    purpose === 'sizing' &&
    multiPortValve?.typeId === 'three-way-flow-control' &&
    driven.some((d) => !threeWayDutyFlowMatches(maxFlow, d.flowM3PerS))
  )
    return fail('多个三通调速工况所需泵流量不同，同一转速下无法给出共同的定量泵排量。');
  const overall = demands.flatMap((d, i) =>
    isDutySupplyDemand(d) && driven.includes(d)
      ? [
          known('phase' + (i + phaseOffset) + ':flow', d.flowM3PerS, 'm³/s', 'preliminary-step'),
          known('phase' + (i + phaseOffset) + ':power', d.shaftPowerW, 'W', 'preliminary-step'),
        ]
      : [],
  );
  if (driven.length) {
    add(
      'pumpDisplacement',
      hasFlowSplit ? '仅按目标总流量估算的连续排量下限' : '连续排量最低需求（非产品型号）',
      'Dreq=max(Qphase)/[(omega/(2*pi))*eta_v]',
      displacement,
      'm³/rev',
      [
        ...overall,
        known('omega', req.angularSpeedRadPerS, 'rad/s', sourceFor('/angularSpeedRadPerS')),
        known('eta_v', req.pumpVolumetricEfficiency, '1', sourceFor('/pumpVolumetricEfficiency')),
      ],
      1e6,
      'cm³/rev',
    );
    add(
      'availableFlow',
      '原泵在要求转速下估计流量',
      'Qavailable=Dsaved*(omega/(2*pi))*eta_v',
      available,
      'm³/s',
      [
        known('Dsaved', beforeD, 'm³/rev', 'saved-parameter:' + pump.id),
        known('omega', req.angularSpeedRadPerS, 'rad/s', sourceFor('/angularSpeedRadPerS')),
        known('eta_v', req.pumpVolumetricEfficiency, '1', sourceFor('/pumpVolumetricEfficiency')),
      ],
      60000,
      'L/min',
    );
    add(
      'peakPower',
      hasFlowSplit ? '基础目标轴功率峰值（未含分流阀口损失）' : '各顺序工况的峰值轴功率',
      'Ppeak=max(Pphase)，不将不同时刻的最大压力/流量拼接',
      Math.max(...driven.map((d) => d.shaftPowerW)),
      'W',
      overall,
      0.001,
      'kW',
    );
  }
  if (steps.some((s) => s.value.kind === 'known' && !Number.isFinite(s.value.value)))
    return fail('计算超出有限数值范围。');
  const components: NetworkComponent[] = project.design.components.map((c) =>
    c.id !== pump.id
      ? c
      : {
          ...c,
          parameters: {
            ...c.parameters,
            hydraulic: { ...c.parameters.hydraulic, displacementM3PerRev: displacement },
            drive: { ...c.parameters.drive, angularSpeedRadPerS: req.angularSpeedRadPerS },
          },
        },
  );
  const candidate =
    purpose === 'check'
      ? { ok: true as const, value: project }
      : parseNetworkProject({ ...project, design: { ...project.design, components } });
  if (!candidate.ok) return candidate;
  const checkedRules = checkNetworkParameterRules(project, candidate.value);
  if (!checkedRules.ok) return checkedRules;
  return {
    ok: true,
    value: immutable({
      request: req,
      phases: demands,
      requiredDisplacementM3PerRev: displacement,
      availableFlowM3PerS: available,
      constraints,
      reliefLimits,
      changes:
        purpose === 'check'
          ? []
          : [
              {
                componentId: pump.id,
                parameter: 'hydraulic.displacementM3PerRev',
                before: beforeD,
                after: displacement,
              },
              {
                componentId: pump.id,
                parameter: 'drive.angularSpeedRadPerS',
                before: beforeSpeed,
                after: req.angularSpeedRadPerS,
              },
            ],
      document: candidate.value,
      record: {
        format: 'HydraulicLearningCalculation',
        version: 1,
        kind: 'preliminary',
        title: purpose === 'check' ? '按当前参数校核工况目标' : '共源同时/顺序工况需求与泵连续排量初选',
        document: project,
        identity: null,
        context: null,
        steps,
        ...(conditions ? { dutyConditions: conditions } : {}),
        assumptions: [
          '工况、阀位与全部显式输入（SI）: ' + JSON.stringify(req),
          ...(automaticSources.size
            ? [
                '本次使用教学自动配置 v1；它给出可覆盖的试算条件，不代表实际工况或完整仿真。',
                ...[...automaticSources].map(([path, source]) => '自动输入 ' + path + '：' + source),
              ]
            : []),
          '单泵、单一回油箱、稳态阻性负载；方向由工况阀位和真实接线核对。阀位为计算要求，不向运行发送控制。',
          '每个工况内部同时动作，各工况按顺序分别核算；全程不推算动作持续时间。',
          '使用保存的缸面积/马达排量；速度及负载为正幅值；不支持超越负载、加速惯性、回馈/差动、多泵分配或任意逻辑阀。',
          '供油沿程/局部损失与回油压力采用本次请求中的手动条件或上列自动假设；忽略管损时不代表实际压降为零。拓扑连通不能证明压降、流量分配或动态可达。',
          '所有压力采用工程保存的同一压力基准；回油腔压力不低于油箱。负载为要求的稳态总阻力/阻矩，需包括未由所列机械效率覆盖的摩擦，不自动取用或改写保存负载。',
          '效率为显式初选假设，未重算内核实际流量。原泵估计供给低于同时需求时存在共源竞争，需调整设计并仿真。',
          '共源按最高分支压力与同时需求流量估算轴功率，低压支路需节流调速，调速可行性仍待回路验证。',
          '只应用指定泵的连续排量与要求转速；不自动选择厂家规格、不改变负载/阀位/溢流设定；应用后须重新初始化。',
        ],
      },
    }),
  };
}
