import {
  compileMotorDisplacementCurve,
  directionalValveCatalog,
  directionalValveSpec,
  networkDisplacementRange,
  networkValveFunction,
  networkValvePaths,
} from '@hyd/domain';
import type { NetworkComponent, NetworkInitial, NetworkProject, Result } from '@hyd/domain';
import { failure, portKey } from './network-graph.js';
import type { MappingOptions, MappingPlan, NativeComponent, NativePort, Terminal } from './hopsan-types.js';
export const nativeId = (prefix: string, id: string) =>
  prefix + '_' + [...id].map((c) => c.charCodeAt(0).toString(16)).join('');
export function parameter(c: NetworkComponent, group: string, key: string): number {
  const value = c.parameters[group]?.[key];
  if (value === undefined) throw new Error('Validated parameter missing: ' + c.id + '/' + key);
  return value;
}

interface ComponentContext {
  readonly reference: NetworkProject['design']['pressureReference'];
  readonly offset: number;
  readonly beta: number;
  readonly rho: number;
  readonly options: MappingOptions;
  readonly add: (
    id: string,
    type: string,
    inputs: Record<string, number>,
    constants?: Record<string, number>,
    start?: NativeComponent['start'],
  ) => string;
  readonly connect: (a: NativePort, b: NativePort) => unknown;
  readonly terminals: Map<string, Terminal>;
  readonly returnBranches: Map<string, NativePort>;
  readonly connectedPorts: ReadonlySet<string>;
  readonly controls: MappingPlan['controls'][number][];
  readonly cylinders: MappingPlan['cylinders'][number][];
  readonly motors: MappingPlan['motors'][number][];
  readonly cavityMotorIds: ReadonlySet<string>;
  readonly cavityVolumeIds: ReadonlySet<string>;
  readonly movingChambers: ReadonlySet<string>;
  readonly reliefBranches: MappingPlan['reliefBranches'][number][];
  readonly integratedPort: (
    component: NetworkComponent,
    portId: string,
    core: NativePort,
    leakage?: NativePort | null,
    initialPressurePa?: number | null,
    protection?: NativePort,
  ) => void;
}
const unsupported = (c: NetworkComponent) =>
  failure('MODEL_UNSUPPORTED', '/design/components/' + c.id, '此定义/模型尚未完成本后端映射；不回退旧七线。');
function boundary(c: NetworkComponent, _initial: NetworkInitial | undefined, context: ComponentContext): Result<true> {
  const { reference, offset, terminals } = context;

  if (c.definition.id === 'builtin:tank' && reference.kind !== 'gauge')
    return failure(
      'PRESSURE_REFERENCE_REQUIRED',
      '/design/pressureReference',
      '旧油箱参数为表压，不能按原生数值压力猜测。',
    );
  terminals.set(portKey(c.id, c.typeId === 'tank' ? 'T' : 'P'), {
    category: 'boundary',
    ref: null,
    pressurePa:
      (c.definition.id === 'builtin:tank'
        ? parameter(c, 'legacy', 'gaugePressurePa')
        : parameter(c, 'hydraulic', 'pressurePa')) + offset,
  });

  return { ok: true, value: true };
}

function pump(c: NetworkComponent, _initial: NetworkInitial | undefined, context: ComponentContext): Result<true> {
  const { add, terminals, integratedPort, reliefBranches, rho } = context;
  const id = nativeId('c', c.id);

  add(id, 'HydraulicFixedDisplacementPump', {
    D_p: parameter(c, 'hydraulic', 'displacementM3PerRev'),
    n_p: parameter(c, 'drive', 'angularSpeedRadPerS'),
    C_lp: parameter(c, 'hydraulic', 'leakageM3PerSPa'),
  });
  // The Hopsan stock component reads D_p at every substep, even though its name is FixedDisplacement.
  if (networkDisplacementRange(c))
    context.controls.push({
      componentId: c.id,
      ref: { component: id, port: 'D_p' },
      travelM: null,
      readBack: 'displacement',
    });
  terminals.set(portKey(c.id, 'S'), { category: 'Q', ref: { component: id, port: 'P1' }, pressurePa: null });
  terminals.set(portKey(c.id, 'P'), { category: 'Q', ref: { component: id, port: 'P2' }, pressurePa: null });
  if (c.model.version === '0.3.0' || c.model.version === '0.4.0') {
    let branch: string | null = null;
    if (c.parameters.relief?.enabled === 1) {
      branch = add(nativeId('relief', c.id), 'HydraulicTeachingRestriction', {
        Aforward: parameter(c, 'relief', 'maximumAreaM2'),
        Areverse: 0,
        Abase: 0,
        pForward: parameter(c, 'relief', 'settingDifferentialPa'),
        pReverse: 0,
        Cq: parameter(c, 'relief', 'flowCoefficient'),
        rho,
      });
      reliefBranches.push({ componentId: c.id, ref: { component: branch, port: 'P1' } });
    }
    integratedPort(c, 'S', { component: id, port: 'P1' }, branch ? { component: branch, port: 'P2' } : null);
    integratedPort(c, 'P', { component: id, port: 'P2' }, branch ? { component: branch, port: 'P1' } : null);
  }

  return { ok: true, value: true };
}

