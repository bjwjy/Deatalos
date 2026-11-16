import { checkJson, ContractReader, diagnostic, immutable } from './reader.js';
import type { Result } from './model.js';
import type { NetworkProject, NetworkControl } from './network-model.js';
import { networkDefinition } from './network-registry.js';
import { networkValvePositions } from './network-valve.js';
import type { ValvePositionId } from './registry.js';
import { networkProbeEndpoint, networkProbeName } from './network-probes.js';
import { isLinearActuatorType } from './network-actuators.js';

export type SequenceLeafCondition =
  | {
      readonly kind: 'pressure-switch';
      readonly componentId: string;
      readonly contact: 'open' | 'closed';
      readonly holdS: number;
    }
  | {
      readonly kind: 'probe-pressure';
      readonly probeId: string;
      readonly comparison: 'gte' | 'lte';
      readonly thresholdPa: number;
      readonly holdS: number;
    }
  | { readonly kind: 'time'; readonly durationS: number }
  | {
      readonly kind: 'flow';
      readonly componentId: string;
      readonly portId: string;
      readonly comparison: 'gte' | 'lte';
      readonly thresholdM3PerS: number;
      readonly holdS: number;
    }
  | {
      readonly kind: 'position';
      readonly componentId: string;
      readonly comparison: 'gte' | 'lte';
      readonly thresholdM: number;
      readonly holdS: number;
    }
  | {
      readonly kind: 'pressure';
      readonly componentId: string;
      readonly portId: string;
      readonly comparison: 'gte' | 'lte';
      readonly thresholdPa: number;
      readonly holdS: number;
    };
export type SequenceCondition =
  | SequenceLeafCondition
  | { readonly kind: 'all'; readonly conditions: readonly SequenceLeafCondition[] }
  | { readonly kind: 'any'; readonly conditions: readonly SequenceLeafCondition[] };
export interface NetworkSequenceStep {
  readonly id: string;
  readonly name: string;
  readonly commands: readonly SequenceCommand[];
  readonly until: SequenceCondition;
  readonly timeoutS: number;
}
type SequenceCommand =
  | Extract<NetworkControl, { kind: 'position' }>
  | {
      readonly componentId: string;
      readonly kind: 'displacement';
      readonly source: 'controller';
      readonly value: number;
    };
