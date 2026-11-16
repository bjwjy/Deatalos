import {
  diagnostic,
  immutable,
  parseNetworkProject,
  parseNetworkSnapshot,
  quantityDisplayName,
  networkModelAssumptions,
  networkDefinition,
  networkDisplacementRange,
  type NetworkComponent,
  type NetworkIdentity,
  type NetworkProject,
  type NetworkSnapshot,
  type Result,
} from '@hyd/domain';

export type ResultValue =
  | { readonly kind: 'known'; readonly value: number }
  | { readonly kind: 'unknown' | 'not-applicable'; readonly reason: string };
export interface ResultQuantity {
  readonly objectKind: 'component' | 'node' | 'connection';
  readonly objectId: string;
  readonly field: string;
  readonly label: string;
  readonly unit: string;
  readonly value: ResultValue;
  readonly source: 'kernel' | 'derived';
  readonly formula: string;
  readonly inputs: readonly string[];
}
export interface NetworkResultView {
  readonly format: 'HydraulicNetworkResults';
  readonly version: 1;
  readonly document: NetworkProject;
  readonly point: NetworkSnapshot;
  readonly quantities: readonly ResultQuantity[];
  readonly assumptions: readonly string[];
}
const unknown = (reason: string): ResultValue => ({ kind: 'unknown', reason });
const known = (value: number): ResultValue =>
  Number.isFinite(value) ? { kind: 'known', value } : unknown('NON_FINITE_DERIVATION');