function motor(c: NetworkComponent, initial: NetworkInitial | undefined, context: ComponentContext): Result<true> {
  const { add, connect, terminals, motors, integratedPort } = context;
  const id = nativeId('c', c.id);
  if (initial?.kind !== 'motor') return unsupported(c);

  if (initial.angularSpeedRadPerS !== null && initial.angularSpeedRadPerS !== 0)
    return failure(
      'INITIALIZATION_UNSUPPORTED',
      `/design/initialConditions/${c.id}`,
      '固定马达后端积分器只支持从静止初始化；不得伪造非零初速。',
    );
  add(id, context.cavityMotorIds.has(c.id) ? 'HydraulicTeachingCavityMotor' : 'HydraulicFixedDisplacementMotorQ', {
    D_m: parameter(c, 'hydraulic', 'displacementM3PerRev'),
    // In v3 the declared leakage is a real parallel hydraulic branch.
    // The legacy integrated-leakage motor has a step-dependent damping
    // error for nonzero leakage; leave old model versions unchanged.
    C_lm: c.model.version === '0.3.0' ? 0 : parameter(c, 'hydraulic', 'leakageM3PerSPa'),
    B_m: parameter(c, 'mechanics', 'viscousFrictionNmSPerRad'),
    J_m: parameter(c, 'mechanics', 'inertiaKgM2'),
  });
  const range = networkDisplacementRange(c);
  const curve = c.motorDisplacementCurve;
  const external = c.externalMotorControl;
  let pilotOutput: NativePort | undefined;
  if (c.definition.id === 'teaching:variable-motor' && context.connectedPorts.has(portKey(c.id, 'X'))) {
    const pilot = c.externalMotorControl;
    const sensor = add(nativeId('motorpilot', c.id), 'HydraulicTeachingPressureSwitch', {
      reference: context.offset,
      ...(pilot?.kind === 'pressure' ? { analog: 1, low: pilot.lowPa, high: pilot.highPa } : {}),
    });
    terminals.set(portKey(c.id, 'X'), { category: 'Q', ref: { component: sensor, port: 'H' }, pressurePa: null });
    pilotOutput = { component: sensor, port: 'OUT' };
  }
  let displacementCurve: MappingPlan['motors'][number]['displacementCurve'];
  let externalDisplacement: MappingPlan['motors'][number]['externalDisplacement'];
  let externalInput: NativePort | undefined;
  if (curve && range && (curve.enabled || external)) {
    const { segments } = compileMotorDisplacementCurve(curve, range);
    const constants: Record<string, number> = { segmentCount: segments.length };
    if (external) {
      constants.external = 1;
      constants.lowPressure = external.lowPa ?? 1e6;
      constants.highPressure = external.highPa ?? 5e6;
    }
    for (const [i, segment] of segments.entries()) {
      for (const [j, p] of segment.pressure.entries()) constants[`p${i}_${j}`] = p;
      for (const [j, d] of segment.displacement.entries()) constants[`d${i}_${j}`] = d;
    }
    const signal = add(
      nativeId(external ? 'motorvoltage' : 'motorcurve', c.id),
      'HydraulicTeachingMotorCurve',
      {},
      constants,
    );
    const input = { component: id, port: 'D_m' };
    if (external) externalInput = { component: signal, port: 'U' };
    else {
      connect({ component: id, port: 'P1' }, { component: signal, port: 'A' });
      connect({ component: id, port: 'P2' }, { component: signal, port: 'B' });
    }
    connect({ component: signal, port: 'D' }, input);
    displacementCurve = {
      input,
      pressure: { component: signal, port: 'dp' },
      segments,
      ...(external ? { voltage: { component: signal, port: 'sample' } } : {}),
    };
  } else if (range && external) {
    const adapter = add(nativeId('motorvoltage', c.id), 'HydraulicTeachingVoltageDisplacement', {
      minimum: range.min,
      maximum: range.max,
    });
    externalInput = { component: adapter, port: 'U' };
    const input = { component: id, port: 'D_m' };
    connect({ component: adapter, port: 'D' }, input);
    externalDisplacement = {
      input,
      voltage: { component: adapter, port: 'sample' },
      minimum: range.min,
      maximum: range.max,
    };
  } else if (range)
    context.controls.push({
      componentId: c.id,
      ref: { component: id, port: 'D_m' },
      travelM: null,
      readBack: 'displacement',
    });
  if (external?.kind === 'pressure' && externalInput) {
    if (!pilotOutput) return failure('GRAPH_INCOMPLETE', '/design/components/' + c.id + '/X', 'X 口尚未接入取压油路。');
    connect(pilotOutput, externalInput);
  }
  const load = add(nativeId('l', c.id), 'MechanicTorqueTransformer', {
    T: parameter(c, 'mechanics', 'externalTorqueNm'),
  });
  connect({ component: id, port: 'P3' }, { component: load, port: 'P1' });
  terminals.set(portKey(c.id, 'A'), { category: 'Q', ref: { component: id, port: 'P1' }, pressurePa: null });
  terminals.set(portKey(c.id, 'B'), { category: 'Q', ref: { component: id, port: 'P2' }, pressurePa: null });
  if (c.model.version === '0.3.0') {
    const coefficient = parameter(c, 'hydraulic', 'leakageM3PerSPa');
    const leakage =
      coefficient > 0 ? add(nativeId('leakage', c.id), 'HydraulicLaminarOrifice', { Kc: coefficient }) : null;
    integratedPort(c, 'A', { component: id, port: 'P1' }, leakage ? { component: leakage, port: 'P1' } : null);
    integratedPort(c, 'B', { component: id, port: 'P2' }, leakage ? { component: leakage, port: 'P2' } : null);
  }
  motors.push({
    componentId: c.id,
    ref: { component: id, port: 'P3' },
    angleOriginRad: initial.angleRad,
    ...(displacementCurve ? { displacementCurve } : {}),
    ...(externalDisplacement ? { externalDisplacement } : {}),
  });

  return { ok: true, value: true };
}

