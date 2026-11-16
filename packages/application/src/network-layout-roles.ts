import { immutable } from '@hyd/domain';

type LayoutRole =
  | 'actuator'
  | 'source'
  | 'reservoir'
  | 'directional'
  | 'inline'
  | 'flow-control'
  | 'divider'
  | 'pressure-stage'
  | 'protection'
  | 'logic'
  | 'storage'
  | 'return-conditioning'
  | 'instrument'
  | 'controller';
type PortRole =
  | 'work'
  | 'inlet'
  | 'outlet'
  | 'return'
  | 'suction'
  | 'pilot'
  | 'through'
  | 'common'
  | 'high-pressure'
  | 'logic-input'
  | 'logic-output'
  | 'storage'
  | 'tap';
type LayoutProfile = {
  readonly role: LayoutRole;
  readonly ports: Readonly<Partial<Record<string, PortRole>>>;
};

/** Static drawing roles, shared by all versions of a type. Signal ports are
 * already identified by their definition. Hydraulic roles describe placement
 * cues, never an internal connection or permitted physical flow direction. */
export const networkLayoutProfiles: Readonly<Partial<Record<string, LayoutProfile>>> = immutable({
  cylinder: { role: 'actuator', ports: { A: 'work', B: 'work' } },
  'single-acting-cylinder': { role: 'actuator', ports: { A: 'work' } },
  'cushioned-cylinder': { role: 'actuator', ports: { A: 'work', B: 'work' } },
  'cushioned-double-rod-cylinder': { role: 'actuator', ports: { A: 'work', B: 'work' } },
  'limited-rotary-actuator': { role: 'actuator', ports: { A: 'work', B: 'work', T: 'return' } },
  motor: { role: 'actuator', ports: { A: 'work', B: 'work', X: 'pilot' } },
  pump: { role: 'source', ports: { P: 'outlet', S: 'suction' } },
  'pressure-source': { role: 'source', ports: { P: 'outlet' } },
  tank: { role: 'reservoir', ports: { T: 'return' } },
  valve: { role: 'directional', ports: { P: 'inlet', A: 'work', B: 'work', T: 'return', R: 'return' } },
  throttle: { role: 'inline', ports: { A: 'through', B: 'through' } },
  'one-way-throttle': { role: 'inline', ports: { A: 'through', B: 'through' } },
  'check-valve': { role: 'inline', ports: { A: 'through', B: 'through' } },
  'manual-shutoff': { role: 'inline', ports: { A: 'through', B: 'through' } },
  'flow-meter': { role: 'inline', ports: { A: 'through', B: 'through' } },
  'pressure-compensated-flow': { role: 'flow-control', ports: { P: 'inlet', A: 'outlet' } },
  'three-way-flow-control': { role: 'flow-control', ports: { P: 'inlet', A: 'outlet', T: 'return' } },
  'flow-divider-combiner': { role: 'divider', ports: { P: 'common', A: 'work', B: 'work' } },
  'synchronizing-flow-divider': { role: 'divider', ports: { P: 'common', A: 'work', B: 'work' } },
  'pressure-reducing': { role: 'pressure-stage', ports: { P: 'inlet', A: 'outlet', Y: 'return' } },
  'pressure-reducing-relieving': { role: 'pressure-stage', ports: { P: 'inlet', A: 'outlet', T: 'return' } },
  'sequence-valve': { role: 'pressure-stage', ports: { P: 'inlet', A: 'outlet', Y: 'return' } },
  'pressure-intensifier': { role: 'pressure-stage', ports: { IN: 'inlet', H: 'high-pressure', R: 'return' } },
  relief: { role: 'protection', ports: { P: 'inlet', T: 'return' } },
  'pilot-unloading-valve': { role: 'protection', ports: { P: 'inlet', T: 'return', X: 'pilot' } },
  'shock-makeup-valve': { role: 'protection', ports: { A: 'work', B: 'work', T: 'return' } },
  'pilot-check': { role: 'protection', ports: { A: 'through', B: 'through', X: 'pilot', Y: 'return' } },
  'pilot-check-close': { role: 'protection', ports: { A: 'through', B: 'through', X: 'pilot' } },
  counterbalance: { role: 'protection', ports: { A: 'through', B: 'through', X: 'pilot' } },
  'shuttle-valve': { role: 'logic', ports: { A: 'logic-input', B: 'logic-input', C: 'logic-output' } },
  'two-pressure-valve': { role: 'logic', ports: { A: 'logic-input', B: 'logic-input', C: 'logic-output' } },
  volume: { role: 'storage', ports: { H: 'storage' } },
  accumulator: { role: 'storage', ports: { H: 'storage' } },
  'return-filter': { role: 'return-conditioning', ports: { A: 'through', B: 'through' } },
  'differential-pressure-gauge': { role: 'instrument', ports: { A: 'tap', B: 'tap' } },
  'adjustable-pressure-switch': { role: 'instrument', ports: { H: 'tap' } },
  'dynamic-controller': { role: 'controller', ports: {} },
});
