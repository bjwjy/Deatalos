import { directionalValveSpec, networkValveFunction, networkValvePositions } from '@hyd/domain';
import type { NetworkComponent, NetworkReading, NetworkState, Result } from '@hyd/domain';
import { nativeId } from './hopsan-components.js';
import { failure } from './network-graph.js';
import type { MappingPlan, NativePort } from './hopsan-types.js';
interface StateContext {
  readonly plan: MappingPlan;
  readonly read: (ref: NativePort, variable: string) => number | undefined;
  readonly states: NetworkState[];
  readonly readings: NetworkReading[];
}
const known = (value: number): NetworkReading['value'] => ({ kind: 'known', value });
function valve(c: NetworkComponent, context: StateContext): Result<true> {
  const { plan, read, states } = context;

  const binding = plan.controls.find((v) => v.componentId === c.id);
  if (!binding || binding.travelM === null) throw new Error('Valve control mapping missing');
  const travel = binding.travelM;
  const position = read({ component: binding.ref.component, port: 'xv' }, 'Value');
  if (position === undefined) return failure('NATIVE_RESULT_INCOMPLETE', '/states', '缺少真实阀芯位移。');
  const overlap = c.parameters.spool?.overlapM;
  if (overlap === undefined) throw new Error('Overlap missing');
  states.push({
    kind: 'valve',
    componentId: c.id,
    spoolPositionM: position,
    effectivePositionId:
      c.definition.id.startsWith('teaching:custom-') || directionalValveSpec(c.definition.id)
        ? (networkValvePositions(c).find((slot) => {
            const command = networkValveFunction(c, slot);
            return command === 0
              ? Math.abs(position) <= overlap
              : Math.abs(position - command * travel) <= 0.01 * travel;
          }) ?? null)
        : Math.abs(position) <= overlap
          ? 'neutral'
          : position >= 0.99 * binding.travelM
            ? 'extend'
            : position <= -0.99 * binding.travelM
              ? 'retract'
              : null,
  });

  return { ok: true, value: true };
}
function cylinder(c: NetworkComponent, context: StateContext): Result<true> {
  const { plan, read, states, readings } = context;

  const binding = plan.cylinders.find((v) => v.componentId === c.id);
  if (!binding) throw new Error('Cylinder mapping missing');
  const signal = binding.source === 'signal';
  const position = read(binding.ref, signal ? 'Value' : 'Position'),
    velocity = signal
      ? read({ component: binding.ref.component, port: 'rate' }, 'Value')
      : read(binding.ref, 'Velocity');
  if (position === undefined || velocity === undefined)
    return failure('NATIVE_RESULT_INCOMPLETE', '/states', '缺少真实执行器位置或速度。');
  const displacement = signal ? position : -position,
    speed = signal ? velocity : -velocity;
  states.push({ kind: 'cylinder', componentId: c.id, positionM: displacement, velocityMPerS: speed });
  readings.push(
    { location: { kind: 'component', componentId: c.id }, quantity: 'position', unit: 'm', value: known(displacement) },
    { location: { kind: 'component', componentId: c.id }, quantity: 'velocity', unit: 'm/s', value: known(speed) },
  );
  if (signal) {
    const effort = read({ component: binding.ref.component, port: 'effort' }, 'Value');
    if (effort === undefined) return failure('NATIVE_RESULT_INCOMPLETE', '/states', '缺少执行器液压推力。');
    readings.push({
      location: { kind: 'component', componentId: c.id },
      quantity: 'force',
      unit: 'N',
      value: known(effort),
    });
  }

  return { ok: true, value: true };
}
function motor(c: NetworkComponent, context: StateContext): Result<true> {
  const { plan, read, states, readings } = context;

  const binding = plan.motors.find((v) => v.componentId === c.id);
  if (!binding) throw new Error('Motor mapping missing');
  const signal = binding.source === 'signal';
  const angle = read(binding.ref, signal ? 'Value' : 'Angle'),
    speed = signal
      ? read({ component: binding.ref.component, port: 'rate' }, 'Value')
      : read(binding.ref, 'AngularVelocity'),
    torque = signal ? read({ component: binding.ref.component, port: 'effort' }, 'Value') : read(binding.ref, 'Torque');
  if (angle === undefined || speed === undefined || torque === undefined)
    return failure('NATIVE_RESULT_INCOMPLETE', '/states', '缺少真实马达角度、转速或轴端转矩。');
  const position = angle + binding.angleOriginRad;
  states.push({ kind: 'motor', componentId: c.id, angleRad: position, angularSpeedRadPerS: speed });
  readings.push(
    {
      location: { kind: 'component', componentId: c.id },
      quantity: 'angular-position',
      unit: 'rad',
      value: known(position),
    },
    {
      location: { kind: 'component', componentId: c.id },
      quantity: 'angular-velocity',
      unit: 'rad/s',
      value: known(speed),
    },
    { location: { kind: 'component', componentId: c.id }, quantity: 'torque', unit: 'N·m', value: known(torque) },
    { location: { kind: 'component', componentId: c.id }, quantity: 'power', unit: 'W', value: known(torque * speed) },
  );

  return { ok: true, value: true };
}
function accumulator(c: NetworkComponent, { read, states, readings }: StateContext): Result<true> {
  const signal = (port: string) => read({ component: nativeId('c', c.id), port }, 'Value');
  const oilVolumeM3 = signal('Vo'),
    gasVolumeM3 = signal('Vg'),
    gasPressureAbsolutePa = signal('pg'),
    compressionEnergyJ = signal('E');
  if (
    oilVolumeM3 === undefined ||
    gasVolumeM3 === undefined ||
    gasPressureAbsolutePa === undefined ||
    compressionEnergyJ === undefined
  )
    return failure('NATIVE_RESULT_INCOMPLETE', '/states/' + c.id, '蓄能器气液状态或压缩功读数缺失。');
  states.push({
    componentId: c.id,
    kind: 'accumulator',
    oilVolumeM3,
    gasVolumeM3,
    gasPressureAbsolutePa,
    compressionEnergyJ,
  });
  const location = { kind: 'component', componentId: c.id } as const;
  readings.push(
    { location, quantity: 'oil-volume', unit: 'm³', value: known(oilVolumeM3) },
    { location, quantity: 'gas-volume', unit: 'm³', value: known(gasVolumeM3) },
    { location, quantity: 'gas-pressure', unit: 'Pa', value: known(gasPressureAbsolutePa) },
    { location, quantity: 'compression-energy', unit: 'J', value: known(compressionEnergyJ) },
  );
  return { ok: true, value: true };
}
const pressureTripState: typeof valve = (c, { read, readings }) => {
  const id = nativeId('c', c.id);
  const value = read({ component: id, port: 'active' }, 'Value');
  if (value !== 0 && value !== 1)
    return failure('NATIVE_RESULT_INCOMPLETE', '/readings/' + c.id, '压力动作状态缺失或无效。');
  if (c.typeId === 'adjustable-pressure-switch') {
    const voltage = read({ component: id, port: 'OUT' }, 'Value');
    if (
      voltage === undefined ||
      voltage < 0 ||
      voltage > 10 ||
      (c.pressureSwitchOutput?.mode !== 'analog' && voltage !== 10 * value)
    )
      return failure('NATIVE_RESULT_INCOMPLETE', '/readings/' + c.id, '压力开关 OUT 电压缺失或与触点不一致。');
    readings.push({
      location: { kind: 'component', componentId: c.id },
      quantity: 'control-voltage',
      unit: 'V',
      value: known(voltage),
    });
    if (c.pressureSwitchOutput?.mode === 'analog') return { ok: true, value: true };
  }
  readings.push({
    location: { kind: 'component', componentId: c.id },
    quantity: c.typeId === 'adjustable-pressure-switch' ? 'pressure-switch-state' : 'unloading-state',
    unit: '1',
    value: known(value),
  });
  return { ok: true, value: true };
};
const stateAdapters: Readonly<Record<string, typeof valve | null>> = Object.freeze({
  valve,
  cylinder,
  motor,
  'single-acting-cylinder': cylinder,
  'cushioned-cylinder': cylinder,
  'cushioned-double-rod-cylinder': cylinder,
  'limited-rotary-actuator': motor,
  tank: null,
  'flow-meter': null,
  'return-filter': null,
  'flow-divider-combiner': null,
  'synchronizing-flow-divider': null,
  'adjustable-pressure-switch': pressureTripState,
  'pilot-unloading-valve': pressureTripState,
  'three-way-flow-control': null,
  'shock-makeup-valve': null,
  'pressure-intensifier': null,
  'differential-pressure-gauge': (c, { read, readings }) => {
    const value = read({ component: nativeId('c', c.id), port: 'dp' }, 'Value');
    if (value === undefined) return failure('NATIVE_RESULT_INCOMPLETE', '/readings/' + c.id, '差压表读数缺失。');
    readings.push({
      location: { kind: 'component', componentId: c.id },
      quantity: 'differential-pressure',
      unit: 'Pa',
      value: known(value),
    });
    return { ok: true, value: true };
  },
  'manual-shutoff': null,
  'shuttle-valve': null,
  'two-pressure-valve': null,
  'pilot-check-close': null,
  'pressure-reducing-relieving': null,
  pump: null,
  relief: null,
  throttle: null,
  'check-valve': null,
  'pressure-reducing': null,
  'sequence-valve': null,
  'pilot-check': null,
  counterbalance: null,
  'pressure-compensated-flow': null,
  'one-way-throttle': null,
  volume: null,
  'dynamic-controller': null,
  accumulator,
  'pressure-source': null,
});
export const networkStateAdapterTypes: readonly string[] = Object.freeze(Object.keys(stateAdapters));
export function mapNetworkState(c: NetworkComponent, context: StateContext): Result<true> {
  const adapter = stateAdapters[c.typeId];
  if (adapter === undefined) return failure('MODEL_UNSUPPORTED', '/states/' + c.id, '缺少明确的结果状态适配。');
  return adapter ? adapter(c, context) : { ok: true, value: true };
}
