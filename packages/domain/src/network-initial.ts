import { diagnostic, immutable } from './reader.js';
import { networkDefinition, type NetworkDefinition } from './network-registry.js';
import type { NetworkComponent, NetworkInitial } from './network-model.js';
import type { Result } from './model.js';
import { networkValvePositions } from './network-valve.js';

type InitialFactory = (component: NetworkComponent) => Result<NetworkInitial | null>;
const ok = (value: NetworkInitial | null): Result<NetworkInitial | null> => ({ ok: true, value: immutable(value) });
/** Creation only. Saved projects retain their explicit initial conditions. */
const factories: Readonly<Record<NetworkDefinition['initialKind'], InitialFactory>> = {
  none: () => ok(null),
  valve: (component) =>
    ok({
      componentId: component.id,
      kind: 'valve',
      positionId: networkValvePositions(component).includes('neutral') ? 'neutral' : 'retract',
    }),
  cylinder: (component) =>
    ok({
      componentId: component.id,
      kind: 'cylinder',
      positionM: 0,
      velocityMPerS: null,
      capPressurePa: null,
      rodPressurePa: null,
    }),
  motor: (component) => ok({ componentId: component.id, kind: 'motor', angleRad: 0, angularSpeedRadPerS: null }),
  accumulator: (component) => ok({ componentId: component.id, kind: 'accumulator', oilVolumeM3: 0 }),
  volume: (component) => ok({ componentId: component.id, kind: 'volume', pressurePa: null }),
  throttle: (component) => {
    const area = component.parameters.hydraulic?.maximumAreaM2;
    return area === undefined
      ? {
          ok: false,
          diagnostics: [
            diagnostic(
              'INITIALIZATION_REQUIRED',
              '/design/components/' + component.id,
              '节流初态需要明确最大开口面积。',
            ),
          ],
        }
      : ok({
          componentId: component.id,
          kind: 'throttle',
          openingAreaM2: component.typeId === 'manual-shutoff' ? 0 : area,
        });
  },
};
export const networkInitialKinds: readonly string[] = Object.freeze(Object.keys(factories));
export function networkInitialFor(component: NetworkComponent): Result<NetworkInitial | null> {
  const definition = networkDefinition(component.definition.id, component.definition.version);
  if (!definition)
    return {
      ok: false,
      diagnostics: [diagnostic('MODEL_UNSUPPORTED', '/design/components/' + component.id, '初态定义未注册。')],
    };
  return factories[definition.initialKind](component);
}
