import type { HydraulicPort, NetworkDefinition, SIParameter } from './network-registry.js';
import { immutable } from './reader.js';

const si = (key: string, unit: string, minimum: number, maximum: number, defaultValue: number): SIParameter => ({
  key,
  unit,
  minimum,
  maximum,
  defaultValue,
});
const port = (id: string, anchor: HydraulicPort['anchor']): HydraulicPort => ({
  id,
  anchor,
  domain: 'hydraulic',
  positiveFlow: 'into-component',
});
export function isLoadControlType(typeId: string): boolean {
  return typeId === 'counterbalance' || typeId === 'pressure-compensated-flow';
}
/** Finite quasistatic teaching structures; no hidden supply, drain or gas storage. */
const originalLoadValves: readonly NetworkDefinition[] = [
  {
    id: 'teaching:counterbalance',
    version: 1,
    typeId: 'counterbalance',
    model: { id: 'teaching:counterbalance', version: '0.7.0', solverId: 'hopsan' },
    evidence: 'runtime-candidate',
    ports: [port('A', [0, 50, 0, 1]), port('B', [0, -50, 0, -1]), port('X', [-65, 0, -1, 0])],
    drawingBounds: { left: -72, right: 76, top: -55, bottom: 55 },
    groups: {
      hydraulic: [
        si('maximumAreaM2', 'm²', 1e-9, 1e-4, 1e-5),
        si('flowCoefficient', '1', 0.1, 1, 0.67),
        si('counterbalanceSettingPa', 'Pa', 1e5, 35e6, 4e6),
        si('regulationBandPa', 'Pa', 1e4, 10e6, 5e5),
        si('pilotRatio', '1', 1, 10, 3),
        si('openingDifferentialPa', 'Pa', 0, 2e6, 1e5),
      ],
    },
    initialKind: 'none',
    control: 'none',
    flowPolicy: 'pressure-controlled',
  },
  {
    id: 'teaching:pressure-compensated-flow',
    version: 1,
    typeId: 'pressure-compensated-flow',
    model: { id: 'teaching:pressure-compensated-flow', version: '0.7.0', solverId: 'hopsan' },
    evidence: 'runtime-candidate',
    ports: [port('P', [0, -50, 0, -1]), port('A', [0, 50, 0, 1])],
    drawingBounds: { left: -42, right: 68, top: -55, bottom: 55 },
    groups: {
      hydraulic: [
        si('meteringAreaM2', 'm²', 0, 1e-4, 2e-6),
        si('compensationDifferentialPa', 'Pa', 1e4, 5e6, 5e5),
        si('flowCoefficient', '1', 0.1, 1, 0.67),
      ],
    },
    initialKind: 'none',
    control: 'none',
    flowPolicy: 'pressure-compensated',
  },
];

const compensatedFlow = originalLoadValves.find((definition) => definition.typeId === 'pressure-compensated-flow');
if (!compensatedFlow) throw new Error('Pressure-compensated flow definition missing');

export const loadValveDefinitions: readonly NetworkDefinition[] = immutable([
  ...originalLoadValves,
  {
    ...compensatedFlow,
    version: 2,
    model: { ...compensatedFlow.model, version: '0.8.0' },
    groups: {
      ...compensatedFlow.groups,
      storage: [si('portVolumeM3', 'm³', 5e-5, 0.005, 1e-4), si('initialPressurePa', 'Pa', 0, 70e6, 1e5)],
    },
  },
]);
