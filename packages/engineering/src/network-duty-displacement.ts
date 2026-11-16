import {
  compileMotorDisplacementCurve,
  diagnostic,
  isNetworkActuatorType,
  networkDisplacementRange,
  networkDisplacementValue,
  sampleMotorDisplacementCurve,
  type NetworkComponent,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import { dutyPhasePaths } from './network-duty-accessories.js';
import type { DutyAction, NetworkDutyRequest } from './network-duty.js';

export type DutyMotorSetting = {
  readonly kind: 'command' | 'differential' | 'pilot' | 'voltage';
  readonly value: number;
};

export const rotaryDutyConditions = [
  '有限角度摆动执行器仅核算严格位于 0 和最大摆角之间的阻性稳态点。指定角度自零端起量。扭矩输入取外部阻性扭矩，按保存黏性阻力与转速另计内部阻矩。端位冲击、限位反力和往复循环另验。',
] as const;
export const displacementDutyConditions = [
  '变量泵及手动变量马达可逐工况指定 0–100% 排量指令，按保存最小和最大排量换算。未给定时使用保存排量。变量泵逐工况列估计供流和流量缺口。',
  '变量马达压差曲线使用明确给定的 A/B 压差，沿用保存的曲线和端点规则，并比较该点输出扭矩与目标。X 口和 U 口使用明确给定的先导压力或电压，分别与独立取压源或其模拟压力开关输出核对。',
  '核对目标点所需流量和估计供给能力。剩余流量去向、实际转速、控制器换步、负载敏感及瞬态另验。',
] as const;

function failure(reason: string, code = 'DUTY_UNSUPPORTED'): Result<never> {
  return { ok: false, diagnostics: [diagnostic(code, '/duty/displacement', reason)] };
}

export function dutyRotaryPoint(component: NetworkComponent, action: DutyAction, name: string) {
  const limit = component.parameters.geometry?.angularTravelRad;
  const swept = component.parameters.hydraulic?.sweptVolumeM3PerRad;
  const damping = component.parameters.mechanics?.viscousFrictionNmSPerRad;
  const angle = action.rotaryAngleRad;
  if (angle === undefined || !limit || !swept || damping === undefined)
    return failure(name + '：有限角度摆动执行器需给定核算角度、最大摆角、每弧度排量及黏性阻力。');
  if (angle < 0 || angle > limit + 1e-9) return failure(name + '：核算角度超出保存摆角范围。');
  if (angle <= 1e-9 || limit - angle <= 1e-9) {
    const toward = angle <= 1e-9 ? action.direction === 'reverse' : action.direction === 'forward';
    return failure(
      name + (toward ? '：目标方向受机械端位限制。' : '：从机械端位起动需另核算，稳态角度须位于行程内。'),
      toward ? 'DUTY_TARGET_BLOCKED' : 'DUTY_UNSUPPORTED',
    );
  }
  return { ok: true as const, value: { limit, angle, swept, viscousTorque: damping * action.speed } };
}

interface ControlBoundary {
  readonly motor: NetworkComponent;
  readonly ids: ReadonlySet<string>;
  readonly signal: number;
}

/** Only a zero-flow isolated pressure input may be exempted from the main hydraulic scope. */
export function dutyExternalMotorBoundary(
  project: NetworkProject,
  request: NetworkDutyRequest | null,
): ControlBoundary | undefined {
  const { components, connections } = project.design;
  const motor = components.find((part) => part.externalMotorControl);
  const mode = motor?.externalMotorControl?.kind;
  const kind = mode === 'pressure' ? 'pilot' : 'voltage';
  if (
    !motor ||
    !mode ||
    components.filter((part) => isNetworkActuatorType(part.typeId)).length !== 1 ||
    !request?.phases.some((phase) =>
      phase.actions.some((a) => a.componentId === motor.id && a.motorSetting?.kind === kind),
    )
  )
    return undefined;
  const sources = components.filter((part) => part.typeId === 'pressure-source');
  const source = sources[0];
  const pressure = source?.parameters.hydraulic?.pressurePa;
  if (!source || sources.length !== 1 || pressure === undefined || connections.some((edge) => edge.kind === 'pipe'))
    return undefined;
  const graph = dutyPhasePaths(project, { name: '马达控制边界', valves: [], actions: [] }, false);
  if (!graph.ok) return undefined;
  const paths = graph.value;
  const sourcePort = source.id + ':P';
  const switchPart = components.find(
    (part) => part.typeId === 'adjustable-pressure-switch' && paths.idealReachable(sourcePort, part.id + ':H'),
  );
  const signalEdges = connections.filter((edge) => edge.kind === 'signal');
  const target = mode === 'pressure' ? motor.id + ':X' : switchPart && switchPart.id + ':H';
  if (!target || paths.uniquePath(sourcePort, target)?.every((arc) => arc.ideal) !== true) return undefined;
  // Only the source, the non-consuming control port and an optional observer may share this oil node.
  const allowed = new Set([sourcePort, target, ...(switchPart ? [switchPart.id + ':H'] : [])]);
  for (const edge of connections)
    for (const end of [edge.from, edge.to]) {
      if (end.kind !== 'port') continue;
      const key = end.componentId + ':' + end.portId;
      if (!allowed.has(key) && paths.idealReachable(sourcePort, key)) return undefined;
    }
  if (mode === 'pressure')
    return signalEdges.length
      ? undefined
      : { motor, ids: new Set([source.id, ...(switchPart ? [switchPart.id] : [])]), signal: pressure };
  const output = switchPart?.pressureSwitchOutput;
  const edge = signalEdges[0];
  if (
    !switchPart ||
    output?.mode !== 'analog' ||
    signalEdges.length !== 1 ||
    edge?.from.kind !== 'port' ||
    edge.from.componentId !== switchPart.id ||
    edge.from.portId !== 'OUT' ||
    edge.to.kind !== 'port' ||
    edge.to.componentId !== motor.id ||
    edge.to.portId !== 'U'
  )
    return undefined;
  return {
    motor,
    ids: new Set([source.id, switchPart.id]),
    signal: 10 * fraction(pressure, output.lowPa, output.highPa),
  };
}

const fraction = (value: number, low: number, high: number) => Math.max(0, Math.min(1, (value - low) / (high - low)));

export function dutyMotorPoint(
  component: NetworkComponent,
  action: DutyAction,
  phase: string,
  boundary: ControlBoundary | undefined,
): Result<{
  readonly displacement: number;
  readonly origin: string;
  readonly differential?: number;
  readonly torque?: number;
}> {
  const input = action.motorSetting;
  const control = component.externalMotorControl;
  const curve = component.motorDisplacementCurve;
  const range = networkDisplacementRange(component);
  const name = phase + ' / ' + (component.label || component.id);
  const expected =
    control?.kind === 'pressure' ? 'pilot' : control ? 'voltage' : curve?.enabled ? 'differential' : 'command';
  if (!input) {
    const saved = component.parameters.hydraulic?.displacementM3PerRev;
    if (expected === 'command' && saved) return { ok: true, value: { displacement: saved, origin: '保存排量' } };
    return failure(name + '：缺少此工况的先导压力、电压或曲线压差给定。');
  }
  if (input.kind !== expected || !range) return failure(name + '：排量给定与此马达的保存控制来源不符。');
  const segments = curve ? compileMotorDisplacementCurve(curve, range).segments : undefined;
  const sample = (pressure: number) =>
    segments && sampleMotorDisplacementCurve(segments, pressure)?.displacementM3PerRev;
  if (input.kind === 'differential') {
    const d = sample(input.value);
    if (!d) return failure(name + '：无法读取保存的压差排量曲线。');
    const torque = ((input.value * d) / (2 * Math.PI)) * action.mechanicalEfficiency;
    if (action.resistingLoad - torque > Math.max(1, action.resistingLoad) * 1e-6)
      return failure(
        name +
          '：给定压差下输出扭矩 ' +
          torque.toPrecision(6) +
          ' N·m，低于目标 ' +
          action.resistingLoad +
          ' N·m。实际排量 ' +
          (d * 1e6).toPrecision(6) +
          ' cm³/rev。',
        'DUTY_TARGET_BLOCKED',
      );
    return { ok: true, value: { displacement: d, origin: '压差曲线', differential: input.value, torque } };
  }
  if (input.kind === 'command') {
    const displacement = networkDisplacementValue(range, {
      kind: 'displacement',
      componentId: component.id,
      source: 'controller',
      value: input.value / 100,
    });
    return { ok: true, value: { displacement, origin: '手动排量指令' } };
  }
  if (!boundary || boundary.motor.id !== component.id)
    return failure(name + '：仅支持独立压力源取压的 X 口或由该压力源驱动的单路模拟 U 口。');
  if (Math.abs(boundary.signal - input.value) > Math.max(1, Math.abs(boundary.signal)) * 1e-6)
    return failure(
      name +
        '：给定值与实际控制接线的计算值 ' +
        (input.kind === 'pilot'
          ? Number((boundary.signal / 1e6).toPrecision(6)) + ' MPa'
          : Number(boundary.signal.toPrecision(6)) + ' V') +
        ' 不一致。',
    );
  const f = control?.kind === 'pressure' ? fraction(input.value, control.lowPa, control.highPa) : input.value / 10;
  const low = control?.lowPa ?? 1e6;
  const high = control?.highPa ?? 5e6;
  const displacement = segments ? sample(low + f * (high - low)) : range.min + (range.max - range.min) * f;
  return displacement
    ? { ok: true, value: { displacement, origin: input.kind === 'pilot' ? 'X 口先导压力' : 'U 口电压' } }
    : failure(name + '：外接给定无法换算排量。');
}
