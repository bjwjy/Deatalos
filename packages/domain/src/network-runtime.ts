import { checkJson, ContractReader, diagnostic, immutable } from './reader.js';
import {
  networkDefinition,
  networkDisplacementRange,
  networkDisplacementCommandRange,
  networkDisplacementValue,
  networkModelSetVersion,
  networkNativeStepAllowed,
} from './network-registry.js';
import { isTeachingActuatorType } from './network-actuators.js';
import { exactNetworkReferences, nullableNumber, parseNetworkProject, readPosition } from './network-project.js';
import { networkValvePositions } from './network-valve.js';
import type { Result } from './model.js';
import type {
  MeasurementLocation,
  NetworkControl,
  NetworkIdentity,
  NetworkProject,
  NetworkReading,
  NetworkSnapshot,
  NetworkState,
} from './network-model.js';
function control(r: ContractReader, value: unknown, field: string, project: NetworkProject): NetworkControl {
  const head = r.object(value, field, ['componentId', 'kind', 'positionId', 'areaM2', 'source', 'value']),
    componentId = r.id(head.componentId, `${field}/componentId`);
  const c = project.design.components.find((c) => c.id === componentId),
    def = c && networkDefinition(c.definition.id, c.definition.version);
  if (head.kind === 'displacement') {
    r.object(value, field, ['componentId', 'kind', 'source', 'value']);
    if (c?.motorDisplacementCurve?.enabled || c?.externalMotorControl)
      r.fail('CONTROL_INVALID', field, '此马达由压差曲线或外接端口给定。');
    const range = c && networkDisplacementCommandRange(c);
    if (def?.control !== 'displacement' || !range) r.fail('CONTROL_INVALID', field, '此实例没有变量排量控制。');
    const source = head.source === 'controller' || head.source === 'voltage' ? head.source : 'manual';
    r.constant(head.source, source, `${field}/source`);
    const min = source === 'manual' ? (range?.min ?? 0) : 0;
    const max = source === 'manual' ? (range?.max ?? 0) : source === 'voltage' ? 10 : 1;
    return { componentId, kind: 'displacement', source, value: r.number(head.value, `${field}/value`, min, max) };
  }
  if (head.kind === 'opening-area') {
    r.object(value, field, ['componentId', 'kind', 'areaM2']);
    if (def?.control !== 'opening-area') r.fail('CONTROL_INVALID', field, '此实例没有可调节流控制。');
    const maximum = c?.parameters.hydraulic?.maximumAreaM2 ?? 0;
    const areaM2 = r.number(head.areaM2, `${field}/areaM2`, 0, maximum);
    if (c?.typeId === 'manual-shutoff' && areaM2 !== 0 && areaM2 !== maximum)
      r.fail('CONTROL_INVALID', field + '/areaM2', '截止阀仅支持全开或关闭。');
    return {
      componentId,
      kind: 'opening-area',
      areaM2,
    };
  }
  r.object(value, field, ['componentId', 'kind', 'positionId']);
  r.constant(head.kind, 'position', `${field}/kind`);
  if (def?.control !== 'position') r.fail('CONTROL_INVALID', field, '此实例不是可控换向阀。');
  const positionId = readPosition(r, head.positionId, `${field}/positionId`);
  if (c && !networkValvePositions(c).includes(positionId))
    r.fail('CONTROL_INVALID', field + '/positionId', '此二位阀没有中位。');
  return {
    componentId,
    kind: 'position',
    positionId,
  };
}
function controls(
  r: ContractReader,
  value: unknown,
  field: string,
  project: NetworkProject,
  complete: boolean,
): readonly NetworkControl[] {
  const result = r.array(value, field, 30).map((v, i) => control(r, v, `${field}/${i}`, project));
  r.unique(
    result.map((c) => c.componentId),
    field,
  );
  if (complete)
    exactNetworkReferences(
      r,
      result.map((c) => c.componentId),
      project.design.components
        .filter(
          (c) =>
            !c.motorDisplacementCurve?.enabled &&
            !c.externalMotorControl &&
            networkDefinition(c.definition.id, c.definition.version)?.control !== 'none',
        )
        .map((c) => c.id),
      field,
    );
  return result;
}
export function initialNetworkControls(project: NetworkProject): readonly NetworkControl[] {
  const displacements = project.design.components.flatMap((c): NetworkControl[] => {
    const range = networkDisplacementCommandRange(c);
    return range ? [{ componentId: c.id, kind: 'displacement', source: 'manual', value: range.initial }] : [];
  });
  return immutable(
    project.design.initialConditions
      .flatMap((v): NetworkControl[] =>
        v.kind === 'valve'
          ? [
              {
                componentId: v.componentId,
                kind: 'position',
                positionId: v.positionId,
              },
            ]
          : v.kind === 'throttle'
            ? [
                {
                  componentId: v.componentId,
                  kind: 'opening-area',
                  areaM2: v.openingAreaM2,
                },
              ]
            : [],
      )
      .concat(displacements),
  );
}
/** Complete accepted-control set. Unlike a request patch, missing instances are rejected, never filled. */
export function parseNetworkControls(project: NetworkProject, input: unknown): Result<readonly NetworkControl[]> {
  const json = checkJson(input);
  if (!json.ok) return json;
  const reader = new ContractReader();
  return reader.finish(controls(reader, input, '/controls', project, true));
}
/** A validated partial command batch, without filling missing instances. */
export function parseNetworkControlBatch(project: NetworkProject, input: unknown): Result<readonly NetworkControl[]> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const reader = new ContractReader();
  return reader.finish(controls(reader, input, '/batch', project, false));
}
/** Validates an atomic command batch. It changes requests only, never state or results. */
export function requestNetworkControls(
  project: NetworkProject,
  current: unknown,
  batch: unknown,
): Result<readonly NetworkControl[]> {
  const safe = checkJson({
    current,
    batch,
  });
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    before = controls(r, current, '/requestedControls', project, true),
    changes = controls(r, batch, '/batch', project, false);
  return r.finish(before.map((c) => changes.find((v) => v.componentId === c.componentId) ?? c));
}
const quantityUnits = {
  pressure: 'Pa',
  'differential-pressure': 'Pa',
  'pressure-switch-state': '1',
  'control-voltage': 'V',
  'unloading-state': '1',
  'gas-pressure': 'Pa',
  'gas-volume': 'm³',
  'oil-volume': 'm³',
  'cavity-volume': 'm³',
  'compression-energy': 'J',
  flow: 'm³/s',
  'core-flow': 'm³/s',
  'makeup-flow': 'm³/s',
  'relief-flow': 'm³/s',
  force: 'N',
  torque: 'N·m',
  position: 'm',
  velocity: 'm/s',
  power: 'W',
  'angular-position': 'rad',
  'angular-velocity': 'rad/s',
  displacement: 'm³/rev',
} as const;
const isQuantity = (v: unknown): v is keyof typeof quantityUnits =>
  typeof v === 'string' && Object.hasOwn(quantityUnits, v);