function restriction(
  c: NetworkComponent,
  initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  const { rho, add, terminals, controls } = context;
  const id = nativeId('c', c.id);

  const metered = c.typeId === 'one-way-throttle',
    area = parameter(c, 'hydraulic', 'maximumAreaM2');
  add(id, 'HydraulicTeachingRestriction', {
    Aforward: metered ? 0 : area,
    Abase: metered && initial?.kind === 'throttle' ? initial.openingAreaM2 : 0,
    Areverse: metered ? (c.definition.version === 3 ? parameter(c, 'hydraulic', 'reverseMaximumAreaM2') : area) : 0,
    pForward: metered
      ? 0
      : parameter(c, 'hydraulic', c.typeId === 'relief' ? 'settingDifferentialPa' : 'openingDifferentialPa'),
    pReverse: metered ? parameter(c, 'hydraulic', 'reverseOpeningDifferentialPa') : 0,
    Cq: parameter(c, 'hydraulic', 'flowCoefficient'),
    rho,
  });
  const bindings =
    c.typeId === 'relief'
      ? ([
          ['P', 'P1'],
          ['T', 'P2'],
        ] as const)
      : ([
          ['A', 'P1'],
          ['B', 'P2'],
        ] as const);
  for (const [port, native] of bindings)
    terminals.set(portKey(c.id, port), { category: 'Q', ref: { component: id, port: native }, pressurePa: null });
  if (metered) controls.push({ componentId: c.id, ref: { component: id, port: 'Abase' }, travelM: null });

  return { ok: true, value: true };
}

/** Bidirectional passive meter. Delta p = R q, with flow positive A to B. */
function flowMeter(c: NetworkComponent, _initial: NetworkInitial | undefined, context: ComponentContext): Result<true> {
  const id = nativeId('c', c.id);
  context.add(id, 'HydraulicLaminarOrifice', { Kc: 1 / parameter(c, 'hydraulic', 'meterResistancePaSPerM3') });
  for (const [port, native] of [
    ['A', 'P1'],
    ['B', 'P2'],
  ] as const)
    context.terminals.set(portKey(c.id, port), {
      category: 'Q',
      ref: { component: id, port: native },
      pressurePa: null,
    });
  return { ok: true, value: true };
}

function pilotRelief(
  c: NetworkComponent,
  _initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  const id = nativeId('c', c.id);
  context.add(id, 'HydraulicTeachingPilotRelief', {
    setting: parameter(c, 'hydraulic', 'settingDifferentialPa'),
    feedArea: parameter(c, 'hydraulic', 'feedAreaM2'),
    pilotArea: parameter(c, 'hydraulic', 'pilotAreaM2'),
    Cq: parameter(c, 'hydraulic', 'flowCoefficient'),
    rho: context.rho,
    diameter: parameter(c, 'main', 'mainDiameterM'),
    stiffness: parameter(c, 'main', 'mainSpringStiffnessNPerM'),
    preload: parameter(c, 'main', 'mainPreloadN'),
    maximumTravel: parameter(c, 'main', 'mainMaximumTravelM'),
  });
  for (const [port, native] of [
    ['P', 'P1'],
    ['T', 'P2'],
  ] as const)
    context.terminals.set(portKey(c.id, port), {
      category: 'Q',
      ref: { component: id, port: native },
      pressurePa: null,
    });
  return { ok: true, value: true };
}

function throttle(c: NetworkComponent, initial: NetworkInitial | undefined, context: ComponentContext): Result<true> {
  const { rho, add, terminals, controls } = context;
  const id = nativeId('c', c.id);
  if (initial?.kind !== 'throttle') return unsupported(c);

  add(id, 'HydraulicTurbulentOrifice', {
    A: initial.openingAreaM2,
    C_q: parameter(c, 'hydraulic', 'flowCoefficient'),
    rho,
  });
  for (const [port, native] of [
    ['A', 'P1'],
    ['B', 'P2'],
  ])
    terminals.set(portKey(c.id, port ?? ''), {
      category: 'Q',
      ref: { component: id, port: native ?? '' },
      pressurePa: null,
    });
  controls.push({ componentId: c.id, ref: { component: id, port: 'A' }, travelM: null });

  return { ok: true, value: true };
}
export function filterResistance(c: NetworkComponent): number {
  return parameter(c, 'hydraulic', 'filterRatedDropPa') / parameter(c, 'hydraulic', 'filterRatedFlowM3PerS') ** 2;
}
function returnFilter(
  c: NetworkComponent,
  _initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  const id = nativeId('c', c.id);
  const area = Math.sqrt(context.rho / (2 * filterResistance(c)));
  context.add(id, 'HydraulicTeachingRestriction', {
    Aforward: area,
    Areverse: area,
    Abase: 0,
    pForward: 0,
    pReverse: 0,
    Cq: 1,
    rho: context.rho,
  });
  context.terminals.set(portKey(c.id, 'A'), { category: 'Q', ref: { component: id, port: 'P1' }, pressurePa: null });
  context.terminals.set(portKey(c.id, 'B'), { category: 'Q', ref: { component: id, port: 'P2' }, pressurePa: null });
  return { ok: true, value: true };
}
function differentialGauge(
  c: NetworkComponent,
  _initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  const id = nativeId('c', c.id);
  context.add(id, 'HydraulicTeachingDifferentialGauge', {});
  for (const port of ['A', 'B'])
    context.terminals.set(portKey(c.id, port), { category: 'Q', ref: { component: id, port }, pressurePa: null });
  return { ok: true, value: true };
}
function dividerCombiner(
  c: NetworkComponent,
  _initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  const id = nativeId('c', c.id);
  const sync = c.typeId === 'synchronizing-flow-divider';
  context.add(id, sync ? 'HydraulicTeachingSynchronizingDivider' : 'HydraulicTeachingDividerCombiner', {
    shareA: parameter(c, 'hydraulic', 'branchAFlowFraction'),
    area: parameter(c, 'hydraulic', 'maximumAreaM2'),
    Cq: parameter(c, 'hydraulic', 'flowCoefficient'),
    rho: context.rho,
    ...(sync
      ? {
          correctionArea: parameter(c, 'hydraulic', 'correctionAreaM2'),
          correctionDifferential: parameter(c, 'hydraulic', 'correctionDifferentialPa'),
          correctionGate: parameter(c, 'hydraulic', 'correctionGateM3PerS'),
        }
      : {}),
  });
  for (const port of ['P', 'A', 'B'])
    context.terminals.set(portKey(c.id, port), { category: 'Q', ref: { component: id, port }, pressurePa: null });
  return { ok: true, value: true };
}
function hystereticPressure(
  c: NetworkComponent,
  _initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  const id = nativeId('c', c.id);
  const unloading = c.typeId === 'pilot-unloading-valve';
  context.add(id, unloading ? 'HydraulicTeachingUnloadValve' : 'HydraulicTeachingPressureSwitch', {
    on: parameter(c, 'hydraulic', 'tripPressurePa'),
    off: parameter(c, 'hydraulic', 'resetPressurePa'),
    ...(unloading
      ? {
          area: parameter(c, 'hydraulic', 'maximumAreaM2'),
          Cq: parameter(c, 'hydraulic', 'flowCoefficient'),
          rho: context.rho,
        }
      : {
          reference: context.offset,
          ...(c.pressureSwitchOutput?.mode === 'analog'
            ? { analog: 1, low: c.pressureSwitchOutput.lowPa, high: c.pressureSwitchOutput.highPa }
            : {}),
        }),
  });
  for (const port of unloading ? ['P', 'T', 'X'] : ['H'])
    context.terminals.set(portKey(c.id, port), { category: 'Q', ref: { component: id, port }, pressurePa: null });
  return { ok: true, value: true };
}
const passivePressureModels: Readonly<
  Record<
    string,
    {
      readonly native: string;
      readonly ports: readonly string[];
      readonly inputs: Readonly<Record<string, string>>;
    }
  >
