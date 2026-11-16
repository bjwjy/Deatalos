import { checkJson, ContractReader } from './reader.js';
import { limits, type Parameters, type Result } from './model.js';
import { networkDefinition, physicalPipeModel, physicalPipeParameters, type SIParameter } from './network-registry.js';
import { isTeachingActuatorType } from './network-actuators.js';
import { readMotorDisplacementCurve } from './motor-displacement-curve.js';
import type {
  ModelReference,
  NetworkComponent,
  NetworkConnection,
  NetworkEndpoint,
  NetworkInitial,
  NetworkProject,
  NetworkRoute,
} from './network-model.js';
import type { ValvePositionId } from './registry.js';
import { directionalValveSpec, directionalConfigurationValid, networkValvePositions } from './network-valve.js';
import { readValveActuation } from './network-valve-actuation.js';
import { readNetworkParameterRules } from './network-parameter-rules.js';
import { readNetworkSequence } from './network-sequence.js';
import { readNetworkProbes } from './network-probes.js';
import { readNetworkTexts } from './network-texts.js';
export function readSIParameters(
  r: ContractReader,
  input: unknown,
  list: readonly SIParameter[],
  field: string,
): Parameters {
  const raw = r.object(
    input,
    field,
    list.map((p) => p.key),
  );
  return Object.fromEntries(list.map((p) => [p.key, r.number(raw[p.key], `${field}/${p.key}`, p.minimum, p.maximum)]));
}
export function readPosition(r: ContractReader, input: unknown, field: string): ValvePositionId {
  if (input === 'extend' || input === 'neutral' || input === 'retract') return input;
  r.fail('CONTROL_INVALID', field, '未知阀位。');
  return 'neutral';
}
export function nullableNumber(
  r: ContractReader,
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | null {
  return value === null ? null : r.number(value, field, min, max);
}
export function readModel(r: ContractReader, value: unknown, field: string): ModelReference {
  const raw = r.object(value, field, ['id', 'version']);
  return {
    id: r.text(raw.id, `${field}/id`, 1, 100),
    version: r.text(raw.version, `${field}/version`, 1, 60),
  };
}
function component(r: ContractReader, value: unknown, field: string): NetworkComponent {
  const raw = r.object(value, field, [
    'id',
    'typeId',
    'definition',
    'model',
    'label',
    'parameters',
    'motorDisplacementCurve',
    'externalMotorControl',
    'pressureSwitchOutput',
    'valveActuation',
    'parameterRules',
    'controller',
    'controllerColor',
  ]);
  const ref = r.object(raw.definition, `${field}/definition`, ['id', 'version']);
  const id = r.text(ref.id, `${field}/definition/id`, 1, 100);
  const version = r.number(ref.version, `${field}/definition/version`, 1, 1e6);
  if (!Number.isSafeInteger(version)) r.fail('DEFINITION_UNSUPPORTED', field, '定义版本必须为整数。');
  const definition = networkDefinition(id, version);
  if (!definition) r.fail('DEFINITION_UNSUPPORTED', `${field}/definition`, '定义或定义版本未注册。');
  const typeId = r.text(raw.typeId, `${field}/typeId`, 1, 60);
  if (raw.controller !== undefined && definition?.role !== 'controller')
    r.fail('SEQUENCE_INVALID', field + '/controller', '只有动态控制器可以保存动作配置。');
  const valveActuation =
    raw.valveActuation === undefined ? undefined : readValveActuation(r, raw.valveActuation, field + '/valveActuation');
  if (valveActuation && typeId !== 'valve')
    r.fail('VALVE_ACTUATION_INVALID', field + '/valveActuation', '只有换向阀可配置两端驱动。');
  const model = readModel(r, raw.model, `${field}/model`);
  if (
    definition &&
    (definition.typeId !== typeId || definition.model.id !== model.id || definition.model.version !== model.version)
  )
    r.fail('MODEL_UNSUPPORTED', `${field}/model`, '类型、定义和模型版本不匹配；不能静默切换内核。');
  const groups = r.object(raw.parameters, `${field}/parameters`, Object.keys(definition?.groups ?? {}));
  const parameters = Object.fromEntries(
    Object.entries(definition?.groups ?? {}).map(([group, list]) => [
      group,
      readSIParameters(r, groups[group], list, `${field}/parameters/${group}`),
    ]),
  );
  const legacy = parameters.legacy;
  if (typeId === 'adjustable-pressure-switch' || typeId === 'pilot-unloading-valve') {
    const { tripPressurePa, resetPressurePa } = parameters.hydraulic ?? {};
    if (tripPressurePa !== undefined && resetPressurePa !== undefined && resetPressurePa >= tripPressurePa)
      r.fail('PARAMETER_INVALID', field + '/parameters/hydraulic/resetPressurePa', '复位压力必须低于动作压力。');
  }
  if (typeId === 'synchronizing-flow-divider') {
    const { correctionAreaM2, maximumAreaM2 } = parameters.hydraulic ?? {};
    if (correctionAreaM2 !== undefined && maximumAreaM2 !== undefined && correctionAreaM2 >= maximumAreaM2)
      r.fail('PARAMETER_INVALID', field + '/parameters/hydraulic/correctionAreaM2', '纠偏开口必须小于主通道开口。');
  }
  if (definition?.control === 'displacement') {
    const {
      displacementM3PerRev: initial,
      minimumDisplacementM3PerRev: min,
      maximumDisplacementM3PerRev: max,
    } = parameters.hydraulic ?? {};
    if (min === undefined || max === undefined || initial === undefined || min >= max || initial < min || initial > max)
      r.fail('PARAMETER_INVALID', field + '/parameters/hydraulic', '最小排量须小于最大排量，初始排量须在两者之间。');
  }
  const min = parameters.hydraulic?.minimumDisplacementM3PerRev;
  const max = parameters.hydraulic?.maximumDisplacementM3PerRev;
  const curveField = field + '/motorDisplacementCurve';
  const motorDisplacementCurve =
    raw.motorDisplacementCurve !== undefined &&
    id === 'teaching:variable-motor' &&
    min !== undefined &&
    max !== undefined
      ? readMotorDisplacementCurve(r, raw.motorDisplacementCurve, curveField, { min, max })
      : undefined;
  if (raw.motorDisplacementCurve !== undefined && !motorDisplacementCurve)
    r.fail('PARAMETER_INVALID', curveField, '只有变量液压马达可配置压差—排量曲线。');
  function controlRange(value: { lowPa?: unknown; highPa?: unknown }, path: string) {
    const lowPa = r.number(value.lowPa, path + '/lowPa', -1e8, 70e6);
    const highPa = r.number(value.highPa, path + '/highPa', -1e8, 70e6);
    if (highPa <= lowPa) r.fail('PARAMETER_INVALID', path, '控制压力上限必须高于下限。');
    return { lowPa, highPa };
  }
  const pressureSwitchOutput =
    raw.pressureSwitchOutput === undefined
      ? undefined
      : (() => {
          const path = field + '/pressureSwitchOutput';
          const output = r.object(raw.pressureSwitchOutput, path, ['mode', 'lowPa', 'highPa']);
          if (typeId !== 'adjustable-pressure-switch' || (output.mode !== 'analog' && output.mode !== 'switch'))
            r.fail('PARAMETER_INVALID', path, '压力开关输出模式必须为开关量或模拟量。');
          return {
            mode: output.mode === 'analog' ? ('analog' as const) : ('switch' as const),
            ...controlRange(output, path),
          };
        })();
  const externalMotorControl =
    raw.externalMotorControl === undefined
      ? undefined
      : (() => {
          const path = field + '/externalMotorControl';
          const control = r.object(raw.externalMotorControl, path, ['kind', 'lowPa', 'highPa']);
          if (id !== 'teaching:variable-motor' || motorDisplacementCurve?.enabled)
            r.fail('PARAMETER_INVALID', path, '外接给定只适用于未启用自身压差曲线的变量马达。');
          if (control.kind === 'pressure') return { kind: 'pressure' as const, ...controlRange(control, path) };
          r.constant(control.kind, 'voltage', path + '/kind');
          return control.lowPa === undefined && control.highPa === undefined
            ? { kind: 'voltage' as const }
            : { kind: 'voltage' as const, ...controlRange(control, path) };
        })();
  const directional = directionalValveSpec(id);
  if (directional && !directionalConfigurationValid(directional, parameters.positions, version))
    r.fail('VALVE_FUNCTION_UNSUPPORTED', field + '/parameters/positions', '所选机能与此阀的通数或定义版本不兼容。');
  if (parameters.relief && parameters.relief.enabled !== 0 && parameters.relief.enabled !== 1)
    r.fail('PARAMETER_INVALID', field + '/parameters/relief/enabled', '内置溢流开关只能为0或1。');
  if (parameters.workProtection && ![0, 1].includes(parameters.workProtection.enabled ?? NaN))
    r.fail('PARAMETER_INVALID', field + '/parameters/workProtection/enabled', '内置冲击溢流补油开关只能为0或1。');
  if (parameters.protectionReturn && ![0, 1].includes(parameters.protectionReturn.internalTank ?? NaN))
    r.fail(
      'PARAMETER_INVALID',
      field + '/parameters/protectionReturn/internalTank',
      '保护回油方式只能选内置油箱或外接 T 口。',
    );
  if (parameters.outletRelief && ![0, 1].includes(parameters.outletRelief.enabled ?? NaN))
    r.fail('PARAMETER_INVALID', field + '/parameters/outletRelief/enabled', '高压侧内置溢流开关只能为0或1。');
  if (typeId === 'cylinder' && legacy && (legacy.rodM ?? 0) >= (legacy.boreM ?? 0))
    r.fail('PARAMETER_INVALID', field, '杆径必须小于缸径。');
  if (typeId === 'pump' && legacy && (legacy.totalEfficiency ?? 0) > (legacy.volumetricEfficiency ?? 0))
    r.fail('PARAMETER_INVALID', field, '总效率不能大于容积效率。');
  const geometry = parameters.geometry;
  if (geometry && (geometry.rodSideAreaM2 ?? 0) > (geometry.capAreaM2 ?? 0))
    r.fail('PARAMETER_INVALID', field, '杆侧有效面积不能大于无杆腔面积。');
  if (typeId === 'cushioned-cylinder' && geometry?.rodSideAreaM2 === geometry?.capAreaM2)
    r.fail('PARAMETER_INVALID', field + '/parameters/geometry', '单杆缸的杆侧面积须小于无杆腔面积。');
  const cushion = parameters.cushion;
  if (cushion && (cushion.retractCushionLengthM ?? 0) + (cushion.extendCushionLengthM ?? 0) > (geometry?.strokeM ?? 0))
    r.fail('PARAMETER_INVALID', field + '/parameters/cushion', '两端缓冲长度之和不得超过总行程。');
  const spool = parameters.spool;
  if (
    spool &&
    ((spool.commandTravelM ?? 0) > (spool.maximumTravelM ?? 0) || (spool.overlapM ?? 0) >= (spool.commandTravelM ?? 0))
  )
    r.fail('PARAMETER_INVALID', field, '阀芯请求行程须大于重叠且不超过最大行程。');
  if (
    (definition?.id === 'teaching:valve-m' || definition?.id === 'teaching:custom-m') &&
    spool &&
    (spool.commandTravelM ?? 0) < (spool.maximumTravelM ?? 0) * (parameters.center?.openingFraction ?? 0)
  )
    r.fail('PARAMETER_INVALID', field, '固定M型完整换向行程必须关闭P-T中位卸荷口；不能把重叠通路当已验工作位。');
  if (id === 'teaching:custom-o' || id === 'teaching:custom-m') {
    const commands = ['extendFunction', 'neutralFunction', 'retractFunction'].map((key) => parameters.positions?.[key]);
    if (commands.some((value) => value !== -1 && value !== 0 && value !== 1) || new Set(commands).size !== 3)
      r.fail(
        'PARAMETER_INVALID',
        field + '/parameters/positions',
        '三位机能须分别选择正向、封闭/卸荷、反向，每种使用一次；当前不支持重复机能或任意通口。',
      );
  }
  const parameterRules = readNetworkParameterRules(r, raw.parameterRules, definition, field + '/parameterRules');
  return {
    id: r.id(raw.id, `${field}/id`),
    typeId,
    definition: {
      id,
      version,
    },
    model,
    label: r.text(raw.label, `${field}/label`, 0, 60),
    ...(valveActuation ? { valveActuation } : {}),
    ...(parameterRules === undefined ? {} : { parameterRules }),
    ...(raw.controller === undefined
      ? {}
      : { controller: readNetworkSequence(r, raw.controller, field + '/controller') }),
    parameters,
    ...(motorDisplacementCurve ? { motorDisplacementCurve } : {}),
    ...(externalMotorControl ? { externalMotorControl } : {}),
    ...(pressureSwitchOutput ? { pressureSwitchOutput } : {}),
    ...(raw.controllerColor === undefined
      ? {}
      : {
          controllerColor: (() => {
            const color = r.number(raw.controllerColor, field + '/controllerColor', 1, 30);
            if (definition?.role !== 'controller' || !Number.isInteger(color))
              r.fail('PROBE_INVALID', field, '只有控制器可保存整数颜色槽。');
            return color;
          })(),
        }),
  };
}
/** Reuses the exact project boundary for persisted component presets. */
export function parseNetworkComponent(input: unknown): Result<NetworkComponent> {
  const checked = checkJson(input);
  if (!checked.ok) return checked;
  const reader = new ContractReader();
  return reader.finish(component(reader, input, '/component'));
}
export function readNetworkEndpoint(
  r: ContractReader,
  value: unknown,
  field: string,
  components: readonly NetworkComponent[],
  nodes: readonly {
    readonly id: string;
  }[],
): NetworkEndpoint {
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'node') {
    const raw = r.object(value, field, ['kind', 'nodeId']);
    const nodeId = r.id(raw.nodeId, `${field}/nodeId`);
    if (!nodes.some((n) => n.id === nodeId)) r.fail('REFERENCE_INVALID', field, '理想节点不存在。');
    return {
      kind: 'node',
      nodeId,
    };
  }
  const raw = r.object(value, field, ['kind', 'componentId', 'portId']);
  r.constant(raw.kind, 'port', `${field}/kind`);
  const componentId = r.id(raw.componentId, `${field}/componentId`),
    portId = r.text(raw.portId, `${field}/portId`, 1, 16);
  const c = components.find((c) => c.id === componentId);
  if (!c || !networkDefinition(c.definition.id, c.definition.version)?.ports.some((p) => p.id === portId))
    r.fail('ENDPOINT_INVALID', field, '端点元件或油口不存在。');
  return {
    kind: 'port',
    componentId,
    portId,
  };
}
export function endpointKey(e: NetworkEndpoint): string {
  return e.kind === 'node' ? `node:${e.nodeId}` : `port:${e.componentId}:${e.portId}`;
}
export function exactNetworkReferences(
  r: ContractReader,
  actual: readonly string[],
  expected: readonly string[],
  field: string,
): void {
  r.unique(actual, field);
  if (actual.length !== expected.length || actual.some((id) => !expected.includes(id)))
    r.fail('REFERENCE_INVALID', field, '引用集合须一一对应，不能缺失、重复或引用其他对象。');
}
function initial(
  r: ContractReader,
  value: unknown,
  field: string,
  components: readonly NetworkComponent[],
): NetworkInitial {
  const head = r.object(value, field, [
    'componentId',
    'kind',
    'positionId',
    'positionM',
    'velocityMPerS',
    'capPressurePa',
    'rodPressurePa',
    'angleRad',
    'angularSpeedRadPerS',
    'openingAreaM2',
    'oilVolumeM3',
    'pressurePa',
  ]);
  const componentId = r.id(head.componentId, `${field}/componentId`),
    c = components.find((c) => c.id === componentId);
  const kind = networkDefinition(c?.definition.id ?? '', c?.definition.version ?? 0)?.initialKind;
  if (!c || head.kind !== kind || kind === 'none')
    r.fail('INITIAL_CONDITION_INVALID', field, '初态类别必须对应实例定义。');
  const read = (keys: readonly string[]) => r.object(value, field, ['componentId', 'kind', ...keys]);
  if (head.kind === 'cylinder') {
    const raw = read(['positionM', 'velocityMPerS', 'capPressurePa', 'rodPressurePa']);
    const limit = c?.parameters.geometry?.strokeM ?? c?.parameters.legacy?.strokeM ?? 0;
    const positionM = r.number(raw.positionM, `${field}/positionM`, 0, limit);
    const velocityMPerS = nullableNumber(r, raw.velocityMPerS, `${field}/velocityMPerS`, -1e4, 1e4);
    if (
      c &&
      isTeachingActuatorType(c.typeId) &&
      ((positionM === 0 && (velocityMPerS ?? 0) < 0) || (positionM === limit && (velocityMPerS ?? 0) > 0))
    )
      r.fail('INITIAL_CONDITION_INVALID', field + '/velocityMPerS', '限位处的初速度不能指向行程外。');
    if (c?.typeId === 'single-acting-cylinder' && raw.rodPressurePa !== null)
      r.fail('INITIAL_CONDITION_INVALID', field + '/rodPressurePa', '弹簧复位单作用缸没有杆侧液压初压。');
    return {
      componentId,
      kind: 'cylinder',
      positionM,
      velocityMPerS,
      capPressurePa: nullableNumber(r, raw.capPressurePa, `${field}/capPressurePa`, 0, 1e9),
      rodPressurePa: nullableNumber(r, raw.rodPressurePa, `${field}/rodPressurePa`, 0, 1e9),
    };
  }
  if (head.kind === 'motor') {
    const raw = read(['angleRad', 'angularSpeedRadPerS']);
    const limit = c?.parameters.geometry?.angularTravelRad;
    const angleRad = r.number(raw.angleRad, `${field}/angleRad`, limit === undefined ? -1e9 : 0, limit ?? 1e9);
    const angularSpeedRadPerS = nullableNumber(r, raw.angularSpeedRadPerS, `${field}/angularSpeedRadPerS`, -1e6, 1e6);
    if (
      limit !== undefined &&
      ((angleRad === 0 && (angularSpeedRadPerS ?? 0) < 0) || (angleRad === limit && (angularSpeedRadPerS ?? 0) > 0))
    )
      r.fail('INITIAL_CONDITION_INVALID', field + '/angularSpeedRadPerS', '限位处的初角速度不能指向摆角外。');
    return {
      componentId,
      kind: 'motor',
      angleRad,
      angularSpeedRadPerS,
    };
  }
  if (head.kind === 'accumulator') {
    const raw = read(['oilVolumeM3']);
    const total = c?.parameters.gas?.totalVolumeM3,
      fraction = c?.parameters.gas?.minimumGasFraction;
    if (total === undefined || fraction === undefined)
      r.fail('INITIAL_CONDITION_INVALID', field, '蓄能器气体参数缺失。');
    return {
      componentId,
      kind: 'accumulator',
      oilVolumeM3: r.number(
        raw.oilVolumeM3,
        field + '/oilVolumeM3',
        0,
        total !== undefined && fraction !== undefined ? total * (1 - fraction) : 0,
      ),
    };
  }
  if (head.kind === 'volume') {
    const raw = read(['pressurePa']);
    return {
      componentId,
      kind: 'volume',
      pressurePa: nullableNumber(r, raw.pressurePa, `${field}/pressurePa`, 0, 1e9),
    };
  }
  if (head.kind === 'throttle') {
    const raw = read(['openingAreaM2']);
    const maximum = c?.parameters.hydraulic?.maximumAreaM2 ?? 0;
    const openingAreaM2 = r.number(raw.openingAreaM2, `${field}/openingAreaM2`, 0, maximum);
    if (c?.typeId === 'manual-shutoff' && openingAreaM2 !== 0 && openingAreaM2 !== maximum)
      r.fail('CONTROL_INVALID', field + '/openingAreaM2', '截止阀初态必须是全开或关闭。');
    return {
      componentId,
      kind: 'throttle',
      openingAreaM2,
    };
  }
  const raw = read(['positionId']);
  const positionId = readPosition(r, raw.positionId, `${field}/positionId`);
  if (c && !networkValvePositions(c).includes(positionId))
    r.fail('CONTROL_INVALID', field + '/positionId', '此二位阀没有中位。');
  return {
    componentId,
    kind: 'valve',
    positionId,
  };
}
// Only this parser's deeply frozen output can be reused. New objects, including
// structured-cloned projects and shallow-frozen edits, still cross the full boundary.
const parsedProjects = new WeakMap<object, NetworkProject>();

