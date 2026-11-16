import { networkDisplacementCommandRange, type NetworkComponent } from '@hyd/domain';

export type ComponentEditor = 'properties' | 'valve' | 'controller' | 'throttle' | 'displacement';
interface EditingPolicy {
  readonly editor: ComponentEditor;
  readonly propertyPanel: 'parameters' | 'valve';
  readonly projectPressureReference: boolean;
}
const parameters: EditingPolicy = Object.freeze({
  editor: 'properties',
  propertyPanel: 'parameters',
  projectPressureReference: false,
});
/** Each supported type deliberately declares its editing capability, including the ordinary parameter panel. */
const policies: Readonly<Record<string, EditingPolicy>> = Object.freeze({
  tank: parameters,
  'flow-meter': parameters,
  'return-filter': parameters,
  'differential-pressure-gauge': parameters,
  'flow-divider-combiner': parameters,
  'three-way-flow-control': parameters,
  'shock-makeup-valve': parameters,
  'pressure-intensifier': parameters,
  'adjustable-pressure-switch': parameters,
  'pilot-unloading-valve': parameters,
  'synchronizing-flow-divider': parameters,
  'manual-shutoff': Object.freeze({ ...parameters, editor: 'throttle' }),
  'shuttle-valve': parameters,
  'two-pressure-valve': parameters,
  'pilot-check-close': parameters,
  'pressure-reducing-relieving': parameters,
  pump: parameters,
  cylinder: parameters,
  'single-acting-cylinder': parameters,
  'cushioned-cylinder': parameters,
  'cushioned-double-rod-cylinder': parameters,
  'limited-rotary-actuator': parameters,
  motor: parameters,
  relief: parameters,
  'check-valve': parameters,
  'one-way-throttle': parameters,
  'pressure-reducing': parameters,
  'sequence-valve': parameters,
  'pilot-check': parameters,
  counterbalance: parameters,
  'pressure-compensated-flow': parameters,
  volume: parameters,
  'pressure-source': parameters,
  valve: Object.freeze({ ...parameters, editor: 'valve', propertyPanel: 'valve' }),
  'dynamic-controller': Object.freeze({ ...parameters, editor: 'controller' }),
  throttle: Object.freeze({ ...parameters, editor: 'throttle' }),
  accumulator: Object.freeze({ ...parameters, projectPressureReference: true }),
});
export const networkComponentEditingTypes: readonly string[] = Object.freeze(Object.keys(policies));
export function componentEditingPolicy(typeId: string): EditingPolicy {
  const policy = policies[typeId];
  if (!policy) throw new Error('Missing registered component editing policy: ' + typeId);
  return policy;
}
export function componentEditor(component: NetworkComponent, runtimeReady: boolean): ComponentEditor {
  if (runtimeReady && networkDisplacementCommandRange(component)) return 'displacement';
  const editor = componentEditingPolicy(component.typeId).editor;
  return editor === 'throttle' && !runtimeReady ? 'properties' : editor;
}