> = {
  'three-way-flow-control': {
    native: 'HydraulicTeachingPriorityFlow',
    ports: ['P', 'A', 'T'],
    inputs: {
      rated: 'priorityFlowM3PerS',
      setting: 'compensationDifferentialPa',
      band: 'regulationBandPa',
      area: 'maximumAreaM2',
      Cq: 'flowCoefficient',
    },
  },
  'shock-makeup-valve': {
    native: 'HydraulicTeachingShockMakeup',
    ports: ['A', 'B', 'T'],
    inputs: {
      reliefA: 'reliefASettingPa',
      reliefB: 'reliefBSettingPa',
      area: 'maximumAreaM2',
      makeupArea: 'makeupAreaM2',
      crack: 'makeupCrackingPa',
      Cq: 'flowCoefficient',
    },
  },
  'pressure-intensifier': {
    native: 'HydraulicTeachingIntensifier',
    ports: ['IN', 'H', 'R'],
    inputs: {
      ratio: 'intensificationRatio',
      boostR: 'boostResistancePaSPerM3',
      bypassR: 'bypassResistancePaSPerM3',
      crack: 'bypassCrackingPa',
    },
  },
};
function passivePressure(
  c: NetworkComponent,
  _initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  const model = passivePressureModels[c.typeId];
  if (!model) return unsupported(c);
  const id = nativeId('c', c.id);
  context.add(id, model.native, {
    ...Object.fromEntries(Object.entries(model.inputs).map(([name, key]) => [name, parameter(c, 'hydraulic', key)])),
    reference: context.offset,
    ...(c.typeId === 'pressure-intensifier' ? {} : { rho: context.rho }),
  });
  for (const port of model.ports)
    context.terminals.set(portKey(c.id, port), { category: 'Q', ref: { component: id, port }, pressurePa: null });
  if (c.parameters.outletRelief) {
    let discharge: NativePort | null = null;
    if (c.parameters.outletRelief.enabled === 1) {
      const branch = context.add(nativeId('relief', c.id), 'HydraulicTeachingRestriction', {
        Aforward: parameter(c, 'outletRelief', 'maximumAreaM2'),
        Areverse: 0,
        Abase: 0,
        pForward: parameter(c, 'outletRelief', 'settingDifferentialPa'),
        pReverse: 0,
        Cq: parameter(c, 'outletRelief', 'flowCoefficient'),
        rho: context.rho,
      });
      discharge = { component: branch, port: 'P1' };
      context.returnBranches.set(portKey(c.id, 'R'), { component: branch, port: 'P2' });
      context.reliefBranches.push({ componentId: c.id, ref: discharge, portId: 'H' });
    }
    context.integratedPort(c, 'H', { component: id, port: 'H' }, null, null, discharge ?? undefined);
  }
  return { ok: true, value: true };
}
function shuttle(c: NetworkComponent, _initial: NetworkInitial | undefined, context: ComponentContext): Result<true> {
  const id = nativeId('c', c.id);
  const dual = c.typeId === 'two-pressure-valve';
  context.add(id, dual ? 'HydraulicTeachingTwoPressure' : 'HydraulicTeachingShuttle', {
    area: parameter(c, 'hydraulic', 'maximumAreaM2'),
    Cq: parameter(c, 'hydraulic', 'flowCoefficient'),
    rho: context.rho,
    transition: parameter(c, 'hydraulic', 'transitionPressurePa'),
    ...(dual
      ? {
          minimumInlet: parameter(c, 'hydraulic', 'minimumInletPressurePa') + context.offset,
          activationBand: parameter(c, 'hydraulic', 'activationBandPa'),
        }
      : {}),
  });
  for (const port of ['A', 'B', 'C'])
    context.terminals.set(portKey(c.id, port), { category: 'Q', ref: { component: id, port }, pressurePa: null });
  return { ok: true, value: true };
}
function pressureLogic(
  c: NetworkComponent,
  _initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  const id = nativeId('c', c.id);
  const pilotClose = c.typeId === 'pilot-check-close';
  context.add(id, pilotClose ? 'HydraulicTeachingPilotClose' : 'HydraulicTeachingReducingRelieving', {
    area: parameter(c, 'hydraulic', 'maximumAreaM2'),
    Cq: parameter(c, 'hydraulic', 'flowCoefficient'),
    rho: context.rho,
    ...(pilotClose
      ? { crack: parameter(c, 'hydraulic', 'openingDifferentialPa'), ratio: parameter(c, 'hydraulic', 'pilotRatio') }
      : {
          setting: parameter(c, 'hydraulic', 'reducingRelievingSettingPa'),
          band: parameter(c, 'hydraulic', 'regulationBandPa'),
        }),
  });
  for (const port of pilotClose ? ['A', 'B', 'X'] : ['P', 'A', 'T'])
    context.terminals.set(portKey(c.id, port), { category: 'Q', ref: { component: id, port }, pressurePa: null });
  return { ok: true, value: true };
}