export function parseNetworkProject(input: unknown): Result<NetworkProject> {
  if (input !== null && typeof input === 'object') {
    const parsed = parsedProjects.get(input);
    if (parsed) return { ok: true, value: parsed };
  }
  const checked = checkJson(input);
  if (!checked.ok) return checked;
  const r = new ContractReader(),
    raw = r.object(input, '', [
      'format',
      'version',
      'projectId',
      'title',
      'description',
      'note',
      'createdAt',
      'updatedAt',
      'design',
      'layout',
      'provenance',
      'extensions',
      'controlProbes',
    ]);
  r.constant(raw.format, 'HydraulicWorkbench', '/format');
  r.constant(raw.version, 3, '/version', 'VERSION_UNSUPPORTED');
  const d = r.object(raw.design, '/design', [
    'fluid',
    'pressureReference',
    'components',
    'nodes',
    'connections',
    'initialConditions',
  ]);
  const components = r
    .array(d.components, '/design/components', limits.components)
    .map((c, i) => component(r, c, `/design/components/${i}`));
  const curveTargets = new Set(
    components.filter((c) => c.motorDisplacementCurve?.enabled || c.externalMotorControl).map((c) => c.id),
  );
  for (const c of components) {
    if (c.controller?.steps.some((step) => step.commands.some((command) => curveTargets.has(command.componentId))))
      r.fail(
        'SEQUENCE_REFERENCE_INVALID',
        '/design/components/' + c.id + '/controller',
        '排量曲线或外接给定与控制器百分比不能同时控制同一马达。请先更改控制器目标。',
      );
  }
  r.unique(
    components.map((c) => c.id),
    '/design/components',
  );
  r.unique(
    components.flatMap((c) => (c.controllerColor === undefined ? [] : [String(c.controllerColor)])),
    '/design/components/controllerColor',
  );
  const nodes = r.array(d.nodes, '/design/nodes', 60).map((n, i) => {
    const f = `/design/nodes/${i}`,
      v = r.object(n, f, ['id', 'kind', 'label']);
    r.constant(v.kind, 'ideal-hydraulic', `${f}/kind`);
    return {
      id: r.id(v.id, `${f}/id`),
      kind: 'ideal-hydraulic' as const,
      label: r.text(v.label, `${f}/label`, 0, 60),
    };
  });
  r.unique(
    nodes.map((n) => n.id),
    '/design/nodes',
  );
  const idealPairs = new Set<string>();
  const signalInputs = new Set<string>();
  function signalPort(endpoint: NetworkEndpoint) {
    if (endpoint.kind !== 'port') return undefined;
    const component = components.find((c) => c.id === endpoint.componentId);
    const port =
      component &&
      networkDefinition(component.definition.id, component.definition.version)?.ports.find(
        (p) => p.id === endpoint.portId,
      );
    return port?.domain === 'signal' ? port : undefined;
  }
  const connections: NetworkConnection[] = r
    .array(d.connections, '/design/connections', limits.connections)
    .map((c, i) => {
      const f = `/design/connections/${i}`,
        head = r.object(c, f, ['id', 'kind', 'from', 'to', 'model', 'parameters']);
      const base = {
        id: r.id(head.id, `${f}/id`),
        from: readNetworkEndpoint(r, head.from, `${f}/from`, components, nodes),
        to: readNetworkEndpoint(r, head.to, `${f}/to`, components, nodes),
      };
      const a = endpointKey(base.from),
        b = endpointKey(base.to),
        pair = [a, b].sort().join('|');
      if (a === b) r.fail('ENDPOINT_INVALID', f, '不能连接同一端点。');
      const output = signalPort(base.from),
        input = signalPort(base.to);
      if (head.kind === 'signal') {
        r.object(c, f, ['id', 'kind', 'from', 'to']);
        if (output?.direction !== 'output' || input?.direction !== 'input' || signalInputs.has(b))
          r.fail('ENDPOINT_INVALID', f, '信号线须从 OUT 接到 U，且每个 U 只能有一个信号源。');
        signalInputs.add(b);
        return { ...base, kind: 'signal' };
      }
      if (output || input) r.fail('ENDPOINT_INVALID', f, '电压端口只能接信号线。');
      if (head.kind === 'pipe') {
        const model = readModel(r, head.model, `${f}/model`);
        if (model.id !== physicalPipeModel.id || model.version !== physicalPipeModel.version)
          r.fail('MODEL_UNSUPPORTED', `${f}/model`, '管路模型版本未注册。');
        return {
          ...base,
          kind: 'pipe',
          model,
          parameters: readSIParameters(r, head.parameters, physicalPipeParameters, `${f}/parameters`),
        };
      }
      r.object(c, f, ['id', 'kind', 'from', 'to']);
      r.constant(head.kind, 'ideal', `${f}/kind`);
      if (idealPairs.has(pair)) r.fail('ENDPOINT_INVALID', f, '理想连接重复。');
      idealPairs.add(pair);
      return {
        ...base,
        kind: 'ideal',
      };
    });
  r.unique(
    connections.map((c) => c.id),
    '/design/connections',
  );
  const initialConditions = r
    .array(d.initialConditions, '/design/initialConditions', limits.components)
    .map((v, i) => initial(r, v, `/design/initialConditions/${i}`, components));
  exactNetworkReferences(
    r,
    initialConditions.map((v) => v.componentId),
    components
      .filter((c) => networkDefinition(c.definition.id, c.definition.version)?.initialKind !== 'none')
      .map((c) => c.id),
    '/design/initialConditions',
  );
  const probes = raw.controlProbes === undefined ? undefined : readNetworkProbes(r, raw.controlProbes);
  for (const p of probes ?? [])
    if (
      p.controllerId !== null &&
      !components.some((c) => c.id === p.controllerId && c.typeId === 'dynamic-controller')
    )
      r.fail('PROBE_INVALID', '/controlProbes', '探针所属控制器不存在。');
  const l = r.object(raw.layout, '/layout', ['components', 'nodes', 'routes', 'viewport', 'probes', 'texts']);
  const texts = l.texts === undefined ? undefined : readNetworkTexts(r, l.texts);
  const probePositions =
    l.probes === undefined
      ? undefined
      : r.array(l.probes, '/layout/probes', 60).map((v, i) => {
          const f = '/layout/probes/' + i,
            p = r.object(v, f, ['probeId', 'x', 'y', 'signalPoints']);
          const signalPoints =
            p.signalPoints === undefined
              ? undefined
              : r.array(p.signalPoints, f + '/signalPoints', 64).map((raw, index) => {
                  const field = f + '/signalPoints/' + index;
                  const point = r.object(raw, field, ['x', 'y']);
                  return {
                    x: r.number(point.x, field + '/x', -limits.canvasCoordinate, limits.canvasCoordinate),
                    y: r.number(point.y, field + '/y', -limits.canvasCoordinate, limits.canvasCoordinate),
                  };
                });
          if (signalPoints?.length === 0)
            r.fail('LAYOUT_UNSUPPORTED', f + '/signalPoints', '手动信号线至少需要一个内部点。');
          return {
            probeId: r.id(p.probeId, f + '/probeId'),
            x: r.number(p.x, f + '/x', -limits.canvasCoordinate, limits.canvasCoordinate),
            y: r.number(p.y, f + '/y', -limits.canvasCoordinate, limits.canvasCoordinate),
            ...(signalPoints ? { signalPoints } : {}),
          };
        });
  exactNetworkReferences(
    r,
    (probePositions ?? []).map((p) => p.probeId),
    (probes ?? []).map((p) => p.id),
    '/layout/probes',
  );
  const readRotation = (value: unknown, field: string): 0 | 90 | 180 | 270 => {
    if (value === 0 || value === 90 || value === 180 || value === 270) return value;
    r.fail('LAYOUT_UNSUPPORTED', field, '绘图旋转只支持0、90、180、270度。');
    return 0;
  };
  const location = (v: unknown, f: string, key: 'componentId' | 'nodeId') => {
    const p = r.object(v, f, [key, 'x', 'y', ...(key === 'componentId' ? ['rotation', 'scale', 'mirrored'] : [])]);
    if (key === 'componentId' && p.mirrored !== undefined && p.mirrored !== true)
      r.fail('FILE_INVALID', f + '/mirrored', '镜像标记只允许 true，未翻转时省略。');
    return {
      ...(key === 'componentId' && p.scale !== undefined ? { scale: r.number(p.scale, `${f}/scale`, 0.5, 1.5) } : {}),
      ...(key === 'componentId' && p.mirrored === true ? { mirrored: true as const } : {}),
      id: r.id(p[key], `${f}/${key}`),
      x: r.number(p.x, `${f}/x`, -limits.canvasCoordinate, limits.canvasCoordinate),
      y: r.number(p.y, `${f}/y`, -limits.canvasCoordinate, limits.canvasCoordinate),
      ...(key === 'componentId' && p.rotation !== undefined
        ? { rotation: readRotation(p.rotation, `${f}/rotation`) }
        : {}),
    };
  };
  const positions = r.array(l.components, '/layout/components', limits.components).map((v, i) => {
    const p = location(v, `/layout/components/${i}`, 'componentId');
    return {
      componentId: p.id,
      ...(p.scale === undefined ? {} : { scale: p.scale }),
      ...(p.rotation === undefined ? {} : { rotation: p.rotation }),
      ...(p.mirrored === undefined ? {} : { mirrored: p.mirrored }),
      x: p.x,
      y: p.y,
    };
  });
  const nodePositions = r.array(l.nodes, '/layout/nodes', 60).map((v, i) => {
    const p = location(v, `/layout/nodes/${i}`, 'nodeId');
    return {
      nodeId: p.id,
      x: p.x,
      y: p.y,
    };
  });
  const routes: NetworkRoute[] = r.array(l.routes, '/layout/routes', limits.connections).map((v, i) => {
    const f = `/layout/routes/${i}`,
      p = r.object(v, f, ['connectionId', 'mode', 'points']);
    if (p.mode === 'manual') {
      const points = r.array(p.points, `${f}/points`, 64).map((value, index) => {
        const field = `${f}/points/${index}`,
          point = r.object(value, field, ['x', 'y']);
        return {
          x: r.number(point.x, `${field}/x`, -limits.canvasCoordinate, limits.canvasCoordinate),
          y: r.number(point.y, `${field}/y`, -limits.canvasCoordinate, limits.canvasCoordinate),
        };
      });
      if (!points.length) r.fail('LAYOUT_UNSUPPORTED', `${f}/points`, '手动路径至少需要一个内部点。');
      return { connectionId: r.id(p.connectionId, `${f}/connectionId`), mode: 'manual', points };
    }
    r.object(v, f, ['connectionId', 'mode']);
    if (p.mode !== 'auto' && p.mode !== 'avoid')
      r.fail('LAYOUT_UNSUPPORTED', `${f}/mode`, '绘图模式须为 auto、avoid 或 manual。');
    return {
      connectionId: r.id(p.connectionId, `${f}/connectionId`),
      mode: p.mode === 'avoid' ? ('avoid' as const) : ('auto' as const),
    };
  });
  const viewport =
    l.viewport === undefined
      ? undefined
      : (() => {
          const p = r.object(l.viewport, '/layout/viewport', ['centerX', 'centerY', 'zoom']);
          return {
            centerX: r.number(p.centerX, '/layout/viewport/centerX', -limits.canvasCoordinate, limits.canvasCoordinate),
            centerY: r.number(p.centerY, '/layout/viewport/centerY', -limits.canvasCoordinate, limits.canvasCoordinate),
            zoom: r.number(p.zoom, '/layout/viewport/zoom', 0.0001, 8),
          };
        })();
  exactNetworkReferences(
    r,
    positions.map((p) => p.componentId),
    components.map((c) => c.id),
    '/layout/components',
  );
  exactNetworkReferences(
    r,
    nodePositions.map((p) => p.nodeId),
    nodes.map((c) => c.id),
    '/layout/nodes',
  );
  exactNetworkReferences(
    r,
    routes.map((p) => p.connectionId),
    connections.map((c) => c.id),
    '/layout/routes',
  );
  const fluid = r.object(d.fluid, '/design/fluid', ['densityKgPerM3', 'kinematicViscosityM2PerS', 'bulkModulusPa']);
  const pressure = r.object(d.pressureReference, '/design/pressureReference', ['kind', 'absoluteReferencePa']);
  if (pressure.kind !== 'gauge' && pressure.kind !== 'kernel-numeric')
    r.fail('PARAMETER_INVALID', '/design/pressureReference/kind', '压力参考未声明。');
  const provenance = r.object(raw.provenance, '/provenance', ['createdWithAppVersion', 'preferredSolverId']);
  if (provenance.preferredSolverId !== 'legacy-basic' && provenance.preferredSolverId !== 'hopsan')
    r.fail('MODEL_UNSUPPORTED', '/provenance/preferredSolverId', '未知后端。');
  const parsed = r.finish<NetworkProject>({
    format: 'HydraulicWorkbench',
    version: 3,
    ...(probes === undefined ? {} : { controlProbes: probes }),
    projectId: r.id(raw.projectId, '/projectId'),
    title: r.text(raw.title, '/title', 1, 100),
    description: r.text(raw.description, '/description', 0, limits.note),
    ...(raw.note === undefined
      ? {}
      : {
          note: r.text(raw.note, '/note', 0, limits.note),
        }),
    createdAt: r.timestamp(raw.createdAt, '/createdAt'),
    updatedAt: r.timestamp(raw.updatedAt, '/updatedAt'),
    design: {
      components,
      nodes,
      connections,
      initialConditions,
      fluid: {
        densityKgPerM3: r.number(fluid.densityKgPerM3, '/design/fluid/densityKgPerM3', 400, 2000),
        kinematicViscosityM2PerS: r.number(
          fluid.kinematicViscosityM2PerS,
          '/design/fluid/kinematicViscosityM2PerS',
          1e-6,
          0.002,
        ),
        bulkModulusPa: nullableNumber(r, fluid.bulkModulusPa, '/design/fluid/bulkModulusPa', 1e5, 1e11),
      },
      pressureReference: {
        kind: pressure.kind === 'gauge' ? 'gauge' : 'kernel-numeric',
        absoluteReferencePa: nullableNumber(
          r,
          pressure.absoluteReferencePa,
          '/design/pressureReference/absoluteReferencePa',
          1,
          1e9,
        ),
      },
    },
    layout: {
      components: positions,
      nodes: nodePositions,
      routes,
      ...(probePositions === undefined ? {} : { probes: probePositions }),
      ...(texts === undefined ? {} : { texts }),
      ...(viewport ? { viewport } : {}),
    },
    provenance: {
      createdWithAppVersion: r.text(provenance.createdWithAppVersion, '/provenance/createdWithAppVersion', 1, 100),
      preferredSolverId: provenance.preferredSolverId === 'legacy-basic' ? 'legacy-basic' : 'hopsan',
    },
    extensions: r.extensions(raw.extensions, '/extensions'),
  });
  if (parsed.ok) parsedProjects.set(parsed.value, parsed.value);
  return parsed;
}
