import { mapNetworkState } from './network-state-adapters.js';
import {
  checkJson,
  networkValveFunction,
  immutable,
  networkDefinition,
  isNetworkActuatorType,
  networkPortActive,
  networkDisplacementRange,
  networkDisplacementValue,
  parseNetworkSnapshot,
  requestNetworkControls,
  sampleMotorDisplacementCurve,
  type Diagnostic,
  type NetworkControl,
  type NetworkIdentity,
  type NetworkReading,
  type NetworkSnapshot,
  type NetworkState,
  type Result,
} from '@hyd/domain';
import { endpointKey, failure, portKey } from './network-graph.js';
import { nativeComponentId, type MappingPlan, type NativePort } from './hopsan-map.js';
import { readKey } from './kernel-values.js';
import { nativeId } from './hopsan-components.js';
import { networkPortPressureLimitPa } from './hopsan-types.js';

/** Batch preparation only. The research shell writes all signals before advance;
 * any native failure quarantines/discards that run, not partial successful ack. */
export function controlWrites(
  plan: MappingPlan,
  current: unknown,
  changes: unknown,
): Result<{
  readonly controls: readonly NetworkControl[];
  readonly writes: readonly { readonly ref: NativePort; readonly value: number }[];
}> {
  const next = requestNetworkControls(plan.graph.project, current, changes);
  if (!next.ok) return next;
  const writes = next.value.map((control) => {
    const binding = plan.controls.find((v) => v.componentId === control.componentId);
    if (!binding) throw new Error('Control binding missing');
    if (control.kind === 'opening-area') return { ref: binding.ref, value: control.areaM2 };
    const component = plan.graph.project.design.components.find((item) => item.id === control.componentId);
    if (!component) throw new Error('Control component missing');
    if (control.kind === 'displacement') {
      const range = networkDisplacementRange(component);
      if (!range || binding.readBack !== 'displacement') throw new Error('Displacement mapping missing');
      return { ref: binding.ref, value: networkDisplacementValue(range, control) };
    }
    if (binding.travelM === null) throw new Error('Valve command mapping missing');
    const value = networkValveFunction(component, control.positionId) * binding.travelM;
    return { ref: binding.ref, value };
  });
  return { ok: true, value: immutable({ controls: next.value, writes }) };
}