function valve(c: NetworkComponent, initial: NetworkInitial | undefined, context: ComponentContext): Result<true> {
  const { rho, add, terminals, controls, integratedPort } = context;
  const id = nativeId('c', c.id);
  if (initial?.kind !== 'valve') return unsupported(c);
  const spec = directionalValveSpec(c.definition.id);
  if (spec) {
    const order = ['P', 'A', 'T', 'B', 'R'];
    const mask = (slot: 'extend' | 'neutral' | 'retract') => {
      if (!spec.slots.includes(slot)) return 0;
      let value = 0,
        bit = 0;
      const paths = networkValvePaths(c, slot);
      for (let a = 0; a < order.length; a++)
        for (let b = a + 1; b < order.length; b++) {
          if (
            paths.some(
              (pair) =>
                (pair[0] === order[a] && pair[1] === order[b]) || (pair[1] === order[a] && pair[0] === order[b]),
            )
          )
            value += 2 ** bit;
          bit++;
        }
      return value;
    };
    const travel = parameter(c, 'spool', 'commandTravelM');
    add(
      id,
      (c.definition.version === 2 ? 'HydraulicTeachingManifold' : 'HydraulicTeachingDirectional') + spec.ports.length,
      {
        in: networkValveFunction(c, initial.positionId) * travel,
        travel,
        area: parameter(c, 'hydraulic', 'maximumAreaM2'),
        Cq: parameter(c, 'hydraulic', 'flowCoefficient'),
        rho,
        positive: mask('extend'),
        neutral: mask('neutral'),
        negative: mask('retract'),
      },
    );
    for (const port of spec.ports)
      terminals.set(portKey(c.id, port), { category: 'Q', ref: { component: id, port }, pressurePa: null });
    controls.push({ componentId: c.id, ref: { component: id, port: 'in' }, travelM: travel });
    return { ok: true, value: true };
  }

  const travel = parameter(c, 'spool', 'commandTravelM'),
    overlap = parameter(c, 'spool', 'overlapM');
  const command = networkValveFunction(c, initial.positionId) * travel;
  const mCenter = c.definition.id === 'teaching:valve-m' || c.definition.id === 'teaching:custom-m';
  add(
    id,
    mCenter ? 'Hydraulic43ValveNeutralSupplyToTank' : 'Hydraulic43Valve',
    {
      in: command,
      xv: command,
      C_q: parameter(c, 'hydraulic', 'flowCoefficient'),
      rho,
      ...(mCenter
        ? { p_c: parameter(c, 'center', 'openingFraction'), f_c: parameter(c, 'center', 'circumferenceFraction') }
        : {}),
      d: parameter(c, 'spool', 'diameterM'),
      x_vmax: parameter(c, 'spool', 'maximumTravelM'),
      x_pa: overlap,
      x_pb: overlap,
      x_at: overlap,
      x_bt: overlap,
    },
    { omega_h: parameter(c, 'spool', 'frequencyRadPerS'), delta_h: parameter(c, 'spool', 'dampingRatio') },
  );
  for (const [port, native] of [
    ['P', 'PP'],
    ['T', 'PT'],
    ['A', 'PA'],
    ['B', 'PB'],
  ] as const)
    terminals.set(portKey(c.id, port), { category: 'Q', ref: { component: id, port: native }, pressurePa: null });
  if (mCenter && c.model.version === '0.3.0') integratedPort(c, 'P', { component: id, port: 'PP' });
  controls.push({ componentId: c.id, ref: { component: id, port: 'in' }, travelM: travel });

  return { ok: true, value: true };
}