const calculate = (inputs: readonly ResultValue[], f: (values: readonly number[]) => number): ResultValue => {
  const missing = inputs.find((v) => v.kind !== 'known');
  return missing ?? known(f(inputs.map((v) => (v.kind === 'known' ? v.value : 0))));
};
interface DerivationContext {
  readonly add: (
    id: string,
    field: string,
    label: string,
    unit: string,
    value: ResultValue,
    formula: string,
    inputs: readonly string[],
  ) => unknown;
  readonly read: (id: string, port: string, quantity: string) => ResultValue;
  readonly power: (id: string, a: string, b: string) => ResultValue;
  readonly difference: (a: ResultValue, b: ResultValue) => ResultValue;
  readonly param: (key: string, value: number | undefined) => ResultValue;
  readonly componentValue: (id: string, field: string) => ResultValue;
}
function cylinder(c: NetworkComponent, { add, read, power, param }: DerivationContext): void {
  const id = c.id;
  const g = c.parameters.geometry;

  const a = param('capAreaM2', g?.capAreaM2),
    b = param('rodSideAreaM2', g?.rodSideAreaM2);
  const force = calculate(
    [read(id, 'A', 'pressure'), a, read(id, 'B', 'pressure'), b],
    ([pa = 0, aa = 0, pb = 0, ab = 0]) => pa * aa - pb * ab,
  );
  add(id, 'capArea', '无杆腔有效面积', 'm²', a, 'A_A (model parameter)', ['geometry.capAreaM2']);
  add(id, 'rodArea', '有杆腔有效面积', 'm²', b, 'A_B (model parameter)', ['geometry.rodSideAreaM2']);
  add(id, 'hydraulicForce', '两腔液压力（伸出为正；非全部外载）', 'N', force, 'p_A*A_A-p_B*A_B', [
    'A.pressure',
    'B.pressure',
    'capArea',
    'rodArea',
  ]);
  add(
    id,
    'capFlowVelocity',
    'A腔流量等效速度（不代替实际速度）',
    'm/s',
    calculate([read(id, 'A', 'flow'), a], ([q = 0, area = 0]) => q / area),
    'q_A/A_A',
    ['A.flow', 'capArea'],
  );
  add(
    id,
    'rodFlowVelocity',
    'B腔流量等效速度（伸出为正）',
    'm/s',
    calculate([read(id, 'B', 'flow'), b], ([q = 0, area = 0]) => -q / area),
    '-q_B/A_B',
    ['B.flow', 'rodArea'],
  );
  add(id, 'hydraulicInputPower', '两腔液压输入功率', 'W', power(id, 'A', 'B'), 'p_A*q_A+p_B*q_B', [
    'A.pressure',
    'A.flow',
    'B.pressure',
    'B.flow',
  ]);
}
function pump(c: NetworkComponent, { add, read, difference }: DerivationContext): void {
  const id = c.id;
  if (c.parameters.relief?.enabled === 1) {
    const flow = read(id, 'P', 'relief-flow');
    add(
      id,
      'reliefFlow',
      '内置溢流泄放流量' + (flow.kind === 'known' ? (flow.value > 0 ? '（开启，P→S）' : '（关闭）') : ''),
      'm³/s',
      flow,
      '已接受的内置溢流真实读数',
      ['P.relief-flow'],
    );
  }

  add(id, 'pressureRise', '泵压升', 'Pa', difference(read(id, 'P', 'pressure'), read(id, 'S', 'pressure')), 'p_P-p_S', [
    'P.pressure',
    'S.pressure',
  ]);
  add(
    id,
    'hydraulicOutputPower',
    '泵液压输出功率',
    'W',
    calculate(
      [read(id, 'P', 'pressure'), read(id, 'S', 'pressure'), read(id, 'P', 'flow')],
      ([p = 0, s = 0, q = 0]) => (p - s) * -q,
    ),
    '(p_P-p_S)*(-q_P)',
    ['P.pressure', 'S.pressure', 'P.flow'],
  );
  add(
    id,
    'shaftInputPower',
    '泵轴输入功率',
    'W',
    { kind: 'not-applicable', reason: 'NO_SHAFT_POWER_OR_EFFICIENCY_MODEL' },
    '未建立泵机械效率模型',
    [],
  );
}
function motor(c: NetworkComponent, { add, read, power, param, componentValue }: DerivationContext): void {
  const id = c.id;
  const h = c.parameters.hydraulic;
  const variable = networkDisplacementRange(c);

  add(
    id,
    'idealHydraulicTorque',
    '理想压差转矩（非轴端/负载转矩）',
    'N·m',
    calculate(
      [
        read(id, 'A', 'pressure'),
        read(id, 'B', 'pressure'),
        variable ? componentValue(id, 'displacement') : param('displacementM3PerRev', h?.displacementM3PerRev),
      ],
      ([pa = 0, pb = 0, d = 0]) => ((pa - pb) * d) / (2 * Math.PI),
    ),
    '(p_A-p_B)*D/(2*pi)',
    ['A.pressure', 'B.pressure', variable ? 'displacement' : 'hydraulic.displacementM3PerRev'],
  );
  add(id, 'hydraulicInputPower', '马达两口液压输入功率', 'W', power(id, 'A', 'B'), 'p_A*q_A+p_B*q_B', [
    'A.pressure',
    'A.flow',
    'B.pressure',
    'B.flow',
  ]);
}
function restriction(c: NetworkComponent, { add, read, power, difference }: DerivationContext): void {
  const id = c.id;

  const [a, b] =
    c.typeId === 'relief'
      ? ['P', 'T']
      : c.typeId === 'pressure-reducing' || c.typeId === 'sequence-valve' || c.typeId === 'pressure-compensated-flow'
        ? ['P', 'A']
        : ['A', 'B'];
  add(
    id,
    'pressureDrop',
    '有符号压降',
    'Pa',
    difference(read(id, a!, 'pressure'), read(id, b!, 'pressure')),
    `p_${a}-p_${b}`,
    [`${a}.pressure`, `${b}.pressure`],
  );
  const storedFlowValve = c.typeId === 'pressure-compensated-flow' && c.parameters.storage;
  add(
    id,
    storedFlowValve ? 'hydraulicInputPower' : 'lossPower',
    storedFlowValve ? '瞬时两口净液压输入功率（含储油）' : '瞬时两口耗散功率',
    'W',
    power(id, a!, b!),
    `p_${a}*q_${a}+p_${b}*q_${b}`,
    [`${a}.pressure`, `${a}.flow`, `${b}.pressure`, `${b}.flow`],
  );
}
function threePortLoss(c: NetworkComponent, { add, read, difference }: DerivationContext): void {
  const id = c.id,
    reducing = c.typeId === 'pressure-reducing-relieving';
  const ports = networkDefinition(c.definition.id, c.definition.version)?.ports.map((p) => p.id);
  if (ports?.length !== 3) throw new Error('Missing three-port result definition');
  const inputs = ports.flatMap((port) => [`${port}.pressure`, `${port}.flow`]);
  const values = ports.flatMap((port) => [read(id, port, 'pressure'), read(id, port, 'flow')]);
  add(
    id,
    'lossPower',
    c.parameters.outletRelief ? '瞬时三口净液压输入功率（含储油）' : '瞬时三口耗散功率',
    'W',
    calculate(values, ([pa = 0, qa = 0, pb = 0, qb = 0, pc = 0, qc = 0]) => pa * qa + pb * qb + pc * qc),
    ports.map((port) => `p_${port}*q_${port}`).join('+'),
    inputs,
  );
  if (reducing)
    add(
      id,
      'regulatedDifferential',
      '出口相对回油压力',
      'Pa',
      difference(read(id, 'A', 'pressure'), read(id, 'T', 'pressure')),
      'p_A-p_T',
      ['A.pressure', 'T.pressure'],
    );
}
function teachingActuatorPower(c: NetworkComponent, { add, read, power }: DerivationContext): void {
  if (c.typeId === 'single-acting-cylinder') {
    const inputs = ['A.pressure', 'A.flow'];
    const value = calculate([read(c.id, 'A', 'pressure'), read(c.id, 'A', 'flow')], ([p = 0, q = 0]) => p * q);
    add(c.id, 'hydraulicInputPower', 'A 口液压输入功率', 'W', value, 'p_A*q_A', inputs);
    return;
  }
  add(c.id, 'hydraulicInputPower', '两油口液压输入功率', 'W', power(c.id, 'A', 'B'), 'p_A*q_A+p_B*q_B', [
    'A.pressure',
    'A.flow',
    'B.pressure',
    'B.flow',
  ]);
}
const resultAdapters: Readonly<Record<string, typeof cylinder | null>> = Object.freeze({
  cylinder,
  'single-acting-cylinder': teachingActuatorPower,
  'cushioned-cylinder': teachingActuatorPower,
  'cushioned-double-rod-cylinder': teachingActuatorPower,
  'limited-rotary-actuator': teachingActuatorPower,
  pump,
  motor,
  throttle: restriction,
  'flow-meter': restriction,
  'return-filter': restriction,
  'differential-pressure-gauge': null,
  'flow-divider-combiner': threePortLoss,
  'synchronizing-flow-divider': threePortLoss,
  'pilot-unloading-valve': threePortLoss,
  'adjustable-pressure-switch': null,
  'three-way-flow-control': threePortLoss,
  'shock-makeup-valve': threePortLoss,
  'pressure-intensifier': threePortLoss,
  'manual-shutoff': restriction,
  'shuttle-valve': threePortLoss,
  'two-pressure-valve': threePortLoss,
  'pilot-check-close': restriction,
  'pressure-reducing-relieving': threePortLoss,
  'check-valve': restriction,
  'pressure-reducing': restriction,
  'sequence-valve': restriction,
  'pilot-check': restriction,
  counterbalance: restriction,
  'pressure-compensated-flow': restriction,
  'one-way-throttle': restriction,
  relief: restriction,
  valve: null,
  tank: null,
  volume: null,
  'dynamic-controller': null,
  accumulator: null,
  'pressure-source': null,
});
export const networkResultAdapterTypes: readonly string[] = Object.freeze(Object.keys(resultAdapters));
/** Projection only. No integration, sizing defaults, template solver or inferred readings. */
export function networkResultView(
  input: unknown,
  snapshot: unknown,
  expected: NetworkIdentity,
): Result<NetworkResultView> {
  const project = parseNetworkProject(input);
  if (!project.ok) return project;
  const parsed = parseNetworkSnapshot(project.value, snapshot, expected);
  if (!parsed.ok) return parsed;
  const document = project.value,
    point = parsed.value,
    quantities: ResultQuantity[] = [];
  if (point.source !== 'kernel' || point.solver.id !== 'hopsan')
    return { ok: false, diagnostics: [diagnostic('MODEL_UNSUPPORTED', '/results', '本接口只解释已验新内核快照。')] };
  const add = (
    objectId: string,
    field: string,
    label: string,
    unit: string,
    value: ResultValue,
    formula: string,
    inputs: readonly string[],
    source: 'derived' | 'kernel' = 'derived',
    objectKind: ResultQuantity['objectKind'] = 'component',
  ) => quantities.push({ objectKind, objectId, field, label, unit, value, formula, inputs, source });
  for (const r of point.readings) {
    const objectId =
      r.location.kind === 'node'
        ? r.location.nodeId
        : r.location.kind === 'connection'
          ? r.location.connectionId
          : r.location.componentId;
    const field = r.location.kind === 'port' ? r.location.portId + '.' + r.quantity : r.quantity;
    const objectKind = r.location.kind === 'port' ? 'component' : r.location.kind;
    add(objectId, field, quantityDisplayName(field), r.unit, r.value, 'kernel', [], 'kernel', objectKind);
  }
  const conflicts: string[] = [];
  const addState = (id: string, field: string, label: string, unit: string, value: number, formula: string) => {
    const reading = quantities.find((q) => q.objectKind === 'component' && q.objectId === id && q.field === field);
    // Native adapters may expose one variable through both readings and states.
    // Keep one semantic quantity; never turn an unknown reading into a zero or
    // silently select between contradictory known values from the same frame.
    if (!reading) add(id, field, label, unit, known(value), formula, [], 'kernel');
    else if (reading.unit !== unit || (reading.value.kind === 'known' && reading.value.value !== value))
      conflicts.push(id + '.' + field);
  };
  for (const state of point.states) {
    if (state.kind === 'accumulator') {
      addState(state.componentId, 'oil-volume', '存油量', 'm³', state.oilVolumeM3, 'kernel state.oilVolumeM3');
      addState(state.componentId, 'gas-volume', '气体容积', 'm³', state.gasVolumeM3, 'kernel state.gasVolumeM3');
      addState(
        state.componentId,
        'gas-pressure',
        '气体绝压',
        'Pa',
        state.gasPressureAbsolutePa,
        'kernel state.gasPressureAbsolutePa',
      );
      addState(
        state.componentId,
        'compression-energy',
        '气体压缩功（相对排空态）',
        'J',
        state.compressionEnergyJ,
        'kernel state.compressionEnergyJ',
      );
    } else if (state.kind === 'cylinder') {
      addState(state.componentId, 'position', '实际位移', 'm', state.positionM, 'kernel state.positionM');
      addState(state.componentId, 'velocity', '实际速度', 'm/s', state.velocityMPerS, 'kernel state.velocityMPerS');
    } else if (state.kind === 'motor') {
      addState(state.componentId, 'angularPosition', '实际转角', 'rad', state.angleRad, 'kernel state.angleRad');
      addState(
        state.componentId,
        'angularVelocity',
        '实际转速',
        'rad/s',
        state.angularSpeedRadPerS,
        'kernel state.angularSpeedRadPerS',
      );
    }
  }
  if (conflicts.length)
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'RESULT_STATE_CONFLICT',
          '/results',
          '同一有效帧的状态与读数不一致，不能选择其中之一继续显示：' + conflicts.join('、'),
        ),
      ],
    };
  const read = (id: string, port: string, quantity: string): ResultValue =>
    point.readings.find(
      (r) =>
        r.location.kind === 'port' &&
        r.location.componentId === id &&
        r.location.portId === port &&
        r.quantity === quantity,
    )?.value ?? unknown(`MISSING:${id}.${port}.${quantity}`);
  const difference = (a: ResultValue, b: ResultValue) => calculate([a, b], ([x = 0, y = 0]) => x - y);
  const componentValue = (id: string, field: string): ResultValue =>
    quantities.find((q) => q.objectKind === 'component' && q.objectId === id && q.field === field)?.value ??
    unknown(`MISSING:${id}.${field}`);
  const power = (id: string, a: string, b: string) =>
    calculate(
      [read(id, a, 'pressure'), read(id, a, 'flow'), read(id, b, 'pressure'), read(id, b, 'flow')],
      ([pa = 0, qa = 0, pb = 0, qb = 0]) => pa * qa + pb * qb,
    );
  for (const c of document.design.components) {
    const id = c.id;
    if (c.parameters.storage && ['0.3.0', '0.4.0'].includes(c.model.version)) {
      const ports = c.typeId === 'motor' ? ['A', 'B'] : c.typeId === 'pump' ? ['S', 'P'] : ['P'];
      for (const port of ports) {
        const makeup =
          c.typeId === 'motor' && (c.parameters.makeup?.maximumAreaM2 ?? 0) > 0
            ? read(id, port, 'makeup-flow')
            : known(0);
        add(
          id,
          port + '.storageRate',
          `${port}口内置油液储存变化率`,
          'm³/s',
          calculate(
            [read(id, port, 'flow'), makeup, read(id, port, 'core-flow')],
            ([external = 0, supply = 0, core = 0]) => external + supply - core,
          ),
          'q_external+q_makeup-q_core=V/beta*dp/dt',
          [port + '.flow', port + '.makeup-flow', port + '.core-flow'],
        );
      }
    }
    const param = (key: string, value: number | undefined): ResultValue =>
      value === undefined ? unknown('MISSING_PARAMETER:' + id + '.' + key) : known(value);
    const derive = resultAdapters[c.typeId];
    if (derive === undefined)
      return { ok: false, diagnostics: [diagnostic('MODEL_UNSUPPORTED', '/results/' + id, '未注册结果派生策略。')] };
    derive?.(c, { add, read, power, difference, param, componentValue });
  }
  for (const edge of document.design.connections)
    if (edge.kind === 'pipe') {
      const pressure = (end: typeof edge.from): ResultValue =>
        end.kind === 'port'
          ? read(end.componentId, end.portId, 'pressure')
          : (point.readings.find(
              (r) => r.location.kind === 'node' && r.location.nodeId === end.nodeId && r.quantity === 'pressure',
            )?.value ?? unknown('MISSING_NODE_PRESSURE:' + end.nodeId));
      const dp = difference(pressure(edge.from), pressure(edge.to));
      const q =
        point.readings.find(
          (r) => r.location.kind === 'connection' && r.location.connectionId === edge.id && r.quantity === 'flow',
        )?.value ?? unknown('MISSING_PIPE_FLOW');
      add(
        edge.id,
        'pressureDrop',
        '管路压降（起点→终点）',
        'Pa',
        dp,
        'p_from-p_to',
        ['from.pressure', 'to.pressure'],
        'derived',
        'connection',
      );
      add(
        edge.id,
        'lossPower',
        '管路压降功率（层流无惯性模型）',
        'W',
        calculate([dp, q], ([p = 0, flow = 0]) => p * flow),
        '(p_from-p_to)*q_from_to',
        ['pressureDrop', 'flow'],
        'derived',
        'connection',
      );
    }
  return {
    ok: true,
    value: immutable({
      format: 'HydraulicNetworkResults',
      version: 1,
      document,
      point,
      quantities,
      assumptions: [
        ...document.design.components.flatMap(networkModelAssumptions),
        `压力基准：${document.design.pressureReference.kind === 'gauge' ? '表压' : '内核数值基准（不自行解释为绝压）'}；${document.design.pressureReference.absoluteReferencePa === null ? '未指定绝对参考压力' : `绝对参考压力为 ${document.design.pressureReference.absoluteReferencePa} Pa`}。`,
        '端口流量流入元件为正；连接流量从起点到终点为正；缸伸出/马达A→B转向为正。',
        '液压力使用本快照压力基准；不是全部外载。缸模型含质量、黏性阻尼、泄漏、压缩性及柔性端止挡；未添加机械效率或库仑摩擦。',
        'q/A是忽略压缩与泄漏的等效速度；实际位移、速度、转速、轴转矩与功率仍取内核读数。',
        '理想马达转矩不扣黏性摩擦/惯性/外载；这些由已选模型联合求解；未假设额外效率。',
        '泵功率为实际压升乘实际出口流量；轴输入功率缺少效率/轴模型，不推测。节流/管路损失仅限已有模型。',
        '初始化仍是瞬态起点，未认证稳态；显式物理储能、传输线数值近似及逐帧约束预算由运行服务执行，派生计算不认证稳态或理想节点。',
      ],
    }),
  };
}

/** Shared formatting for panel/curve/formula/export clients; SI value remains intact. */
export function displayNetworkQuantity(q: ResultQuantity) {
  const units: Readonly<Record<string, readonly [string, number]>> = {
    Pa: ['MPa', 1e-6],
    'm³/s': ['L/min', 60000],
    m: ['mm', 1000],
    'm/s': ['mm/s', 1000],
    'rad/s': ['r/min', 30 / Math.PI],
    W: ['kW', 0.001],
    'm²': ['mm²', 1e6],
  };
  const [unit, scale] =
    q.unit === 'm³' && q.field.endsWith('.cavity-volume') ? ['mL', 1e6] : (units[q.unit] ?? [q.unit, 1]);
  return immutable({
    ...q,
    si: { unit: q.unit, value: q.value },
    unit,
    value: q.value.kind === 'known' ? known(q.value.value * scale) : q.value,
  });
}