export function mappedSnapshot(
  plan: MappingPlan,
  input: unknown,
  expected: NetworkIdentity,
  applied: unknown,
): Result<NetworkSnapshot> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  if (
    !input ||
    typeof input !== 'object' ||
    !('nativeTimeS' in input) ||
    typeof input.nativeTimeS !== 'number' ||
    !Number.isFinite(input.nativeTimeS) ||
    !('values' in input) ||
    !input.values ||
    typeof input.values !== 'object' ||
    Array.isArray(input.values) ||
    !('identity' in input) ||
    !input.identity ||
    typeof input.identity !== 'object' ||
    Array.isArray(input.identity) ||
    Object.keys(input).some((k) => !['identity', 'nativeTimeS', 'values'].includes(k))
  ) {
    return failure('NATIVE_RESULT_INVALID', '/nativeFrame', '原生结果帧形状或时间无效。');
  }
  if (
    !('timeS' in input.identity) ||
    typeof input.identity.timeS !== 'number' ||
    !Number.isFinite(input.identity.timeS) ||
    Math.abs(input.identity.timeS - expected.timeS) > 1e-8 + Math.abs(expected.timeS) * 1e-12
  ) {
    return failure('RESPONSE_STALE', '/identity', '原生读取必须携带派发时捕获的身份，不能补入当前身份。');
  }
  const values = new Map<string, number>();
  for (const [key, value] of Object.entries(input.values)) {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return failure('NATIVE_RESULT_INVALID', '/nativeFrame/values', '原生值必须有限，缺失量不能补零。');
    values.set(key, value);
  }
  const controls = requestNetworkControls(plan.graph.project, applied, []);
  if (!controls.ok) return controls;
  const read = (ref: NativePort, variable: string): number | undefined => values.get(readKey(ref, variable));
  const portValues = new Map<string, { pressure: NetworkReading['value']; flow: NetworkReading['value'] }>();
  const known = (value: number): NetworkReading['value'] => ({ kind: 'known', value });
  const unknown = (reason: string): NetworkReading['value'] => ({ kind: 'unknown', reason });
  const domainErrors: Diagnostic[] = [];
  const cavityDiagnostics = new Map<string, Diagnostic>();
  const cavityVolumes = new Map<string, number>();
  for (const p of plan.ports) {
    const cavityKey = p.cavity ? readKey(p.cavity, 'Value') : undefined;
    if (p.cavity && cavityKey && !cavityVolumes.has(cavityKey)) {
      const volume = read(p.cavity, 'Value');
      if (volume === undefined || volume < 0)
        return failure('NATIVE_RESULT_INCOMPLETE', '/nativeFrame/values', '缺少有效的等效空穴体积。');
      cavityVolumes.set(cavityKey, volume);
      if (volume > 0)
        cavityDiagnostics.set(cavityKey, {
          code: 'OIL_CAVITY_ACTIVE',
          field: '/mapping/' + p.cavity.component + '/' + p.cavity.port,
          severity: 'warning',
          message: `当前供油不足，等效空穴体积为 ${volume} m³。补入的油量先填充空穴，随后才恢复升压。`,
          suggestion: '此结果适用于集总油液容积教学模型。实际空穴分布、蒸气压力和溃灭冲击需专用模型验证。',
        });
    }
    const pressures = p.pressure.map((ref) => read(ref, 'Pressure'));
    const flows = p.flow.map((v) => {
      const value = read(v.ref, 'Flow');
      return value === undefined ? undefined : v.sign * value;
    });
    if (!pressures.length || pressures.some((v) => v === undefined) || flows.some((v) => v === undefined))
      return failure('NATIVE_RESULT_INCOMPLETE', '/nativeFrame/values', '缺少端口的真实读数；未返回成功快照。');
    const ps = pressures.filter((v): v is number => v !== undefined),
      qs = flows.filter((v): v is number => v !== undefined);
    if (plan.modelSetVersion !== '0.1.0' || plan.options.lowPressureModel) {
      const outside = ps.find(
        (v) => v < 0 || (v === 0 && !p.cavity) || v - plan.pressureOffsetPa > networkPortPressureLimitPa,
      );
      if (outside !== undefined) {
        const terminal = plan.graph.nets.flatMap((net) => net.terminals).find((t) => t.key === p.key);
        const component = plan.graph.project.design.components.find((c) => c.id === terminal?.ownerId);
        const field =
          terminal?.kind === 'component'
            ? `/design/components/${terminal.ownerId}/${terminal.portId}`
            : terminal?.kind === 'pipe'
              ? `/design/connections/${terminal.ownerId}/${terminal.portId}`
              : '/nativeFrame';
        const object = component ? `${component.label || component.id} ${terminal?.portId ?? ''}口` : p.key;
        const reference = plan.graph.project.design.pressureReference;
        const basis =
          reference.kind === 'gauge'
            ? `表压，显式绝压参考${plan.pressureOffsetPa} Pa`
            : '内核数值压力，未声明物理绝压参考';
        const branch =
          outside <= 0 ? '原生压力≤0，超出非气蚀教学支持域' : '工程压力>70000000 Pa（70 MPa），超出压力上限';
        domainErrors.push({
          code: 'MODEL_DOMAIN_EXCEEDED',
          field,
          severity: 'error' as const,
          message: `${object}：${branch}。原生压力=${outside} Pa，工程压力=${outside - plan.pressureOffsetPa} Pa；基准：${basis}。拒绝帧t=${Number(input.nativeTimeS.toPrecision(12))} s，控制序号${expected.controlSequence}；此帧不是有效结果。`,
          suggestion:
            outside <= 0
              ? '核对压力基准及实际补油路径；马达惯性遇封闭中位或换向可能使吸油口供油不足。按真实回路配置补油，或使用支持该工况的模型后明确重新初始化；不会自动添加元件、改步长或续跑。'
              : '核对实际负载、限压与卸荷路径；修改工程副本后明确重新初始化，不截压力、不放宽70MPa保护。',
        });
      }
    }
    const scale = Math.max(1e5, ...ps.map(Math.abs));
    portValues.set(p.key, {
      pressure:
        Math.max(...ps) - Math.min(...ps) > 1e3 + 0.02 * scale
          ? unknown('PORT_PRESSURE_NOT_EQUALIZED')
          : known(ps.reduce((s, p) => s + p, 0) / ps.length - plan.pressureOffsetPa),
      flow: p.unknownFlow ? unknown(p.unknownFlow) : known(qs.reduce((s, q) => s + q, 0)),
    });
  }
  if (domainErrors.length) return { ok: false, diagnostics: domainErrors };
  const project = plan.graph.project,
    readings: NetworkReading[] = [],
    states: NetworkState[] = [];
  for (const control of controls.value) {
    if (control.kind !== 'displacement') continue;
    const binding = plan.controls.find((item) => item.componentId === control.componentId);
    const actual = binding?.readBack === 'displacement' ? read(binding.ref, 'Value') : undefined;
    if (actual === undefined)
      return failure('NATIVE_RESULT_INCOMPLETE', '/nativeFrame/values', '缺少原生排量端口回读。');
    readings.push({
      location: { kind: 'component', componentId: control.componentId },
      quantity: 'displacement',
      unit: 'm³/rev',
      value: known(actual),
    });
  }
  const supplyDiagnostics: Diagnostic[] = [];
  for (const motor of plan.motors) {
    const external = motor.externalDisplacement;
    if (external) {
      const voltage = read(external.voltage, 'Value'),
        actual = read(external.input, 'Value');
      if (voltage === undefined || voltage < 0 || voltage > 10 || actual === undefined)
        return failure('NATIVE_RESULT_INCOMPLETE', '/nativeFrame/values', '缺少外接马达的原生电压或排量。');
      const expected = external.minimum + ((external.maximum - external.minimum) * voltage) / 10;
      if (Math.abs(actual - expected) > Math.max(1e-14, Math.abs(expected) * 1e-9))
        return failure('NATIVE_CONTROL_MISMATCH', '/nativeFrame/values', '原生排量与外接给定不一致。');
      const location = { kind: 'component', componentId: motor.componentId } as const;
      readings.push(
        { location, quantity: 'control-voltage', unit: 'V', value: known(voltage) },
        { location, quantity: 'displacement', unit: 'm³/rev', value: known(actual) },
      );
      continue;
    }
    const curve = motor.displacementCurve;
    if (!curve) continue;
    const actual = read(curve.input, 'Value'),
      pressure = read(curve.pressure, 'Value');
    if (actual === undefined || pressure === undefined)
      return failure('NATIVE_RESULT_INCOMPLETE', '/nativeFrame/values', '缺少马达曲线的原生压差或排量回读。');
    const expected = sampleMotorDisplacementCurve(curve.segments, pressure);
    const tolerance = Math.max(1e-14, Math.abs(actual) * 1e-9);
    if (!expected || Math.abs(actual - expected.displacementM3PerRev) > tolerance)
      return failure('NATIVE_CONTROL_MISMATCH', '/nativeFrame/values', '原生马达排量与已保存曲线不一致。');
    if (curve.voltage) {
      const voltage = read(curve.voltage, 'Value');
      if (voltage === undefined || voltage < 0 || voltage > 10)
        return failure('NATIVE_RESULT_INCOMPLETE', '/nativeFrame/values', '缺少曲线使用的外接电压。');
      readings.push({
        location: { kind: 'component', componentId: motor.componentId },
        quantity: 'control-voltage',
        unit: 'V',
        value: known(voltage),
      });
    }
    readings.push({
      location: { kind: 'component', componentId: motor.componentId },
      quantity: 'displacement',
      unit: 'm³/rev',
      value: known(actual),
    });
  }
  for (const branch of plan.reliefBranches) {
    const flow = read(branch.ref, 'Flow');
    if (flow === undefined)
      return failure('NATIVE_RESULT_INCOMPLETE', '/nativeFrame/values', '缺少内置溢流真实流量，不补零。');
    readings.push({
      location: { kind: 'port', componentId: branch.componentId, portId: branch.portId ?? 'P' },
      quantity: 'relief-flow',
      unit: 'm³/s',
      value: known(-flow),
    });
    if (flow < 0)
      supplyDiagnostics.push({
        code: branch.portId === 'H' ? 'INTENSIFIER_OUTLET_RELIEF_OPEN' : 'INTERNAL_RELIEF_OPEN',
        severity: 'info',
        field: '/design/components/' + branch.componentId,
        message:
          branch.portId === 'H'
            ? '增压器内置溢流已开启，实际从 H 口向 R 口泄放。'
            : '泵内置溢流已开启，实际从P口向S口泄放。',
        suggestion:
          branch.portId === 'H'
            ? '按实际 H−R 压差和有限开口泄放。工作口瞬态低压需按回路复核。'
            : '开启压差以实际P−S压力为基准；有限开口仍有超调与容量限制。',
      });
  }
  for (const port of plan.integratedPorts) {
    const coreFlows = port.core.map((ref) => read(ref, 'Flow'));
    const makeupFlow = port.makeup ? read(port.makeup, 'Flow') : null;
    if (coreFlows.some((value) => value === undefined) || makeupFlow === undefined) {
      return failure(
        'NATIVE_RESULT_INCOMPLETE',
        '/nativeFrame/values',
        '缺少内置储油模型的核心/补油真实流量，不补零。',
      );
    }
    const location = { kind: 'port' as const, componentId: port.componentId, portId: port.portId };
    const coreFlow = coreFlows
      .filter((value): value is number => value !== undefined)
      .reduce((total, value) => total + value, 0);
    readings.push({ location, quantity: 'core-flow', unit: 'm³/s', value: known(-coreFlow) });
    if (makeupFlow !== null)
      readings.push({ location, quantity: 'makeup-flow', unit: 'm³/s', value: known(makeupFlow) });
    if (makeupFlow !== null && makeupFlow > 0)
      supplyDiagnostics.push({
        code: 'AUTOMATIC_MAKEUP_ACTIVE',
        severity: 'info',
        field: `/design/components/${port.componentId}/${port.portId}`,
        message: `${port.portId}口内置补油支路导通；本帧实际补油流量${makeupFlow} m³/s。`,
        suggestion: '补油流量与当前结果同源；模型含有限开口补油源，不代表已经模拟或验证气穴与复压过程。',
      });
  }
  const cavityPorts = new Map(
    plan.ports.flatMap((p) => (p.cavity ? [[p.key, readKey(p.cavity, 'Value')] as const] : [])),
  );
  for (const c of project.design.components) {
    if (c.typeId === 'shock-makeup-valve' || c.parameters.workProtection?.enabled === 1) {
      const component = c.typeId === 'shock-makeup-valve' ? nativeComponentId(c.id) : nativeId('workProtection', c.id);
      for (const portId of ['A', 'B']) {
        const relief = read({ component, port: `relief${portId}Flow` }, 'Value');
        const makeup = read({ component, port: `makeup${portId}Flow` }, 'Value');
        if (relief === undefined || makeup === undefined)
          return failure('NATIVE_RESULT_INCOMPLETE', '/nativeFrame/values', '缺少冲击溢流补油阀组的原生支路流量。');
        const location = { kind: 'port' as const, componentId: c.id, portId };
        readings.push({ location, quantity: 'relief-flow', unit: 'm³/s', value: known(relief) });
        readings.push({ location, quantity: 'makeup-flow', unit: 'm³/s', value: known(makeup) });
      }
    }
    for (const p of networkDefinition(c.definition.id, c.definition.version)?.ports ?? []) {
      if (p.domain !== 'hydraulic') continue;
      const value = portValues.get(portKey(c.id, p.id));
      if (!value && !networkPortActive(c, p.id)) continue;
      if (!value) throw new Error('Domain port missing');
      const location = { kind: 'port' as const, componentId: c.id, portId: p.id };
      readings.push(
        { location, quantity: 'pressure', unit: 'Pa', value: value.pressure },
        { location, quantity: 'flow', unit: 'm³/s', value: value.flow },
      );
      if (isNetworkActuatorType(c.typeId)) {
        const storage = cavityPorts.get(portKey(c.id, p.id));
        const volume = storage === undefined ? undefined : cavityVolumes.get(storage);
        if (volume !== undefined)
          readings.push({ location, quantity: 'cavity-volume', unit: 'm³', value: known(volume) });
      }
    }
    const state = mapNetworkState(c, { plan, read, states, readings });
    if (!state.ok) return state;
  }
  for (const net of plan.graph.nets) {
    const ps = net.terminals.map((p) => portValues.get(p.key)?.pressure);
    const numbers = ps.flatMap((v) => (v?.kind === 'known' ? [v.value] : []));
    const scale = Math.max(1e5, ...numbers.map(Math.abs));
    const pressure =
      numbers.length !== ps.length || Math.max(...numbers) - Math.min(...numbers) > 1e3 + 0.02 * scale
        ? unknown('IDEAL_NODE_NOT_EQUALIZED')
        : known(numbers.reduce((s, v) => s + v, 0) / numbers.length);
    for (const nodeId of net.nodeIds)
      readings.push({ location: { kind: 'node', nodeId }, quantity: 'pressure', unit: 'Pa', value: pressure });
  }
  const taps = new Set(
    project.design.components.flatMap((c) =>
      (c.typeId === 'differential-pressure-gauge'
        ? ['A', 'B']
        : c.typeId === 'adjustable-pressure-switch'
          ? ['H']
          : c.typeId === 'pilot-unloading-valve' || c.definition.id === 'teaching:variable-motor'
            ? ['X']
            : []
      ).map((portId) => endpointKey({ kind: 'port', componentId: c.id, portId })),
    ),
  );
  for (const edge of plan.graph.hydraulicConnections) {
    let flow: NetworkReading['value'];
    const tap =
      edge.kind === 'ideal' &&
      [edge.to, edge.from].find(
        (end) =>
          end.kind === 'port' &&
          taps.has(endpointKey(end)) &&
          !plan.graph.hydraulicConnections.some(
            (other) =>
              other.id !== edge.id && [other.from, other.to].some((peer) => endpointKey(peer) === endpointKey(end)),
          ),
      );
    const tapFlow = tap ? portValues.get(endpointKey(tap))?.flow : undefined;
    if (edge.kind === 'pipe') {
      const ref = { component: 'pipe_' + [...edge.id].map((c) => c.charCodeAt(0).toString(16)).join(''), port: 'P1' };
      const native = read(ref, 'Flow');
      if (native === undefined) return failure('NATIVE_RESULT_INCOMPLETE', '/readings', '缺少物理管路流量。');
      const diameter = edge.parameters.internalDiameterM;
      if (diameter === undefined) throw new Error('Pipe diameter missing');
      const re = (4 * Math.abs(native)) / (Math.PI * diameter * project.design.fluid.kinematicViscosityM2PerS);
      if (re >= 2000)
        return failure(
          'MODEL_DOMAIN_EXCEEDED',
          `/design/connections/${edge.id}`,
          '层流管模型越出Re<2000支持域；不按层流冒充湍流。',
        );
      flow = known(-native);
    } else if (tapFlow?.kind === 'known') {
      // A dedicated gauge lead has the measured terminal flow. Using the
      // opposite side of the net could include numerical compliance flow.
      flow = known(tap === edge.to ? tapFlow.value : -tapFlow.value);
    } else {
      const a = endpointKey(edge.from),
        b = endpointKey(edge.to),
        reached = new Set([b]);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const other of project.design.connections)
          if (other.kind === 'ideal' && other.id !== edge.id) {
            const x = endpointKey(other.from),
              y = endpointKey(other.to);
            if (reached.has(x) && !reached.has(y)) {
              reached.add(y);
              expanded = true;
            }
            if (reached.has(y) && !reached.has(x)) {
              reached.add(x);
              expanded = true;
            }
          }
      }
      const net = plan.graph.nets.find((n) => n.connectionIds.includes(edge.id));
      if (!net) throw new Error('Edge net missing');
      const demands = net.terminals.map((p) => {
        const pipe = p.kind === 'pipe' ? project.design.connections.find((e) => e.id === p.ownerId) : undefined;
        const key = pipe ? endpointKey(p.portId === 'A' ? pipe.from : pipe.to) : p.key;
        return { key, value: portValues.get(p.key)?.flow };
      });
      const numbers = demands.flatMap((v) => (v.value?.kind === 'known' ? [v.value.value] : []));
      const residual = Math.abs(numbers.reduce((s, v) => s + v, 0)),
        scale = Math.max(1e-8, ...numbers.map(Math.abs));
      flow = reached.has(a)
        ? unknown('IDEAL_CYCLE_FLOW_UNDETERMINED')
        : numbers.length !== demands.length
          ? unknown('TERMINAL_FLOW_UNKNOWN')
          : residual > 1e-9 + 0.02 * scale
            ? unknown('NUMERICAL_STORAGE_NOT_BALANCED')
            : known(
                demands.reduce((s, d) => s + (reached.has(d.key) && d.value?.kind === 'known' ? d.value.value : 0), 0),
              );
    }
    readings.push({
      location: { kind: 'connection', connectionId: edge.id },
      quantity: 'flow',
      unit: 'm³/s',
      value: flow,
    });
  }
  // No internal residual is invented; initialization remains transient unless a
  // separate convergence certificate exists. Domain parser also checks identity.
  return parseNetworkSnapshot(
    project,
    {
      identity: { ...input.identity, timeS: input.nativeTimeS },
      clock: { advanceIntervalS: 0.01, nativeStepS: plan.options.nativeStepS },
      solver: { id: 'hopsan', version: '2.24.4.20260918.1254', modelSetVersion: plan.modelSetVersion },
      source: 'kernel',
      initialization: 'transient',
      appliedControls: controls.value,
      states,
      readings,
      diagnostics: [...plan.diagnostics, ...supplyDiagnostics, ...cavityDiagnostics.values()],
    },
    expected,
  );
}
export { nativeComponentId };