function pressureControl(
  c: NetworkComponent,
  _initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  const id = nativeId('c', c.id),
    pilot = c.typeId === 'pilot-check',
    internal = c.definition.id === 'teaching:pilot-check-internal';
  context.add(
    id,
    pilot
      ? internal
        ? 'HydraulicTeachingPilotCheckInternal'
        : 'HydraulicTeachingPilotCheck'
      : c.typeId === 'sequence-valve'
        ? 'HydraulicTeachingSequence'
        : 'HydraulicTeachingReducer',
    {
      area: parameter(c, 'hydraulic', 'maximumAreaM2'),
      Cq: parameter(c, 'hydraulic', 'flowCoefficient'),
      rho: context.rho,
      crack: parameter(c, 'hydraulic', pilot ? 'openingDifferentialPa' : 'reverseOpeningDifferentialPa'),
      ...(pilot
        ? { ratio: parameter(c, 'hydraulic', 'pilotRatio') }
        : {
            setting: parameter(c, 'hydraulic', 'controlSettingPa'),
            band: parameter(c, 'hydraulic', 'regulationBandPa'),
            reverseArea: parameter(c, 'hydraulic', 'reverseBypassAreaM2'),
          }),
    },
  );
  for (const port of pilot ? (internal ? ['A', 'B', 'X'] : ['A', 'B', 'X', 'Y']) : ['P', 'A', 'Y'])
    context.terminals.set(portKey(c.id, port), { category: 'Q', ref: { component: id, port }, pressurePa: null });
  return { ok: true, value: true };
}
function loadControl(
  c: NetworkComponent,
  _initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  const id = nativeId('c', c.id),
    counter = c.typeId === 'counterbalance';
  context.add(id, counter ? 'HydraulicTeachingCounterbalance' : 'HydraulicTeachingCompensatedFlow', {
    area: parameter(c, 'hydraulic', counter ? 'maximumAreaM2' : 'meteringAreaM2'),
    Cq: parameter(c, 'hydraulic', 'flowCoefficient'),
    rho: context.rho,
    ...(counter
      ? {
          setting: parameter(c, 'hydraulic', 'counterbalanceSettingPa'),
          band: parameter(c, 'hydraulic', 'regulationBandPa'),
          ratio: parameter(c, 'hydraulic', 'pilotRatio'),
          crack: parameter(c, 'hydraulic', 'openingDifferentialPa'),
        }
      : { compensation: parameter(c, 'hydraulic', 'compensationDifferentialPa') }),
  });
  for (const port of counter ? ['A', 'B', 'X'] : ['P', 'A'])
    context.terminals.set(portKey(c.id, port), { category: 'Q', ref: { component: id, port }, pressurePa: null });
  if (!counter && c.parameters.storage) context.integratedPort(c, 'A', { component: id, port: 'A' });
  return { ok: true, value: true };
}
function accumulator(
  c: NetworkComponent,
  initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  if (initial?.kind !== 'accumulator') return unsupported(c);
  if (
    context.reference.kind !== 'gauge' ||
    context.reference.absoluteReferencePa === null ||
    context.reference.absoluteReferencePa <= 0
  )
    return failure(
      'PRESSURE_REFERENCE_REQUIRED',
      '/design/pressureReference',
      '蓄能器必须使用表压及明确的正绝压参考；预充参数始终为绝压。',
    );
  const id = nativeId('c', c.id);
  context.add(id, 'HydraulicTeachingAccumulator', {
    V0: parameter(c, 'gas', 'totalVolumeM3'),
    p0: parameter(c, 'gas', 'prechargeAbsolutePa'),
    n: parameter(c, 'gas', 'polytropicExponent'),
    minimumFraction: parameter(c, 'gas', 'minimumGasFraction'),
    R: parameter(c, 'hydraulic', 'portResistancePaSPerM3'),
    initialOil: initial.oilVolumeM3,
  });
  context.terminals.set(portKey(c.id, 'H'), { category: 'Q', ref: { component: id, port: 'H' }, pressurePa: null });
  return { ok: true, value: true };
}
function volume(c: NetworkComponent, initial: NetworkInitial | undefined, context: ComponentContext): Result<true> {
  const { offset, options, beta, add, terminals } = context;
  const id = nativeId('c', c.id);
  if (initial?.kind !== 'volume') return unsupported(c);

  add(
    id,
    context.cavityVolumeIds.has(c.id) ? 'HydraulicTeachingMotorVolume' : 'HydraulicVolumeMultiPort',
    { V: parameter(c, 'hydraulic', 'volumeM3'), Beta_e: beta, alpha: 0.1 },
    {},
    [['P1', 'Pressure', (initial.pressurePa ?? options.initialPressurePa) + offset]],
  );
  terminals.set(portKey(c.id, 'H'), { category: 'C', ref: { component: id, port: 'P1' }, pressurePa: null });

  return { ok: true, value: true };
}