const units = quantityUnits;
/** Seconds: retain the clock protocol's 10 ns absolute + 1e-12 relative budget.
 * Compare against host target time; preserve the recorded native time in results. */
function sameTimeS(actual: number, expected: number): boolean {
  return (
    Number.isFinite(actual) &&
    Number.isFinite(expected) &&
    Math.abs(actual - expected) <= 1e-8 + Math.abs(expected) * 1e-12
  );
}
export function parseNetworkSnapshot(
  project: NetworkProject,
  input: unknown,
  expected?: NetworkIdentity,
): Result<NetworkSnapshot> {
  const budget = checkJson(input);
  if (!budget.ok) return budget;
  const r = new ContractReader(),
    raw = r.object(input, '', [
      'identity',
      'clock',
      'solver',
      'source',
      'initialization',
      'appliedControls',
      'states',
      'readings',
      'diagnostics',
    ]);
  const id = r.object(raw.identity, '/identity', [
    'documentSessionId',
    'physicsRevision',
    'simulationSessionId',
    'tick',
    'timeS',
    'controlSequence',
    'requestSequence',
  ]);
  const integer = (key: string) => {
    const v = r.number(id[key], `/identity/${key}`, 0, Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(v)) r.fail('IDENTITY_INVALID', `/identity/${key}`, '序号必须是安全整数。');
    return v;
  };
  const identity: NetworkIdentity = {
    documentSessionId: r.id(id.documentSessionId, '/identity/documentSessionId'),
    physicsRevision: integer('physicsRevision'),
    simulationSessionId: r.id(id.simulationSessionId, '/identity/simulationSessionId'),
    tick: integer('tick'),
    timeS: r.number(id.timeS, '/identity/timeS', 0, 1e12),
    controlSequence: integer('controlSequence'),
    requestSequence: integer('requestSequence'),
  };
  const strictIdentityKeys = [
    'documentSessionId',
    'physicsRevision',
    'simulationSessionId',
    'tick',
    'controlSequence',
    'requestSequence',
  ] as const;
  if (
    expected &&
    (strictIdentityKeys.some((key) => identity[key] !== expected[key]) || !sameTimeS(identity.timeS, expected.timeS))
  ) {
    r.fail('RESPONSE_STALE', '/identity', '结果会话、修订、时间或控制序号不匹配。');
  }
  const clockRaw = r.object(raw.clock, '/clock', ['advanceIntervalS', 'nativeStepS']);
  const clock = {
    advanceIntervalS: r.number(clockRaw.advanceIntervalS, '/clock/advanceIntervalS', 1e-8, 1),
    nativeStepS: r.number(clockRaw.nativeStepS, '/clock/nativeStepS', 1e-9, 1),
  };
  if (clock.nativeStepS > clock.advanceIntervalS || !sameTimeS(identity.timeS, identity.tick * clock.advanceIntervalS))
    r.fail('CLOCK_INVALID', '/clock', '宿主推进时间与tick不一致，或原生步长大于推进区间。');
  r.constant(raw.source, 'kernel', '/source');
  const solverRaw = r.object(raw.solver, '/solver', ['id', 'version', 'modelSetVersion']);
  r.constant(solverRaw.id, project.provenance.preferredSolverId, '/solver/id', 'MODEL_UNSUPPORTED');
  const solver = {
    id: project.provenance.preferredSolverId,
    version: r.text(solverRaw.version, '/solver/version', 1, 100),
    modelSetVersion: r.text(solverRaw.modelSetVersion, '/solver/modelSetVersion', 1, 100),
  };
  r.constant(
    solver.version,
    solver.id === 'hopsan' ? '2.24.4.20260918.1254' : '1.0.0-experimental',
    '/solver/version',
    'MODEL_UNSUPPORTED',
  );
  r.constant(
    solver.modelSetVersion,
    solver.id === 'hopsan' ? networkModelSetVersion(project.design.components) : '1.0.0-experimental',
    '/solver/modelSetVersion',
    'MODEL_UNSUPPORTED',
  );
  if (
    solver.id === 'hopsan' &&
    (clock.advanceIntervalS !== 0.01 || !networkNativeStepAllowed(project.design.components, clock.nativeStepS))
  ) {
    r.fail('CLOCK_INVALID', '/clock', '须匹配10ms宿主区间及该模型集已验证的原生步长；不自动变更或重试。');
  }
  if (raw.initialization !== 'transient' && raw.initialization !== 'settled')
    r.fail('RESULT_INVALID', '/initialization', '必须明确初始化是否仍在过渡过程。');
  const appliedControls = controls(r, raw.appliedControls, '/appliedControls', project, true);
  const states: NetworkState[] = r.array(raw.states, '/states', 30).map((value, i) => {
    const f = `/states/${i}`,
      head = r.object(value, f, [
        'componentId',
        'kind',
        'positionM',
        'velocityMPerS',
        'angleRad',
        'angularSpeedRadPerS',
        'effectivePositionId',
        'spoolPositionM',
        'oilVolumeM3',
        'gasVolumeM3',
        'gasPressureAbsolutePa',
        'compressionEnergyJ',
      ]);
    const componentId = r.id(head.componentId, `${f}/componentId`),
      c = project.design.components.find((c) => c.id === componentId);
    if (!c || networkDefinition(c.definition.id, c.definition.version)?.initialKind !== head.kind)
      r.fail('STATE_INVALID', f, '状态引用实例或状态类型不匹配。');
    if (head.kind === 'cylinder') {
      const v = r.object(value, f, ['componentId', 'kind', 'positionM', 'velocityMPerS']);
      return {
        componentId,
        kind: 'cylinder',
        positionM:
          c && isTeachingActuatorType(c.typeId)
            ? r.number(v.positionM, `${f}/positionM`, 0, c.parameters.geometry?.strokeM ?? 0)
            : r.number(v.positionM, `${f}/positionM`, -1e6, 1e6),
        velocityMPerS: r.number(v.velocityMPerS, `${f}/velocityMPerS`, -1e6, 1e6),
      };
    }
    if (head.kind === 'accumulator') {
      const v = r.object(value, f, [
        'componentId',
        'kind',
        'oilVolumeM3',
        'gasVolumeM3',
        'gasPressureAbsolutePa',
        'compressionEnergyJ',
      ]);
      const total = c?.parameters.gas?.totalVolumeM3,
        fraction = c?.parameters.gas?.minimumGasFraction;
      if (total === undefined || fraction === undefined) r.fail('STATE_INVALID', f, '蓄能器气体参数缺失。');
      const oilVolumeM3 = r.number(
        v.oilVolumeM3,
        f + '/oilVolumeM3',
        0,
        total !== undefined && fraction !== undefined ? total * (1 - fraction) : 0,
      );
      const gasVolumeM3 = r.number(
        v.gasVolumeM3,
        f + '/gasVolumeM3',
        total !== undefined && fraction !== undefined ? total * fraction : 1e-12,
        total ?? 0,
      );
      if (total === undefined || Math.abs(oilVolumeM3 + gasVolumeM3 - total) > 1e-12 * total)
        r.fail('STATE_INVALID', f, '蓄能器气液容积必须守恒。');
      return {
        componentId,
        kind: 'accumulator',
        oilVolumeM3,
        gasVolumeM3,
        gasPressureAbsolutePa: r.number(v.gasPressureAbsolutePa, f + '/gasPressureAbsolutePa', 1, 20e6),
        compressionEnergyJ: r.number(v.compressionEnergyJ, f + '/compressionEnergyJ', 0, 1e10),
      };
    }
    if (head.kind === 'motor') {
      const v = r.object(value, f, ['componentId', 'kind', 'angleRad', 'angularSpeedRadPerS']);
      return {
        componentId,
        kind: 'motor',
        angleRad:
          c?.typeId === 'limited-rotary-actuator'
            ? r.number(v.angleRad, `${f}/angleRad`, 0, c.parameters.geometry?.angularTravelRad ?? 0)
            : r.number(v.angleRad, `${f}/angleRad`, -1e12, 1e12),
        angularSpeedRadPerS: r.number(v.angularSpeedRadPerS, `${f}/angularSpeedRadPerS`, -1e6, 1e6),
      };
    }
    const v = r.object(value, f, ['componentId', 'kind', 'effectivePositionId', 'spoolPositionM']);
    r.constant(v.kind, 'valve', `${f}/kind`);
    const effective =
      v.effectivePositionId === null ? null : readPosition(r, v.effectivePositionId, `${f}/effectivePositionId`);
    if (c && effective !== null && !networkValvePositions(c).includes(effective))
      r.fail('STATE_INVALID', f + '/effectivePositionId', '二位阀不能返回中位。');
    return {
      componentId,
      kind: 'valve',
      effectivePositionId: effective,
      spoolPositionM: r.number(v.spoolPositionM, `${f}/spoolPositionM`, -1, 1),
    };
  });
  exactNetworkReferences(
    r,
    states.map((s) => s.componentId),
    project.design.components
      .filter(
        (c) => isTeachingActuatorType(c.typeId) || ['cylinder', 'motor', 'valve', 'accumulator'].includes(c.typeId),
      )
      .map((c) => c.id),
    '/states',
  );
  const keys = new Set<string>();
  const displacementReadbacks = new Map<string, number>();
  const displacementTargets = new Set([
    ...appliedControls.filter((c) => c.kind === 'displacement').map((c) => c.componentId),
    ...project.design.components
      .filter((c) => c.motorDisplacementCurve?.enabled || c.externalMotorControl)
      .map((c) => c.id),
  ]);
  const readings: NetworkReading[] = r.array(raw.readings, '/readings', 500).map((value, i) => {
    const f = `/readings/${i}`,
      v = r.object(value, f, ['location', 'quantity', 'unit', 'value']);
    const head = r.object(v.location, `${f}/location`, ['kind', 'componentId', 'portId', 'nodeId', 'connectionId']);
    let location: MeasurementLocation;
    if (head.kind === 'node') {
      r.object(v.location, `${f}/location`, ['kind', 'nodeId']);
      const nodeId = r.id(head.nodeId, `${f}/location/nodeId`);
      if (!project.design.nodes.some((n) => n.id === nodeId)) r.fail('REFERENCE_INVALID', f, '量值引用未知节点。');
      location = {
        kind: 'node',
        nodeId,
      };
    } else if (head.kind === 'connection') {
      r.object(v.location, `${f}/location`, ['kind', 'connectionId']);
      const connectionId = r.id(head.connectionId, `${f}/location/connectionId`);
      if (!project.design.connections.some((c) => c.id === connectionId))
        r.fail('REFERENCE_INVALID', f, '量值引用未知连接。');
      location = {
        kind: 'connection',
        connectionId,
      };
    } else {
      const componentId = r.id(head.componentId, `${f}/location/componentId`),
        c = project.design.components.find((c) => c.id === componentId);
      if (!c) r.fail('REFERENCE_INVALID', f, '量值引用未知实例。');
      if (head.kind === 'port') {
        r.object(v.location, `${f}/location`, ['kind', 'componentId', 'portId']);
        const portId = r.text(head.portId, `${f}/location/portId`, 1, 16);
        if (!c || !networkDefinition(c.definition.id, c.definition.version)?.ports.some((p) => p.id === portId))
          r.fail('REFERENCE_INVALID', f, '量值引用未知油口。');
        location = {
          kind: 'port',
          componentId,
          portId,
        };
      } else {
        r.object(v.location, `${f}/location`, ['kind', 'componentId']);
        r.constant(head.kind, 'component', `${f}/location/kind`);
        location = {
          kind: 'component',
          componentId,
        };
      }
    }
    const quantity = isQuantity(v.quantity) ? v.quantity : 'pressure';
    if (!isQuantity(v.quantity)) r.fail('RESULT_INVALID', `${f}/quantity`, '未知量纲。');
    r.constant(v.unit, units[quantity], `${f}/unit`, 'UNIT_INVALID');
    const key = `${JSON.stringify(location)}:${quantity}`;
    if (keys.has(key)) r.fail('DUPLICATE_ID', f, '同一测量位置和量纲重复。');
    keys.add(key);
    const number = r.object(v.value, `${f}/value`, ['kind', 'value', 'reason']);
    if (quantity === 'displacement') {
      if (location.kind !== 'component' || !displacementTargets.has(location.componentId) || number.kind !== 'known')
        r.fail('NATIVE_CONTROL_MISMATCH', f, '排量回读须属于有效变量元件且必须已知。');
      else displacementReadbacks.set(location.componentId, r.number(number.value, `${f}/value/value`, 0, 0.01));
    }
    if (number.kind === 'unknown') {
      r.object(v.value, `${f}/value`, ['kind', 'reason']);
      return {
        location,
        quantity,
        unit: units[quantity],
        value: {
          kind: 'unknown',
          reason: r.text(number.reason, `${f}/value/reason`, 1, 200),
        },
      };
    }
    r.object(v.value, `${f}/value`, ['kind', 'value']);
    r.constant(number.kind, 'known', `${f}/value/kind`);
    return {
      location,
      quantity,
      unit: units[quantity],
      value: {
        kind: 'known',
        value: r.number(number.value, `${f}/value/value`, -1e15, 1e15),
      },
    };
  });
  for (const control of appliedControls) {
    if (control.kind !== 'displacement') continue;
    const component = project.design.components.find((c) => c.id === control.componentId);
    const range = component && networkDisplacementRange(component);
    const readback = displacementReadbacks.get(control.componentId);
    if (!range || readback === undefined || Math.abs(readback - networkDisplacementValue(range, control)) > 1e-14)
      r.fail('NATIVE_CONTROL_MISMATCH', '/readings', `元件 ${control.componentId} 的排量给定未获原生端口确认。`);
  }
  for (const component of project.design.components) {
    if (!component.motorDisplacementCurve?.enabled && !component.externalMotorControl) continue;
    const range = networkDisplacementRange(component);
    const actual = displacementReadbacks.get(component.id);
    if (!range || actual === undefined || actual < range.min - 1e-14 || actual > range.max + 1e-14)
      r.fail('NATIVE_CONTROL_MISMATCH', '/readings', `马达 ${component.id} 缺少有效的排量回读。`);
  }
  const diagnostics = r.array(raw.diagnostics, '/diagnostics', 100).map((d, i) => {
    const f = `/diagnostics/${i}`,
      v = r.object(d, f, ['code', 'severity', 'field', 'message', 'suggestion']);
    if (v.severity !== 'error' && v.severity !== 'warning' && v.severity !== 'info')
      r.fail('RESULT_INVALID', f, '诊断级别无效。');
    return {
      code: r.text(v.code, `${f}/code`, 1, 100),
      severity:
        v.severity === 'warning'
          ? ('warning' as const)
          : v.severity === 'info'
            ? ('info' as const)
            : ('error' as const),
      field: r.text(v.field, `${f}/field`, 1, 300),
      message: r.text(v.message, `${f}/message`, 1, 1000),
      suggestion: r.text(v.suggestion, `${f}/suggestion`, 1, 1000),
    };
  });
  if (diagnostics.some((d) => d.severity === 'error'))
    r.fail('RESULT_INVALID', '/diagnostics', '错误应作为失败Result返回，不能包装成当前成功快照。');
  return r.finish({
    identity,
    clock,
    solver,
    source: 'kernel',
    initialization: raw.initialization === 'settled' ? 'settled' : 'transient',
    appliedControls,
    states,
    readings,
    diagnostics,
  });
}
/** Gate-K evidence is scoped; no production graph compiler exists in E00B. */
export function networkCapabilities(input: unknown): Result<{
  readonly productionReady: false;
  readonly components: readonly {
    readonly componentId: string;
    readonly evidence: string;
    readonly modelId: string;
  }[];
  readonly diagnostics: readonly ReturnType<typeof diagnostic>[];
}> {
  const parsed = parseNetworkProject(input);
  if (!parsed.ok) return parsed;
  const components = parsed.value.design.components.map((c) => ({
    componentId: c.id,
    evidence: networkDefinition(c.definition.id, c.definition.version)?.evidence ?? 'unverified',
    modelId: c.model.id,
  }));
  return {
    ok: true,
    value: immutable({
      productionReady: false,
      components,
      diagnostics: [
        diagnostic(
          'GRAPH_MAPPING_UNVERIFIED',
          '/design',
          '领域定义不能认证具体图的执行能力；须由运行编译器校验模型、连接及支持域。内置油液容积须由版本化模型参数明确声明，不从拓扑猜值。',
        ),
      ],
    }),
  };
}
// Keep the nullable reader available at the domain boundary for future explicit state import.
export { nullableNumber };
