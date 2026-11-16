import type { NetworkDefinition, SIParameter } from './network-registry.js';
import { immutable } from './reader.js';

const si = (key: string, unit: string, minimum: number, maximum: number, defaultValue: number): SIParameter => ({
  key,
  unit,
  minimum,
  maximum,
  defaultValue,
});
export const pressureValveTypeIds = Object.freeze(['pressure-reducing', 'sequence-valve', 'pilot-check'] as const);
export function isPressureControlType(typeId: string): boolean {
  return pressureValveTypeIds.some((type) => type === typeId);
}
/** Finite quasistatic teaching structures; these are not calibrated manufacturer products. */
const externalDefinitions: readonly NetworkDefinition[] = immutable(
  pressureValveTypeIds.map((typeId) => ({
    id: 'teaching:' + typeId,
    version: 1,
    typeId,
    model: { id: 'teaching:' + typeId, version: '0.6.0', solverId: 'hopsan' },
    evidence: 'runtime-candidate',
    ports: (typeId === 'pilot-check'
      ? [
          { id: 'A', anchor: [0, 45, 0, 1] as const },
          { id: 'B', anchor: [0, -45, 0, -1] as const },
          { id: 'X', anchor: [-60, 0, -1, 0] as const },
          { id: 'Y', anchor: [60, 28, 1, 0] as const },
        ]
      : [
          { id: 'P', anchor: [0, -45, 0, -1] as const },
          { id: 'A', anchor: [0, 45, 0, 1] as const },
          { id: 'Y', anchor: [70, 30, 1, 0] as const },
        ]
    ).map((p) => ({ ...p, domain: 'hydraulic', positiveFlow: 'into-component' })),
    drawingBounds: { left: -70, right: 80, top: -50, bottom: 50 },
    groups: {
      hydraulic: [
        si('maximumAreaM2', 'm²', 1e-9, 1e-4, 1e-5),
        si('flowCoefficient', '1', 0.1, 1, 0.67),
        ...(typeId === 'pilot-check'
          ? [si('openingDifferentialPa', 'Pa', 1e4, 2e6, 1e5), si('pilotRatio', '1', 1, 10, 3)]
          : [
              si('controlSettingPa', 'Pa', 1e4, 35e6, 3e6),
              si('regulationBandPa', 'Pa', 1e4, 10e6, 5e5),
              si('reverseBypassAreaM2', 'm²', 0, 1e-4, 0),
              si('reverseOpeningDifferentialPa', 'Pa', 0, 2e6, 1e5),
            ]),
      ],
    },
    initialKind: 'none',
    control: 'none',
    flowPolicy: typeId === 'pilot-check' ? 'pilot-to-open' : 'pressure-controlled',
  })),
);
const externalCheck = externalDefinitions.find((d) => d.typeId === 'pilot-check');
if (!externalCheck) throw new Error('External pilot-check definition missing');
/** Common internally drained three-port variant; retain the four-port identity for saved candidates. */
export const pressureValveDefinitions: readonly NetworkDefinition[] = immutable([
  {
    ...externalCheck,
    id: 'teaching:pilot-check-internal',
    model: { ...externalCheck.model, id: 'teaching:pilot-check-internal' },
    ports: externalCheck.ports.filter((p) => p.id !== 'Y'),
    drawingBounds: { left: -70, right: 32, top: -50, bottom: 50 },
  },
  ...externalDefinitions,
]);