function cylinder(c: NetworkComponent, initial: NetworkInitial | undefined, context: ComponentContext): Result<true> {
  const { offset, options, beta, add, connect, terminals, cylinders } = context;
  const id = nativeId('c', c.id);
  if (initial?.kind !== 'cylinder') return unsupported(c);

  const mass = nativeId('m', c.id),
    load = nativeId('l', c.id);
  const cavityA = context.movingChambers.has(portKey(c.id, 'A'));
  const cavityB = context.movingChambers.has(portKey(c.id, 'B'));
  add(
    id,
    cavityA || cavityB ? 'HydraulicTeachingCavityCylinder' : 'HydraulicCylinderC',
    {
      A_1: parameter(c, 'geometry', 'capAreaM2'),
      A_2: parameter(c, 'geometry', 'rodSideAreaM2'),
      s_l: parameter(c, 'geometry', 'strokeM'),
      V_1: parameter(c, 'geometry', 'capDeadVolumeM3'),
      V_2: parameter(c, 'geometry', 'rodDeadVolumeM3'),
      B_p: parameter(c, 'mechanics', 'pistonDampingNsPerM'),
      Beta_e: beta,
      c_leak: parameter(c, 'hydraulic', 'internalLeakageM3PerSPa'),
    },
    cavityA || cavityB ? { cavityAEnabled: Number(cavityA), cavityBEnabled: Number(cavityB) } : {},
    [
      ['P3', 'Position', -initial.positionM],
      ['P3', 'Velocity', -(initial.velocityMPerS ?? 0)],
      ['P1', 'Pressure', (initial.capPressurePa ?? options.initialPressurePa) + offset],
      ['P2', 'Pressure', (initial.rodPressurePa ?? options.initialPressurePa) + offset],
    ],
  );
  add(
    mass,
    'MechanicTranslationalMass',
    { B: parameter(c, 'mechanics', 'loadDampingNsPerM') },
    { m: parameter(c, 'mechanics', 'massKg') },
  );
  // A gauge-to-native offset on unequal piston areas must not create a
  // fictitious net force; compensate ambient force at the mechanical load.
  const ambientForce = offset * (parameter(c, 'geometry', 'capAreaM2') - parameter(c, 'geometry', 'rodSideAreaM2'));
  add(load, 'MechanicTranslationalCSource', {
    in_c: parameter(c, 'mechanics', 'externalForceN') + ambientForce,
    in_z: 0,
  });
  connect({ component: id, port: 'P3' }, { component: mass, port: 'P2' });
  connect({ component: load, port: 'P1' }, { component: mass, port: 'P1' });
  terminals.set(portKey(c.id, 'A'), { category: 'C', ref: { component: id, port: 'P1' }, pressurePa: null });
  terminals.set(portKey(c.id, 'B'), { category: 'C', ref: { component: id, port: 'P2' }, pressurePa: null });
  cylinders.push({ componentId: c.id, ref: { component: id, port: 'P3' } });

  return { ok: true, value: true };
}
function teachingActuator(
  c: NetworkComponent,
  initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  if (initial?.kind !== 'cylinder' && initial?.kind !== 'motor') return unsupported(c);
  const rotary = initial.kind === 'motor';
  const single = c.typeId === 'single-acting-cylinder';
  const equalRod = c.typeId === 'cushioned-double-rod-cylinder';
  const id = nativeId('c', c.id);
  const sweepA = rotary
    ? parameter(c, 'hydraulic', 'sweptVolumeM3PerRad')
    : parameter(c, 'geometry', equalRod ? 'equalAnnularAreaM2' : 'capAreaM2');
  const sweepB = rotary || equalRod ? sweepA : single ? null : parameter(c, 'geometry', 'rodSideAreaM2');
  context.add(
    id,
    rotary
      ? 'HydraulicTeachingLimitedRotary'
      : single
        ? 'HydraulicTeachingSpringCylinder'
        : 'HydraulicTeachingCushionedCylinder',
    {
      sweepA,
      ...(sweepB === null ? {} : { sweepB }),
      limit: parameter(c, 'geometry', rotary ? 'angularTravelRad' : 'strokeM'),
      inertia: parameter(c, 'mechanics', rotary ? 'inertiaKgM2' : 'massKg'),
      damping: parameter(c, 'mechanics', rotary ? 'viscousFrictionNmSPerRad' : 'loadDampingNsPerM'),
      load: parameter(c, 'mechanics', rotary ? 'externalTorqueNm' : 'externalForceN'),
      reference: context.offset,
      initialPosition: rotary ? initial.angleRad : initial.positionM,
      initialRate: (rotary ? initial.angularSpeedRadPerS : initial.velocityMPerS) ?? 0,
      ...(single
        ? {
            spring: parameter(c, 'mechanics', 'returnSpringNPerM'),
            preload: parameter(c, 'mechanics', 'returnPreloadN'),
          }
        : {}),
      ...(!rotary && !single
        ? {
            lengthA: parameter(c, 'cushion', 'retractCushionLengthM'),
            lengthB: parameter(c, 'cushion', 'extendCushionLengthM'),
            areaA: parameter(c, 'cushion', 'retractCushionAreaM2'),
            areaB: parameter(c, 'cushion', 'extendCushionAreaM2'),
            rho: context.rho,
            Cq: parameter(c, 'cushion', 'flowCoefficient'),
          }
        : {}),
    },
  );
  const protection = c.parameters.workProtection?.enabled === 1 ? nativeId('workProtection', c.id) : undefined;
  if (protection) {
    const model = passivePressureModels['shock-makeup-valve']!;
    context.add(protection, model.native, {
      ...Object.fromEntries(
        Object.entries(model.inputs).map(([name, key]) => [name, parameter(c, 'workProtection', key)]),
      ),
      reference: context.offset,
      rho: context.rho,
    });
    if (c.parameters.protectionReturn?.internalTank === 1) {
      const tank = context.add(nativeId('protectionTank', c.id), 'HydraulicMultiPressureSourceC', {
        p: parameter(c, 'protectionReturn', 'pressurePa') + context.offset,
      });
      context.connect({ component: tank, port: 'MP' }, { component: protection, port: 'T' });
    } else {
      context.terminals.set(portKey(c.id, 'T'), {
        category: 'Q',
        ref: { component: protection, port: 'T' },
        pressurePa: null,
      });
    }
  }
  if (rotary && !context.terminals.has(portKey(c.id, 'T')) && context.connectedPorts.has(portKey(c.id, 'T'))) {
    const tap = context.add(nativeId('closedReturn', c.id), 'HydraulicTeachingPressureSwitch', {
      reference: context.offset,
    });
    context.terminals.set(portKey(c.id, 'T'), { category: 'Q', ref: { component: tap, port: 'H' }, pressurePa: null });
  }
  context.integratedPort(
    c,
    'A',
    { component: id, port: 'A' },
    null,
    rotary ? null : initial.capPressurePa,
    protection ? { component: protection, port: 'A' } : undefined,
  );
  if (!single)
    context.integratedPort(
      c,
      'B',
      { component: id, port: 'B' },
      null,
      rotary ? null : initial.rodPressurePa,
      protection ? { component: protection, port: 'B' } : undefined,
    );
  const binding = { componentId: c.id, ref: { component: id, port: 'travel' }, source: 'signal' as const };
  if (rotary) context.motors.push({ ...binding, angleOriginRad: 0 });
  else context.cylinders.push(binding);
  return { ok: true, value: true };
}
const adapters: Readonly<
  Record<
    string,
    {
      readonly versions: readonly number[];
      readonly map: typeof boundary;
      readonly maximumArea?: (component: NetworkComponent) => number;
    }
  >