export interface NetworkSequence {
  readonly version: 1;
  readonly cycles: number;
  readonly steps: readonly NetworkSequenceStep[];
}
export interface SequenceRunView {
  readonly runId: string;
  readonly status: 'running' | 'paused' | 'completed' | 'stopped' | 'failed';
  readonly cycle: number;
  readonly cycles: number;
  readonly stepIndex: number;
  readonly stepName: string;
  readonly elapsedS: number;
  readonly condition: string;
  readonly message: string;
}
function readLeaf(r: ContractReader, input: unknown, p: string): SequenceLeafCondition {
  const c = r.object(input, p, [
    'kind',
    'durationS',
    'componentId',
    'portId',
    'comparison',
    'thresholdM',
    'thresholdPa',
    'thresholdM3PerS',
    'holdS',
    'probeId',
    'contact',
  ]);
  if (c.kind === 'time') {
    r.object(input, p, ['kind', 'durationS']);
    return { kind: 'time', durationS: r.number(c.durationS, p + '/durationS', 0.01, 3600) };
  }
  if (c.kind === 'pressure-switch') {
    r.object(input, p, ['kind', 'componentId', 'contact', 'holdS']);
    if (c.contact !== 'open' && c.contact !== 'closed')
      r.fail('SEQUENCE_INVALID', p + '/contact', '触点状态须为断开或闭合。');
    return {
      kind: 'pressure-switch',
      componentId: r.id(c.componentId, p + '/componentId'),
      contact: c.contact === 'closed' ? 'closed' : 'open',
      holdS: r.number(c.holdS, p + '/holdS', 0.01, 10),
    };
  }
  if (c.kind === 'probe-pressure') {
    r.object(input, p, ['kind', 'probeId', 'comparison', 'thresholdPa', 'holdS']);
    if (c.comparison !== 'gte' && c.comparison !== 'lte')
      r.fail('SEQUENCE_INVALID', p, '比较方式须为大于等于或小于等于。');
    return {
      kind: 'probe-pressure',
      probeId: r.id(c.probeId, p + '/probeId'),
      comparison: c.comparison === 'lte' ? 'lte' : 'gte',
      thresholdPa: r.number(c.thresholdPa, p + '/thresholdPa', -1e8, 1e9),
      holdS: r.number(c.holdS, p + '/holdS', 0.01, 10),
    };
  }
  if (c.kind !== 'position' && c.kind !== 'pressure' && c.kind !== 'flow')
    r.fail('SEQUENCE_INVALID', p + '/kind', '逻辑只接受时间、位置、压力、流量或压力开关触点条件。');
  r.object(input, p, [
    'kind',
    'componentId',
    'comparison',
    'holdS',
    ...(c.kind === 'position' ? ['thresholdM'] : ['portId', c.kind === 'flow' ? 'thresholdM3PerS' : 'thresholdPa']),
  ]);
  if (c.comparison !== 'gte' && c.comparison !== 'lte')
    r.fail('SEQUENCE_INVALID', p + '/comparison', '比较方式须为大于等于或小于等于。');
  const base = {
    componentId: r.id(c.componentId, p + '/componentId'),
    comparison: c.comparison === 'lte' ? ('lte' as const) : ('gte' as const),
    holdS: r.number(c.holdS, p + '/holdS', 0.01, 10),
  };
  if (c.kind === 'flow')
    return {
      ...base,
      kind: 'flow',
      portId: r.text(c.portId, p + '/portId', 1, 16),
      thresholdM3PerS: r.number(c.thresholdM3PerS, p + '/thresholdM3PerS', -10, 10),
    };
  return c.kind === 'position'
    ? { ...base, kind: 'position', thresholdM: r.number(c.thresholdM, p + '/thresholdM', 0, 100) }
    : {
        ...base,
        kind: 'pressure',
        portId: r.text(c.portId, p + '/portId', 1, 16),
        thresholdPa: r.number(c.thresholdPa, p + '/thresholdPa', -1e8, 1e9),
      };
}
/** Structural persistence permits temporarily missing references after component deletion; start validates them. */
export function readNetworkSequence(r: ContractReader, input: unknown, field = '/control/sequence'): NetworkSequence {
  const o = r.object(input, field, ['version', 'cycles', 'steps']);
  r.constant(o.version, 1, field + '/version');
  const cycles = r.number(o.cycles, field + '/cycles', 1, 100);
  if (!Number.isInteger(cycles)) r.fail('SEQUENCE_INVALID', field + '/cycles', '循环次数须为1至100的整数。');
  const steps = r.array(o.steps, field + '/steps', 50).map((item, i): NetworkSequenceStep => {
    const p = field + '/steps/' + i,
      s = r.object(item, p, ['id', 'name', 'commands', 'until', 'timeoutS']);
    const commands = r.array(s.commands, p + '/commands', 30).map((item, j): SequenceCommand => {
      const q = p + '/commands/' + j,
        c = r.object(item, q, ['componentId', 'kind', 'positionId', 'source', 'value']);
      const componentId = r.id(c.componentId, q + '/componentId');
      if (c.kind === 'displacement') {
        r.object(item, q, ['componentId', 'kind', 'source', 'value']);
        r.constant(c.source, 'controller', q + '/source');
        return {
          componentId,
          kind: 'displacement',
          source: 'controller',
          value: r.number(c.value, q + '/value', 0, 1),
        };
      }
      r.object(item, q, ['componentId', 'kind', 'positionId']);
      r.constant(c.kind, 'position', q + '/kind');
      const positionId: ValvePositionId =
        c.positionId === 'extend' || c.positionId === 'retract' ? c.positionId : 'neutral';
      if (!['extend', 'neutral', 'retract'].includes(String(c.positionId)))
        r.fail('SEQUENCE_INVALID', q, '步骤须指定已知阀位。');
      return { componentId, kind: 'position', positionId };
    });
    r.unique(
      commands.map((c) => c.componentId),
      p + '/commands',
    );
    const c = r.object(s.until, p + '/until', [
      'kind',
      'durationS',
      'componentId',
      'portId',
      'comparison',
      'thresholdM',
      'thresholdPa',
      'thresholdM3PerS',
      'holdS',
      'conditions',
      'probeId',
      'contact',
    ]);
    let until: SequenceCondition;
    if (c.kind === 'all' || c.kind === 'any') {
      r.object(s.until, p + '/until', ['kind', 'conditions']);
      const conditions = r
        .array(c.conditions, p + '/until/conditions', 8)
        .map((v, j) => readLeaf(r, v, p + '/until/conditions/' + j));
      if (!conditions.length) r.fail('SEQUENCE_INVALID', p + '/until/conditions', '逻辑至少需要一个条件。');
      until = { kind: c.kind, conditions };
    } else {
      until = readLeaf(r, s.until, p + '/until');
    }
    const timeoutS = r.number(s.timeoutS, p + '/timeoutS', 0.01, 3600);
    const leaves = until.kind === 'all' || until.kind === 'any' ? until.conditions : [until];
    if (leaves.some((c) => timeoutS < (c.kind === 'time' ? c.durationS : c.holdS)))
      r.fail('SEQUENCE_INVALID', p + '/timeoutS', '超时不能短于时间条件或连续满足时间。');
    return { id: r.id(s.id, p + '/id'), name: r.text(s.name, p + '/name', 1, 80), commands, until, timeoutS };
  });
  if (!steps.length) r.fail('SEQUENCE_INVALID', field + '/steps', '动作序列至少需要一步。');
  r.unique(
    steps.map((s) => s.id),
    field + '/steps',
  );
  return { version: 1, cycles, steps };
}
export function parseNetworkSequence(input: unknown): Result<NetworkSequence> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader();
  return r.finish(readNetworkSequence(r, input));
}
export function validateNetworkSequence(
  project: NetworkProject,
  input: unknown,
  _controllerId?: string,
): Result<NetworkSequence> {
  const parsed = parseNetworkSequence(input);
  if (!parsed.ok) return parsed;
  for (const step of parsed.value.steps) {
    const failure = (message: string): Result<never> => ({
      ok: false,
      diagnostics: [diagnostic('SEQUENCE_REFERENCE_INVALID', '/control/sequence/' + step.id, message)],
    });
    for (const command of step.commands) {
      const c = project.design.components.find((c) => c.id === command.componentId);
      if (command.kind === 'displacement') {
        if (c?.motorDisplacementCurve?.enabled || c?.externalMotorControl)
          return failure(step.name + '：目标马达已启用压差曲线或外接给定。');
        if (!c || networkDefinition(c.definition.id, c.definition.version)?.control !== 'displacement')
          return failure(step.name + '：排量给定须指向变量泵或变量液压马达。');
        continue;
      }
      if (
        !c ||
        networkDefinition(c.definition.id, c.definition.version)?.control !== 'position' ||
        !networkValvePositions(c).includes(command.positionId)
      )
        return failure(step.name + '：目标阀已删除或该阀位不受支持。');
    }
    for (const until of step.until.kind === 'all' || step.until.kind === 'any' ? step.until.conditions : [step.until]) {
      if (until.kind === 'time') continue;
      if (until.kind === 'probe-pressure') {
        const probe = project.controlProbes?.find((p) => p.id === until.probeId);
        if (!probe || !networkProbeEndpoint(project, probe))
          return failure(step.name + '：压力表已删除或未连接有效油口或节点。');
        continue;
      }
      const c = project.design.components.find((c) => c.id === until.componentId);
      if (!c) return failure(step.name + '：条件元件已删除。');
      if (
        until.kind === 'pressure-switch' &&
        (c.typeId !== 'adjustable-pressure-switch' ||
          c.pressureSwitchOutput?.mode === 'analog' ||
          !project.design.connections.some((e) =>
            [e.from, e.to].some((p) => p.kind === 'port' && p.componentId === c.id && p.portId === 'H'),
          ))
      )
        return failure(step.name + '：触点条件须引用已接油路并采用开关量的压力开关。');
      if (
        until.kind === 'position' &&
        (!isLinearActuatorType(c.typeId) || until.thresholdM > (c.parameters.geometry?.strokeM ?? -1))
      )
        return failure(step.name + '：位置条件须引用当前液压缸并位于其保存行程内。');
      if (
        (until.kind === 'pressure' || until.kind === 'flow') &&
        !networkDefinition(c.definition.id, c.definition.version)?.ports.some(
          (p) => p.id === until.portId && p.domain === 'hydraulic',
        )
      )
        return failure(step.name + '：压力或流量条件须引用当前液压油口。');
    }
  }
  return { ok: true, value: immutable(parsed.value) };
}
export function sequenceConditionText(c: SequenceCondition, project?: NetworkProject): string {
  if (c.kind === 'all' || c.kind === 'any')
    return c.conditions.map((c) => sequenceConditionText(c, project)).join(c.kind === 'all' ? ' 且 ' : ' 或 ');
  if (c.kind === 'time') return '仿真时间达到 ' + c.durationS + ' s';
  if (c.kind === 'pressure-switch') {
    const label = project?.design.components.find((item) => item.id === c.componentId)?.label ?? c.componentId;
    return label + (c.contact === 'closed' ? ' 触点闭合' : ' 触点断开') + '，连续 ' + c.holdS + ' s';
  }
  if (c.kind === 'probe-pressure') {
    const probe = project?.controlProbes?.find((p) => p.id === c.probeId);
    return (
      (project && probe ? networkProbeName(project, probe) : c.probeId) +
      (c.comparison === 'gte' ? ' ≥ ' : ' ≤ ') +
      c.thresholdPa / 1e6 +
      ' MPa，连续 ' +
      c.holdS +
      ' s'
    );
  }
  return (
    c.componentId +
    (c.kind !== 'position' ? ':' + c.portId : '') +
    ' ' +
    (c.comparison === 'gte' ? '≥' : '≤') +
    ' ' +
    (c.kind === 'pressure'
      ? c.thresholdPa / 1e6 + ' MPa表压'
      : c.kind === 'flow'
        ? c.thresholdM3PerS * 60000 + ' L/min（流入油口为正）'
        : c.thresholdM * 1000 + ' mm') +
    '，连续 ' +
    c.holdS +
    ' s'
  );
}
export function readSequenceRunView(r: ContractReader, input: unknown): SequenceRunView {
  const p = '/sequence',
    o = r.object(input, p, [
      'runId',
      'status',
      'cycle',
      'cycles',
      'stepIndex',
      'stepName',
      'elapsedS',
      'condition',
      'message',
    ]);
  const status = ['running', 'paused', 'completed', 'stopped', 'failed'].find((s) => s === o.status);
  if (!status) r.fail('SEQUENCE_INVALID', p + '/status', '未知序列状态。');
  const integer = (v: unknown, key: string, min: number, max: number) => {
    const n = r.number(v, p + '/' + key, min, max);
    if (!Number.isInteger(n)) r.fail('SEQUENCE_INVALID', p + '/' + key, '序号须为整数。');
    return n;
  };
  const cycle = integer(o.cycle, 'cycle', 1, 100),
    cycles = integer(o.cycles, 'cycles', 1, 100);
  if (cycle > cycles) r.fail('SEQUENCE_INVALID', p, '已运行循环数不能超过上限。');
  return {
    runId: r.id(o.runId, p + '/runId'),
    status:
      status === 'running' || status === 'paused' || status === 'completed' || status === 'stopped' ? status : 'failed',
    cycle,
    cycles,
    stepIndex: integer(o.stepIndex, 'stepIndex', 0, 49),
    stepName: r.text(o.stepName, p + '/stepName', 1, 80),
    elapsedS: r.number(o.elapsedS, p + '/elapsedS', 0, 1e12),
    condition: r.text(o.condition, p + '/condition', 0, 2000),
    message: r.text(o.message, p + '/message', 0, 1000),
  };
}