> = Object.freeze({
  ...Object.fromEntries(
    directionalValveCatalog.map((spec) => [
      spec.id,
      {
        versions: [1, 2],
        map: valve,
        maximumArea: (c: NetworkComponent) => 2 * parameter(c, 'hydraulic', 'maximumAreaM2'),
      },
    ]),
  ),
  'teaching:pressure-source': { versions: [1], map: boundary },
  'teaching:flow-meter': { versions: [1], map: flowMeter },
  'teaching:return-filter': { versions: [1], map: returnFilter },
  'teaching:differential-pressure-gauge': { versions: [1], map: differentialGauge },
  'teaching:flow-divider-combiner': { versions: [1], map: dividerCombiner },
  'teaching:synchronizing-flow-divider': { versions: [1], map: dividerCombiner },
  'teaching:adjustable-pressure-switch': { versions: [1], map: hystereticPressure },
  'teaching:pilot-unloading-valve': { versions: [1], map: hystereticPressure },
  'teaching:three-way-flow-control': { versions: [1], map: passivePressure },
  'teaching:shock-makeup-valve': { versions: [1], map: passivePressure },
  'teaching:pressure-intensifier': { versions: [1, 2], map: passivePressure },
  // Explicit application-only projection: no native component, hydraulic port or fictitious physical result.
  'teaching:dynamic-controller': { versions: [1], map: (): Result<true> => ({ ok: true, value: true }) },
  'teaching:counterbalance': {
    versions: [1],
    map: loadControl,
    maximumArea: (c) => parameter(c, 'hydraulic', 'maximumAreaM2'),
  },
  'teaching:pressure-compensated-flow': {
    versions: [1, 2],
    map: loadControl,
    maximumArea: (c) => parameter(c, 'hydraulic', 'meteringAreaM2'),
  },
  'builtin:tank': { versions: [1], map: boundary },
  'teaching:tank': { versions: [1], map: boundary },
  'teaching:pump': { versions: [1, 2, 3], map: pump },
  'teaching:motor': { versions: [1, 2], map: motor },
  'teaching:variable-pump': { versions: [1, 2], map: pump },
  'teaching:variable-motor': { versions: [1], map: motor },
  'teaching:check-valve': { versions: [2], map: restriction },
  ...Object.fromEntries(
    ['pressure-reducing', 'sequence-valve', 'pilot-check'].map((type) => [
      'teaching:' + type,
      {
        versions: [1],
        map: pressureControl,
        maximumArea: (c: NetworkComponent) =>
          parameter(c, 'hydraulic', 'maximumAreaM2') + (c.parameters.hydraulic?.reverseBypassAreaM2 ?? 0),
      },
    ]),
  ),
  'teaching:pilot-check-internal': {
    versions: [1],
    map: pressureControl,
    maximumArea: (c) => parameter(c, 'hydraulic', 'maximumAreaM2'),
  },
  'teaching:one-way-throttle': { versions: [2, 3], map: restriction },
  'teaching:relief': { versions: [1], map: restriction },
  'teaching:throttle': { versions: [1], map: throttle },
  'teaching:manual-shutoff': { versions: [1], map: throttle },
  'teaching:shuttle-valve': { versions: [1], map: shuttle },
  'teaching:two-pressure-valve': { versions: [1], map: shuttle },
  'teaching:pilot-check-close': { versions: [1], map: pressureLogic },
  'teaching:pressure-reducing-relieving': { versions: [1], map: pressureLogic },
  'teaching:custom-o': { versions: [1], map: valve },
  'teaching:custom-m': { versions: [1], map: valve },
  'teaching:pilot-relief': {
    versions: [1],
    map: pilotRelief,
    maximumArea: (c) =>
      Math.PI * parameter(c, 'main', 'mainDiameterM') * parameter(c, 'main', 'mainMaximumTravelM') +
      parameter(c, 'hydraulic', 'pilotAreaM2'),
  },
  'teaching:valve-o': { versions: [1], map: valve },
  'teaching:valve-m': { versions: [1, 2], map: valve },
  'teaching:volume': { versions: [1], map: volume },
  'teaching:accumulator': { versions: [1], map: accumulator },
  'teaching:cylinder': { versions: [1], map: cylinder },
  'teaching:single-acting-cylinder': { versions: [1], map: teachingActuator },
  'teaching:cushioned-cylinder': { versions: [1], map: teachingActuator },
  'teaching:cushioned-double-rod-cylinder': { versions: [1], map: teachingActuator },
  'teaching:limited-rotary-actuator': { versions: [1, 2, 3], map: teachingActuator },
});
export function hopsanRegisteredAreaBound(component: NetworkComponent): number | undefined {
  return adapters[component.definition.id]?.maximumArea?.(component);
}
export const hopsanMappingRegistrations = Object.freeze(
  Object.entries(adapters).map(([id, adapter]) =>
    Object.freeze({ id, versions: Object.freeze([...adapter.versions]) }),
  ),
);
export function mapHopsanComponent(
  c: NetworkComponent,
  initial: NetworkInitial | undefined,
  context: ComponentContext,
): Result<true> {
  const adapter = adapters[c.definition.id];
  if (!adapter?.versions.includes(c.definition.version)) return unsupported(c);
  if (c.definition.id === 'teaching:one-way-throttle' && initial?.kind !== 'throttle') return unsupported(c);
  return adapter.map(c, initial, context);
}
