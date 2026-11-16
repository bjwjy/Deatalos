import { immutable } from './reader.js';
import { componentTypes, componentPorts, specs } from './registry.js';
import { toSI, unitScales } from './units.js';
import { directionalValveCatalog } from './network-valve.js';
import { pressureValveDefinitions } from './network-pressure-valves.js';
import { loadValveDefinitions } from './network-load-valves.js';
import { accumulatorDefinition } from './network-accumulator.js';
import { shockMakeupParameters, teachingActuatorDefinitions } from './network-actuators.js';
import type { NetworkComponent, NetworkControl, NetworkEndpoint, NetworkProject } from './network-model.js';
export interface SIParameter {
  readonly key: string;
  readonly unit: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly defaultValue: number;
}
export interface HydraulicPort {
  readonly id: string;
  readonly domain: 'hydraulic';
  readonly positiveFlow: 'into-component';
  readonly anchor: readonly [number, number, number, number];
}
export type NetworkPort =
  | HydraulicPort
  | {
      readonly id: string;
      readonly domain: 'signal';
      readonly direction: 'input' | 'output';
      readonly anchor: HydraulicPort['anchor'];
    };
export interface NetworkDefinition {
  readonly role?: 'controller';
  readonly id: string;
  readonly version: number;
  readonly typeId: string;
  readonly model: {
    readonly id: string;
    readonly version: string;
    readonly solverId: 'legacy-basic' | 'hopsan' | 'application';
  };
  readonly evidence: 'legacy-verified' | 'spike-verified' | 'unverified' | 'runtime-candidate';
  readonly ports: readonly NetworkPort[];
  /** Maximum symbol body/actuation/port envelope in world drawing units, independent of live state. */
  readonly drawingBounds: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  readonly groups: Readonly<Record<string, readonly SIParameter[]>>;
  readonly initialKind: 'none' | 'valve' | 'cylinder' | 'motor' | 'throttle' | 'volume' | 'accumulator';
  readonly control: 'none' | 'position' | 'opening-area' | 'displacement';
  readonly flowPolicy:
    | 'bidirectional'
    | 'check-a-to-b'
    | 'meter-a-to-b-check-b-to-a'
    | 'pressure-controlled'
    | 'high-pressure-inlet-to-c'
    | 'dual-pressure-enable'
    | 'pilot-to-close'
    | 'pilot-to-open'
    | 'pressure-compensated';
}
const anchors: Readonly<Record<string, Readonly<Record<string, readonly [number, number, number, number]>>>> = {
  tank: {
    T: [0, -30, 0, -1],
  },
  pump: {
    P: [0, -42, 0, -1],
    S: [0, 42, 0, 1],
  },
  relief: {
    P: [0, -36, 0, -1],
    T: [0, 36, 0, 1],
  },
  valve: {
    A: [-16, -60, 0, -1],
    B: [16, -60, 0, -1],
    P: [-16, 60, 0, 1],
    T: [16, 60, 0, 1],
    R: [38, 60, 0, 1],
  },
  cylinder: {
    A: [-60, 50, 0, 1],
    B: [20, 50, 0, 1],
  },
  motor: {
    A: [-55, 30, -1, 0],
    B: [55, 30, 1, 0],
  },
  'check-valve': {
    A: [0, 36, 0, 1],
    B: [0, -36, 0, -1],
  },
  throttle: {
    A: [0, 36, 0, 1],
    B: [0, -36, 0, -1],
  },
  'one-way-throttle': {
    A: [0, 36, 0, 1],
    B: [0, -36, 0, -1],
  },
  'pressure-source': {
    P: [0, -30, 0, -1],
  },
  volume: {
    H: [0, 30, 0, 1],
  },
  'flow-meter': {
    A: [-45, 0, -1, 0],
    B: [45, 0, 1, 0],
  },
  'return-filter': { A: [-45, 0, -1, 0], B: [45, 0, 1, 0] },
  'differential-pressure-gauge': { A: [-32, 42, 0, 1], B: [32, 42, 0, 1] },
  'flow-divider-combiner': { P: [0, 45, 0, 1], A: [-25, -45, 0, -1], B: [25, -45, 0, -1] },
  'three-way-flow-control': { P: [-22, 48, 0, 1], A: [-22, -48, 0, -1], T: [23, 48, 0, 1] },
  'shock-makeup-valve': { A: [-34, -48, 0, -1], B: [34, -48, 0, -1], T: [0, 48, 0, 1] },
  'pressure-intensifier': { IN: [-26, 48, 0, 1], H: [0, -48, 0, -1], R: [26, 48, 0, 1] },
  'adjustable-pressure-switch': { H: [0, 44, 0, 1] },
  'pilot-unloading-valve': { P: [-22, 44, 0, 1], T: [22, 44, 0, 1], X: [-57, 0, -1, 0] },
  'synchronizing-flow-divider': { P: [0, 45, 0, 1], A: [-25, -45, 0, -1], B: [25, -45, 0, -1] },
  'manual-shutoff': { A: [-45, 0, -1, 0], B: [45, 0, 1, 0] },
  'shuttle-valve': { A: [-45, 0, -1, 0], B: [45, 0, 1, 0], C: [0, -42, 0, -1] },
  'two-pressure-valve': { A: [-45, 0, -1, 0], B: [45, 0, 1, 0], C: [0, -42, 0, -1] },
  'pilot-check-close': { A: [0, 45, 0, 1], B: [0, -45, 0, -1], X: [60, -22, 1, 0] },
  'pressure-reducing-relieving': { P: [-9, 49, 0, 1], A: [-9, -49, 0, -1], T: [9, 49, 0, 1] },
};
function ports(type: string, names: readonly string[]): readonly HydraulicPort[] {
  return names.map((id) => {
    const anchor = anchors[type]?.[id];
    if (!anchor) throw new Error('Missing registered symbol anchor');
    return {
      id,
      domain: 'hydraulic',
      positiveFlow: 'into-component',
      anchor,
    };
  });
}
const si = (key: string, unit: string, minimum: number, maximum: number, defaultValue: number): SIParameter => ({
  key,
  unit,
  minimum,
  maximum,
  defaultValue,
});
export const legacySIGroup = (group: string): readonly SIParameter[] =>
  specs(group).map((p) =>
    si(
      p.key,
      unitScales[p.quantity].si,
      toSI(p.quantity, p.minimum),
      toSI(p.quantity, p.maximum),
      toSI(p.quantity, p.defaultValue),
    ),
  );
const list: NetworkDefinition[] = [];
list.push(...teachingActuatorDefinitions);
const drawingBounds: Readonly<Record<string, NetworkDefinition['drawingBounds']>> = {
  tank: { left: -35, right: 35, top: -35, bottom: 25 },
  pump: { left: -35, right: 35, top: -47, bottom: 47 },
  valve: { left: -215, right: 215, top: -65, bottom: 65 },
  cylinder: { left: -75, right: 170, top: -27, bottom: 55 },
  motor: { left: -60, right: 60, top: -35, bottom: 35 },
  relief: { left: -75, right: 65, top: -41, bottom: 41 },
  throttle: { left: -28, right: 28, top: -41, bottom: 41 },
  'one-way-throttle': { left: -28, right: 53, top: -41, bottom: 41 },
  'check-valve': { left: -25, right: 25, top: -41, bottom: 41 },
  volume: { left: -28, right: 28, top: -27, bottom: 35 },
  'pressure-source': { left: -28, right: 28, top: -35, bottom: 28 },
  'flow-meter': { left: -50, right: 50, top: -29, bottom: 29 },
  // Keep a junction marker clear of the diamond when arrangement turns the filter.
  'return-filter': { left: -50, right: 50, top: -37, bottom: 37 },
  'differential-pressure-gauge': { left: -38, right: 38, top: -32, bottom: 47 },
  'flow-divider-combiner': { left: -49, right: 49, top: -50, bottom: 50 },
  'three-way-flow-control': { left: -48, right: 62, top: -54, bottom: 54 },
  'shock-makeup-valve': { left: -63, right: 63, top: -54, bottom: 54 },
  'pressure-intensifier': { left: -58, right: 58, top: -54, bottom: 54 },
  'adjustable-pressure-switch': { left: -40, right: 60, top: -27, bottom: 49 },
  'pilot-unloading-valve': { left: -62, right: 56, top: -34, bottom: 49 },
  'synchronizing-flow-divider': { left: -49, right: 49, top: -50, bottom: 50 },
  'manual-shutoff': { left: -50, right: 50, top: -30, bottom: 21 },
  'shuttle-valve': { left: -50, right: 50, top: -47, bottom: 24 },
  'two-pressure-valve': { left: -50, right: 50, top: -47, bottom: 24 },
  'pilot-check-close': { left: -26, right: 65, top: -50, bottom: 50 },
  'pressure-reducing-relieving': { left: -42, right: 102, top: -54, bottom: 54 },
};
function boundsFor(type: string): NetworkDefinition['drawingBounds'] {
  const bounds = drawingBounds[type];
  if (!bounds) throw new Error('Missing registered drawing bounds: ' + type);
  return bounds;
}
for (const typeId of componentTypes)
  for (const id of typeId === 'valve' ? ['builtin:valve-o', 'builtin:valve-m'] : [`builtin:${typeId}`]) {
    list.push({
      id,
      version: 1,
      typeId,
      model: {
        id: `legacy-basic:${typeId}`,
        version: '1.0.0-experimental',
        solverId: 'legacy-basic',
      },
      evidence: 'legacy-verified',
      ports: ports(typeId, componentPorts[typeId]),
      drawingBounds: boundsFor(typeId),
      groups: {
        legacy: legacySIGroup(typeId),
      },
      initialKind: typeId === 'valve' || typeId === 'cylinder' || typeId === 'motor' ? typeId : 'none',
      control: typeId === 'valve' ? 'position' : 'none',
      flowPolicy: 'bidirectional',
    });
  }
function teaching(
  id: string,
  typeId: string,
  names: readonly string[],
  groups: NetworkDefinition['groups'],
  evidence: NetworkDefinition['evidence'],
  initialKind: NetworkDefinition['initialKind'],
  control: NetworkDefinition['control'],
  version = 1,
  modelVersion = '0.1.0',
): void {
  list.push({
    id: `teaching:${id}`,
    version,
    typeId,
    model: {
      id: `teaching:${id}`,
      version: modelVersion,
      solverId: 'hopsan',
    },
    evidence,
    ports: [
      ...ports(typeId, names),
      ...(typeId === 'adjustable-pressure-switch'
        ? [{ id: 'OUT', domain: 'signal', direction: 'output', anchor: [54, -7, 1, 0] } as const]
        : []),
    ],
    drawingBounds: boundsFor(typeId),
    groups,
    initialKind,
    control,
    flowPolicy:
      typeId === 'two-pressure-valve'
        ? 'dual-pressure-enable'
        : typeId === 'pilot-check-close'
          ? 'pilot-to-close'
          : [
                'pressure-reducing-relieving',
                'shock-makeup-valve',
                'pressure-intensifier',
                'pilot-unloading-valve',
              ].includes(typeId)
            ? 'pressure-controlled'
            : typeId === 'three-way-flow-control'
              ? 'pressure-compensated'
              : typeId === 'shuttle-valve'
                ? 'high-pressure-inlet-to-c'
                : typeId === 'check-valve'
                  ? 'check-a-to-b'
                  : typeId === 'one-way-throttle'
                    ? 'meter-a-to-b-check-b-to-a'
                    : 'bidirectional',
  });
}
teaching(
  'pressure-source',
  'pressure-source',
  ['P'],
  {
    hydraulic: [si('pressurePa', 'Pa', 0, 70e6, 5.1e6)],
  },
  'spike-verified',
  'none',
  'none',
);
teaching(
  'volume',
  'volume',
  ['H'],
  {
    hydraulic: [si('volumeM3', 'm³', 1e-9, 100, 1e-4)],
  },
  'spike-verified',
  'volume',
  'none',
);
teaching(
  'valve-o',
  'valve',
  ['P', 'T', 'A', 'B'],
  {
    spool: [
      si('commandTravelM', 'm', 1e-6, 0.01, 0.0003),
      si('maximumTravelM', 'm', 1e-6, 0.01, 0.01),
      si('diameterM', 'm', 1e-4, 1, 0.01),
      si('overlapM', 'm', 0, 0.01, 1e-5),
      si('frequencyRadPerS', 'rad/s', 1, 1e5, 100),
      si('dampingRatio', '1', 0.01, 100, 1),
    ],
    hydraulic: [si('flowCoefficient', '1', 0.01, 1, 0.67)],
  },
  'spike-verified',
  'valve',
  'position',
);
// Fixed M center is a separate model/reference. Legacy missing-center=M
// remains a migration rule, never an implicit conversion to this model.
const oValve = list.find((d) => d.id === 'teaching:valve-o');
if (!oValve) throw new Error('O valve parameter contract missing');
teaching(
  'valve-m',
  'valve',
  ['P', 'T', 'A', 'B'],
  {
    ...oValve.groups,
    center: [si('openingFraction', '1', 0.001, 0.5, 0.02), si('circumferenceFraction', '1', 1e-6, 1, 0.1)],
  },
  'runtime-candidate',
  'valve',
  'position',
  1,
  '0.2.0',
);
teaching(
  'cylinder',
  'cylinder',
  ['A', 'B'],
  {
    geometry: [
      si('capAreaM2', 'm²', 1e-8, 10, 0.001),
      si('rodSideAreaM2', 'm²', 1e-8, 10, 0.0006),
      si('strokeM', 'm', 0.001, 100, 1),
      si('capDeadVolumeM3', 'm³', 1e-9, 100, 0.0003),
      si('rodDeadVolumeM3', 'm³', 1e-9, 100, 0.0003),
    ],
    mechanics: [
      si('massKg', 'kg', 0.001, 1e6, 100),
      si('loadDampingNsPerM', 'N·s/m', 0, 1e9, 20000),
      si('pistonDampingNsPerM', 'N·s/m', 0, 1e9, 1000),
      si('externalForceN', 'N', -1e9, 1e9, 0),
    ],
    hydraulic: [si('internalLeakageM3PerSPa', 'm³/(s·Pa)', 0, 1e-5, 0)],
  },
  'spike-verified',
  'cylinder',
  'none',
);
const orifice = [si('maximumAreaM2', 'm²', 1e-12, 1, 1e-5), si('flowCoefficient', '1', 0.01, 1, 0.67)];
teaching(
  'manual-shutoff',
  'manual-shutoff',
  ['A', 'B'],
  { hydraulic: orifice },
  'runtime-candidate',
  'throttle',
  'opening-area',
);
teaching(
  'shuttle-valve',
  'shuttle-valve',
  ['A', 'B', 'C'],
  { hydraulic: [...orifice, si('transitionPressurePa', 'Pa', 1, 1e6, 1000)] },
  'runtime-candidate',
  'none',
  'none',
);
const pressureLogicOrifice = [si('maximumAreaM2', 'm²', 1e-9, 1e-4, 1e-5), si('flowCoefficient', '1', 0.1, 1, 0.67)];
teaching(
  'two-pressure-valve',
  'two-pressure-valve',
  ['A', 'B', 'C'],
  {
    hydraulic: [
      ...pressureLogicOrifice,
      si('minimumInletPressurePa', 'Pa', 0, 35e6, 5e4),
      si('activationBandPa', 'Pa', 1e3, 1e6, 5e4),
      si('transitionPressurePa', 'Pa', 1, 1e6, 1000),
    ],
  },
  'runtime-candidate',
  'none',
  'none',
);
teaching(
  'pilot-check-close',
  'pilot-check-close',
  ['A', 'B', 'X'],
  {
    hydraulic: [...pressureLogicOrifice, si('openingDifferentialPa', 'Pa', 0, 2e6, 0), si('pilotRatio', '1', 1, 10, 3)],
  },
  'runtime-candidate',
  'none',
  'none',
);
teaching(
  'pressure-reducing-relieving',
  'pressure-reducing-relieving',
  ['P', 'A', 'T'],
  {
    hydraulic: [
      ...pressureLogicOrifice,
      si('reducingRelievingSettingPa', 'Pa', 1e4, 35e6, 3e6),
      si('regulationBandPa', 'Pa', 1e4, 10e6, 5e5),
    ],
  },
  'runtime-candidate',
  'none',
  'none',
);
teaching(
  'throttle',
  'throttle',
  ['A', 'B'],
  {
    hydraulic: orifice,
  },
  'spike-verified',
  'throttle',
  'opening-area',
);
teaching(
  'check-valve',
  'check-valve',
  ['A', 'B'],
  {
    hydraulic: [si('openingDifferentialPa', 'Pa', 0, 70e6, 1e5), ...orifice],
  },
  'unverified',
  'none',
  'none',
);
teaching(
  'one-way-throttle',
  'one-way-throttle',
  ['A', 'B'],
  {
    hydraulic: [...orifice, si('reverseOpeningDifferentialPa', 'Pa', 0, 70e6, 1e5)],
  },
  'unverified',
  'throttle',
  'opening-area',
);

// New references preserve old drafts without silently changing their physics.
teaching(
  'check-valve',
  'check-valve',
  ['A', 'B'],
  {
    hydraulic: [si('openingDifferentialPa', 'Pa', 0, 70e6, 1e5), ...orifice],
  },
  'runtime-candidate',
  'none',
  'none',
  2,
  '0.2.0',
);
teaching(
  'one-way-throttle',
  'one-way-throttle',
  ['A', 'B'],
  {
    hydraulic: [...orifice, si('reverseOpeningDifferentialPa', 'Pa', 0, 70e6, 1e5)],
  },
  'runtime-candidate',
  'throttle',
  'opening-area',
  2,
  '0.2.0',
);
// Independent forward metering and reverse bypass sizes. Old v2 files keep
// their original shared-area meaning; the same native restriction law is used.
teaching(
  'one-way-throttle',
  'one-way-throttle',
  ['A', 'B'],
  {
    hydraulic: [
      ...orifice,
      si('reverseMaximumAreaM2', 'm²', 1e-12, 1, 1e-5),
      si('reverseOpeningDifferentialPa', 'Pa', 0, 70e6, 0),
    ],
  },
  'runtime-candidate',
  'throttle',
  'opening-area',
  3,
  '0.2.0',
);
teaching(
  'tank',
  'tank',
  ['T'],
  { hydraulic: [si('pressurePa', 'Pa', 0, 70e6, 1e5)] },
  'runtime-candidate',
  'none',
  'none',
  1,
  '0.2.0',
);
teaching(
  'pump',
  'pump',
  ['S', 'P'],
  {
    hydraulic: [
      si('displacementM3PerRev', 'm³/rev', 1e-9, 0.01, 1e-5),
      si('leakageM3PerSPa', 'm³/(s·Pa)', 0, 1e-7, 1e-12),
    ],
    drive: [si('angularSpeedRadPerS', 'rad/s', -5000, 5000, 100)],
  },
  'runtime-candidate',
  'none',
  'none',
  1,
  '0.2.0',
);
teaching(
  'relief',
  'relief',
  ['P', 'T'],
  {
    hydraulic: [si('settingDifferentialPa', 'Pa', 0, 70e6, 5e6), ...orifice],
  },
  'runtime-candidate',
  'none',
  'none',
  1,
  '0.2.0',
);
teaching(
  'motor',
  'motor',
  ['A', 'B'],
  {
    hydraulic: [si('displacementM3PerRev', 'm³/rev', 1e-9, 0.01, 1e-5), si('leakageM3PerSPa', 'm³/(s·Pa)', 0, 1e-7, 0)],
    mechanics: [
      si('inertiaKgM2', 'kg·m²', 1e-5, 1e5, 0.01),
      si('viscousFrictionNmSPerRad', 'N·m·s/rad', 0.0001, 1e6, 0.05),
      si('externalTorqueNm', 'N·m', -1e6, 1e6, 0),
    ],
  },
  'runtime-candidate',
  'motor',
  'none',
  1,
  '0.2.0',
);

// E26: declared component oil storage is physical input, independent of h.
// Previous definitions remain addressable for old saved designs.
const internalStorage = {
  storage: [si('portVolumeM3', 'm³', 1e-8, 100, 1e-4), si('initialPressurePa', 'Pa', 0, 70e6, 1e5)],
};
teaching(
  'motor',
  'motor',
  ['A', 'B'],
  {
    hydraulic: [
      si('displacementM3PerRev', 'm³/rev', 1e-9, 0.01, 8e-6),
      si('leakageM3PerSPa', 'm³/(s·Pa)', 0, 1e-7, 2.1e-12),
    ],
    mechanics: [
      si('inertiaKgM2', 'kg·m²', 1e-5, 1e5, 0.0001),
      si('viscousFrictionNmSPerRad', 'N·m·s/rad', 0.0001, 1e6, 0.0108),
      si('externalTorqueNm', 'N·m', -1e6, 1e6, 0),
    ],
    ...internalStorage,
    makeup: [
      si('supplyPressurePa', 'Pa', 0, 70e6, 1e5),
      si('openingDifferentialPa', 'Pa', 0, 70e6, 0),
      si('maximumAreaM2', 'm²', 0, 1, 1e-4),
      si('flowCoefficient', '1', 0.01, 1, 0.67),
    ],
  },
  'runtime-candidate',
  'motor',
  'none',
  2,
  '0.3.0',
);
teaching(
  'pump',
  'pump',
  ['S', 'P'],
  {
    hydraulic: [
      si('displacementM3PerRev', 'm³/rev', 1e-9, 0.01, 1.6e-6),
      si('leakageM3PerSPa', 'm³/(s·Pa)', 0, 1e-7, 0),
    ],
    drive: [si('angularSpeedRadPerS', 'rad/s', -5000, 5000, (1320 * 2 * Math.PI) / 60)],
    ...internalStorage,
  },
  'runtime-candidate',
  'none',
  'none',
  2,
  '0.3.0',
);
teaching(
  'valve-m',
  'valve',
  ['P', 'T', 'A', 'B'],
  {
    ...oValve.groups,
    center: [si('openingFraction', '1', 0.001, 0.5, 0.02), si('circumferenceFraction', '1', 1e-6, 1, 0.1)],
    ...internalStorage,
  },
  'runtime-candidate',
  'valve',
  'position',
  2,
  '0.3.0',
);

// Bounded custom four-port/three-position valve. Logical slots choose one of
// the three verified native paths; no arbitrary script or unsupported topology.
for (const center of ['o', 'm']) {
  const original = center === 'o' ? oValve : list.find((d) => d.id === 'teaching:valve-m' && d.version === 2);
  if (!original) throw new Error('Verified valve definition missing');
  teaching(
    'custom-' + center,
    'valve',
    ['P', 'T', 'A', 'B'],
    {
      ...original.groups,
      positions: [
        si('extendFunction', '1', -1, 1, 1),
        si('neutralFunction', '1', -1, 1, 0),
        si('retractFunction', '1', -1, 1, -1),
      ],
    },
    'runtime-candidate',
    'valve',
    'position',
    1,
    center === 'm' ? '0.3.0' : '0.1.0',
  );
}
teaching(
  'pilot-relief',
  'relief',
  ['P', 'T'],
  {
    hydraulic: [
      si('settingDifferentialPa', 'Pa', 1e4, 50e6, 3e6),
      si('feedAreaM2', 'm²', 1e-10, 1e-5, 1e-7),
      si('pilotAreaM2', 'm²', 1e-10, 1e-4, 2e-7),
      si('flowCoefficient', '1', 0.05, 1, 0.67),
    ],
    main: [
      si('mainDiameterM', 'm', 0.001, 0.1, 0.01),
      si('mainSpringStiffnessNPerM', 'N/m', 100, 1e7, 20000),
      si('mainPreloadN', 'N', 0, 1e5, 2),
      si('mainMaximumTravelM', 'm', 1e-6, 0.01, 0.0003),
    ],
  },
  'runtime-candidate',
  'none',
  'none',
  1,
  '0.3.0',
);

for (const spec of directionalValveCatalog) {
  teaching(
    spec.id.slice('teaching:'.length),
    'valve',
    spec.ports,
    {
      hydraulic: [si('maximumAreaM2', 'm²', 1e-10, 1e-3, 1e-5), si('flowCoefficient', '1', 0.01, 1, 0.67)],
      spool: [
        si('commandTravelM', 'm', 1e-5, 0.01, 0.0003),
        si('maximumTravelM', 'm', 1e-5, 0.01, 0.0003),
        si('overlapM', 'm', 0, 0.009, 0),
      ],
      positions: spec.slots.map((slot, i) => si(slot + 'Function', '1', 0, 7, spec.defaults[i] ?? 0)),
    },
    'runtime-candidate',
    'valve',
    'position',
    1,
    '0.4.0',
  );
  const registered = list.pop();
  if (!registered) throw new Error('Directional definition registration missing');
  list.push({
    ...registered,
    ports: registered.ports.map((port) => ({
      ...port,
      anchor:
        port.id === 'A'
          ? [spec.ports.length <= 3 ? 0 : -16, -60, 0, -1]
          : port.id === 'B'
            ? [16, -60, 0, -1]
            : port.id === 'P'
              ? [spec.ports.length === 2 || spec.ports.length === 5 ? 0 : -16, 60, 0, 1]
              : port.id === 'T'
                ? [spec.ports.length === 5 ? -38 : 16, 60, 0, 1]
                : [38, 60, 0, 1],
    })),
  });
  const previous = list[list.length - 1];
  if (!previous) throw new Error('Directional v1 registration missing');
  list.push({
    ...previous,
    version: 2,
    model: { ...previous.model, version: '0.5.0' },
    drawingBounds: {
      left: spec.ports.length === 5 ? -345 : -245,
      right: spec.ports.length === 5 ? 345 : 245,
      top: -82,
      bottom: 82,
    },
    groups: {
      ...previous.groups,
      positions: spec.slots.map((slot, i) => si(slot + 'Function', '1', 0, 21, spec.defaults[i] ?? 0)),
    },
  });
}
const previousPump = list.find((def) => def.id === 'teaching:pump' && def.version === 2);
if (!previousPump) throw new Error('Previous pump definition missing');
export const pumpReliefMaximumSettingPa = 60e6;
teaching(
  'pump',
  'pump',
  ['S', 'P'],
  {
    ...previousPump.groups,
    storage: [...(previousPump.groups.storage ?? []), si('deliveryInitialPressurePa', 'Pa', 0, 70e6, 1e5)],
    relief: [
      si('enabled', '1', 0, 1, 0),
      si('settingDifferentialPa', 'Pa', 1e4, pumpReliefMaximumSettingPa, 60e6),
      si('maximumAreaM2', 'm²', 1e-10, 1e-3, 1e-5),
      si('flowCoefficient', '1', 0.01, 1, 0.67),
    ],
  },
  'runtime-candidate',
  'none',
  'none',
  3,
  '0.4.0',
);
const reliefPump = list.pop();
if (!reliefPump) throw new Error('Pump relief definition missing');
list.push({ ...reliefPump, drawingBounds: { ...reliefPump.drawingBounds, right: 44 } });

const storedMotor = list.find((def) => def.id === 'teaching:motor' && def.version === 2);
if (!storedMotor) throw new Error('Stored motor definition missing');
for (const base of [previousPump, storedMotor]) {
  const pump = base.typeId === 'pump';
  const id = `teaching:variable-${base.typeId}`;
  const lower = pump ? 0 : 1e-9;
  list.push({
    ...base,
    id,
    ports: pump
      ? base.ports
      : [
          ...base.ports,
          { id: 'X', domain: 'hydraulic', positiveFlow: 'into-component', anchor: [0, 67, 0, 1] },
          { id: 'U', domain: 'signal', direction: 'input', anchor: [0, 67, 0, 1] },
        ],
    version: 1,
    model: { ...base.model, id },
    evidence: 'runtime-candidate',
    control: 'displacement',
    groups: {
      ...base.groups,
      hydraulic: [
        ...(base.groups.hydraulic ?? []).map((p) => (p.key === 'displacementM3PerRev' ? { ...p, minimum: lower } : p)),
        si('minimumDisplacementM3PerRev', 'm³/rev', lower, 0.01, pump ? 0 : 4e-6),
        si('maximumDisplacementM3PerRev', 'm³/rev', 1e-9, 0.01, pump ? 3.2e-6 : 1.6e-5),
      ],
    },
  });
}

const previousVariablePump = list.find((def) => def.id === 'teaching:variable-pump' && def.version === 1);
if (!previousVariablePump) throw new Error('Variable pump definition missing');
list.push({
  ...previousVariablePump,
  version: 2,
  model: { ...previousVariablePump.model, version: reliefPump.model.version },
  drawingBounds: { ...previousVariablePump.drawingBounds, right: 44 },
  groups: {
    ...previousVariablePump.groups,
    storage: reliefPump.groups.storage ?? [],
    relief: reliefPump.groups.relief ?? [],
  },
});

export function networkModelSetVersion(
  components: readonly {
    readonly model: { readonly version: string };
    readonly motorDisplacementCurve?: NetworkComponent['motorDisplacementCurve'];
    readonly externalMotorControl?: NetworkComponent['externalMotorControl'];
    readonly pressureSwitchOutput?: NetworkComponent['pressureSwitchOutput'];
  }[],
): '0.1.0' | '0.2.0' | '0.3.0' | '0.4.0' | '0.5.0' | '0.6.0' | '0.7.0' | '0.8.0' | '0.9.0' {
  if (
    components.some(
      (c) => c.motorDisplacementCurve?.enabled || c.externalMotorControl || c.pressureSwitchOutput?.mode === 'analog',
    )
  )
    return '0.9.0';
  if (components.some((c) => c.model.version === '0.8.0')) return '0.8.0';
  if (components.some((c) => c.model.version === '0.7.0')) return '0.7.0';
  if (components.some((c) => c.model.version === '0.6.0')) return '0.6.0';
  if (components.some((c) => c.model.version === '0.5.0')) return '0.5.0';
  if (components.some((c) => c.model.version === '0.4.0')) return '0.4.0';
  if (components.some((c) => c.model.version === '0.3.0')) return '0.3.0';
  return components.some((c) => c.model.version === '0.2.0') ? '0.2.0' : '0.1.0';
}
export type NetworkNativeStepS =
  0.0001 | 0.00005 | 0.000025 | 0.0000125 | 0.00000625 | 0.000003125 | 0.0000015625 | 0.00000078125 | 0.000000390625;
export const networkNativeSteps: readonly NetworkNativeStepS[] = Object.freeze([
  0.0001, 0.00005, 0.000025, 0.0000125, 0.00000625, 0.000003125, 0.0000015625, 0.00000078125, 0.000000390625,
]);
export function isNetworkNativeStepS(value: unknown): value is NetworkNativeStepS {
  return networkNativeSteps.some((step) => step === value);
}
type StepComponent = {
  readonly model: { readonly id?: string; readonly version: string };
  readonly parameters?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly motorDisplacementCurve?: NetworkComponent['motorDisplacementCurve'];
  readonly externalMotorControl?: NetworkComponent['externalMotorControl'];
  readonly pressureSwitchOutput?: NetworkComponent['pressureSwitchOutput'];
};
/** One capability policy for menus, mapping, initialization and recorded reasoning. */
export function networkStepCapability(components: readonly StepComponent[]) {
  const addedActuator = (c: StepComponent) => teachingActuatorDefinitions.some((d) => d.model.id === c.model.id);
  const isMotor = (c: StepComponent) => c.model.id === 'teaching:motor' || c.model.id === 'teaching:variable-motor';
  const coupled =
    components.filter((c) => isMotor(c) || c.model.id === 'teaching:cylinder' || addedActuator(c)).length > 1;
  const motor = components.some((c) => isMotor(c) && ['0.2.0', '0.3.0'].includes(c.model.version));
  const integratedMotor = components.some((c) => isMotor(c) && c.model.version === '0.3.0');
  const finiteRelief = components.some(
    (c) =>
      (c.model.id === 'teaching:pump' || c.model.id === 'teaching:variable-pump') &&
      c.model.version === '0.4.0' &&
      c.parameters?.relief?.enabled !== 0,
  );
  const modelSetVersion = networkModelSetVersion(components);
  const boundedActuatorPolicy = !motor && !finiteRelief && components.some(addedActuator);
  const allowedSteps = networkNativeSteps.filter((value) =>
    integratedMotor
      ? coupled
        ? value === 0.00000078125 || value === 0.000000390625
        : value === 0.000003125 || value === 0.0000015625
      : finiteRelief
        ? value === 0.00000625 || value === 0.000003125
        : motor
          ? coupled
            ? value === 0.00000625 || value === 0.000003125
            : value === 0.000025 || value === 0.0000125
          : boundedActuatorPolicy
            ? value === 0.00005 || value === 0.000025
            : value === 0.0001 ||
              value === 0.00005 ||
              (modelSetVersion !== '0.1.0' &&
                (value === 0.000025 ||
                  value === 0.0000125 ||
                  (coupled && (value === 0.00000625 || value === 0.000003125)))),
  );
  const validatedSteps = ['0.6.0', '0.7.0', '0.8.0'].includes(modelSetVersion)
    ? allowedSteps.filter((step) => step <= 0.00005)
    : allowedSteps;
  const ruleId = integratedMotor
    ? coupled
      ? 'motor-integrated-coupled-v3'
      : 'motor-integrated-v3'
    : finiteRelief
      ? 'pump-relief-v4'
      : motor
        ? coupled
          ? 'motor-coupled-v2'
          : 'motor-single-v2'
        : boundedActuatorPolicy
          ? 'bounded-actuator-v1'
          : modelSetVersion === '0.8.0'
            ? 'teaching-v8'
            : modelSetVersion === '0.7.0'
              ? 'teaching-v7'
              : modelSetVersion === '0.6.0'
                ? 'teaching-v6'
                : modelSetVersion === '0.5.0'
                  ? 'teaching-v5'
                  : modelSetVersion === '0.4.0'
                    ? 'teaching-v4'
                    : modelSetVersion === '0.3.0'
                      ? 'teaching-v3'
                      : modelSetVersion === '0.2.0'
                        ? 'teaching-v2'
                        : 'teaching-v1';
  const reason = integratedMotor
    ? coupled
      ? '含内置储油马达的多执行器组合采用0.78125 μs；O/M多阀回中位的较大步长超出原2%速度预算，保留0.390625 μs用于对照。'
      : '内置储油马达采用3.125 μs；6.25 μs在回中位近零速对照超出原2%速度预算，保留1.5625 μs用于对照。'
    : finiteRelief
      ? '启用泵内置溢流的组合采用6.25 μs，保留3.125 μs对照；较大步长在大压差/低回压泄放检查出现负压，不能静默放宽。'
      : motor
        ? coupled
          ? '含马达的多执行器组合采用6.25 μs；更大步长未通过既有1 mrad角度对照预算。'
          : '单马达采用25 μs；100/50 μs未通过既有1 mrad角度对照预算。'
        : boundedActuatorPolicy
          ? '含有界执行器的回路采用50 μs，保留25 μs用于弹簧回程、缓冲和限位对照。'
          : modelSetVersion === '0.8.0'
            ? '多变气体蓄能器采用50 μs，保留25 μs充放油/排空对照；既有泵/马达的更严格规则优先。'
            : modelSetVersion === '0.7.0'
              ? '调速/负载控制教学阀采用50 μs，保留25 μs独立回路对照；已有泵/马达更严格限制优先。'
              : modelSetVersion === '0.6.0'
                ? '含压力控制/液控锁紧的准静态教学组合采用50 μs，保留25 μs对照；更严格已有模型规则优先。'
                : '非马达教学组合采用50 μs；按当前模型集列出允许配置，保留手动对照。';
  return immutable({
    policyVersion:
      modelSetVersion === '0.9.0'
        ? 'E1.3S12-curve-1'
        : integratedMotor && coupled
          ? 'E26-2'
          : boundedActuatorPolicy
            ? 'E26-actuators-1'
            : modelSetVersion === '0.8.0'
              ? 'S09-2'
              : modelSetVersion === '0.7.0'
                ? 'S09-1'
                : modelSetVersion === '0.6.0'
                  ? 'S08-1'
                  : modelSetVersion === '0.5.0'
                    ? 'S11-2'
                    : modelSetVersion === '0.4.0'
                      ? 'S11-1'
                      : modelSetVersion === '0.3.0'
                        ? 'E26-1'
                        : 'E25-1',
    modelSetVersion,
    ruleId,
    allowedSteps: validatedSteps,
    automaticStepS: validatedSteps.find((step) => step <= 0.00005) ?? validatedSteps[0]!,
    reason,
  });
}
export function networkNativeStepAllowed(
  components: readonly StepComponent[],
  value: unknown,
): value is NetworkNativeStepS {
  return networkStepCapability(components).allowedSteps.some((step) => step === value);
}

// A definition contract does not certify its entire parameter range or map a graph.
teaching(
  'flow-meter',
  'flow-meter',
  ['A', 'B'],
  { hydraulic: [si('meterResistancePaSPerM3', 'Pa·s/m³', 1e6, 1e13, 1e9)] },
  'runtime-candidate',
  'none',
  'none',
);
teaching(
  'return-filter',
  'return-filter',
  ['A', 'B'],
  {
    hydraulic: [
      si('filterRatedFlowM3PerS', 'm³/s', 1e-6, 0.05, 10 / 60000),
      si('filterRatedDropPa', 'Pa', 100, 5e6, 1e5),
    ],
  },
  'runtime-candidate',
  'none',
  'none',
);
teaching(
  'differential-pressure-gauge',
  'differential-pressure-gauge',
  ['A', 'B'],
  {},
  'runtime-candidate',
  'none',
  'none',
);
teaching(
  'flow-divider-combiner',
  'flow-divider-combiner',
  ['P', 'A', 'B'],
  {
    hydraulic: [
      si('branchAFlowFraction', '1', 0.1, 0.9, 0.5),
      si('maximumAreaM2', 'm²', 1e-7, 1e-4, 1e-5),
      si('flowCoefficient', '1', 0.1, 1, 0.67),
    ],
  },
  'runtime-candidate',
  'none',
  'none',
);
teaching(
  'three-way-flow-control',
  'three-way-flow-control',
  ['P', 'A', 'T'],
  {
    hydraulic: [
      si('priorityFlowM3PerS', 'm³/s', 0, 0.008, 1 / 60000),
      si('compensationDifferentialPa', 'Pa', 1e4, 5e6, 5e5),
      si('regulationBandPa', 'Pa', 1e4, 2e6, 5e4),
      si('maximumAreaM2', 'm²', 1e-7, 1e-4, 1e-5),
      si('flowCoefficient', '1', 0.1, 1, 0.67),
    ],
  },
  'runtime-candidate',
  'none',
  'none',
);
teaching(
  'shock-makeup-valve',
  'shock-makeup-valve',
  ['A', 'B', 'T'],
  {
    hydraulic: shockMakeupParameters,
  },
  'runtime-candidate',
  'none',
  'none',
);
teaching(
  'pressure-intensifier',
  'pressure-intensifier',
  ['IN', 'H', 'R'],
  {
    hydraulic: [
      si('intensificationRatio', '1', 1.1, 20, 3),
      si('boostResistancePaSPerM3', 'Pa·s/m³', 1e9, 1e14, 1e11),
      si('bypassResistancePaSPerM3', 'Pa·s/m³', 1e8, 1e13, 1e10),
      si('bypassCrackingPa', 'Pa', 0, 2e6, 1e4),
    ],
  },
  'runtime-candidate',
  'none',
  'none',
);
const baseIntensifier = list.at(-1);
if (!baseIntensifier || baseIntensifier.typeId !== 'pressure-intensifier')
  throw new Error('Pressure intensifier definition missing');
list.push({
  ...baseIntensifier,
  version: 2,
  model: { ...baseIntensifier.model, version: '0.2.0' },
  groups: {
    ...baseIntensifier.groups,
    storage: [si('portVolumeM3', 'm³', 1e-6, 0.05, 1e-4), si('initialPressurePa', 'Pa', 0, 70e6, 1e5)],
    outletRelief: [
      si('enabled', '1', 0, 1, 1),
      si('settingDifferentialPa', 'Pa', 1e4, 60e6, 60e6),
      si('maximumAreaM2', 'm²', 1e-10, 1e-3, 1e-5),
      si('flowCoefficient', '1', 0.01, 1, 0.67),
    ],
  },
});
const pressureTripSettings = [si('tripPressurePa', 'Pa', 1e4, 50e6, 2.5e6), si('resetPressurePa', 'Pa', 0, 50e6, 2e6)];
teaching(
  'adjustable-pressure-switch',
  'adjustable-pressure-switch',
  ['H'],
  { hydraulic: pressureTripSettings },
  'runtime-candidate',
  'none',
  'none',
);
teaching(
  'pilot-unloading-valve',
  'pilot-unloading-valve',
  ['P', 'T', 'X'],
  {
    hydraulic: [
      ...pressureTripSettings,
      si('maximumAreaM2', 'm²', 1e-7, 1e-4, 1e-5),
      si('flowCoefficient', '1', 0.1, 1, 0.67),
    ],
  },
  'runtime-candidate',
  'none',
  'none',
);
teaching(
  'synchronizing-flow-divider',
  'synchronizing-flow-divider',
  ['P', 'A', 'B'],
  {
    hydraulic: [
      si('branchAFlowFraction', '1', 0.1, 0.9, 0.5),
      si('maximumAreaM2', 'm²', 1e-7, 1e-4, 1e-5),
      si('flowCoefficient', '1', 0.1, 1, 0.67),
      si('correctionAreaM2', 'm²', 1e-8, 1e-5, 2e-7),
      si('correctionDifferentialPa', 'Pa', 1e4, 1e7, 3e5),
      si('correctionGateM3PerS', 'm³/s', 1e-7, 1e-3, 0.35 / 60000),
    ],
  },
  'runtime-candidate',
  'none',
  'none',
);
export const networkDefinitions: readonly NetworkDefinition[] = immutable([
  ...list,
  ...pressureValveDefinitions,
  ...loadValveDefinitions,
  accumulatorDefinition,
  {
    id: 'teaching:dynamic-controller',
    version: 1,
    typeId: 'dynamic-controller',
    role: 'controller',
    model: { id: 'application:dynamic-controller', version: '1.0.0', solverId: 'application' },
    evidence: 'runtime-candidate',
    ports: [],
    drawingBounds: { left: -60, right: 60, top: -32, bottom: 32 },
    groups: {},
    initialKind: 'none',
    control: 'none',
    flowPolicy: 'bidirectional',
  },
]);
export function networkDefinition(id: string, version: number): NetworkDefinition | undefined {
  return networkDefinitions.find((d) => d.id === id && d.version === version);
}
export function networkDisplacementRange(component: NetworkComponent) {
  const {
    minimumDisplacementM3PerRev: min,
    maximumDisplacementM3PerRev: max,
    displacementM3PerRev: initial,
  } = component.parameters.hydraulic ?? {};
  return min === undefined || max === undefined || initial === undefined ? null : { min, max, initial };
}
export function networkDisplacementValue(
  range: NonNullable<ReturnType<typeof networkDisplacementRange>>,
  control: Extract<NetworkControl, { kind: 'displacement' }>,
): number {
  if (control.source === 'manual') return control.value;
  const fraction = control.source === 'voltage' ? control.value / 10 : control.value;
  if (fraction === 1) return range.max;
  return range.min + (range.max - range.min) * fraction;
}
export function networkDisplacementCommandRange(component: NetworkComponent) {
  return component.motorDisplacementCurve?.enabled || component.externalMotorControl
    ? null
    : networkDisplacementRange(component);
}
export function networkPortActive(component: NetworkComponent, portId: string): boolean {
  if (component.typeId === 'limited-rotary-actuator' && portId === 'T')
    return (
      component.parameters.workProtection?.enabled === 1 && component.parameters.protectionReturn?.internalTank !== 1
    );
  if (component.definition.id !== 'teaching:variable-motor') return true;
  if (portId === 'X') return component.externalMotorControl?.kind === 'pressure';
  if (portId === 'U') return component.externalMotorControl?.kind === 'voltage';
  return true;
}
export function networkEndpointPort(project: NetworkProject, endpoint: NetworkEndpoint): NetworkPort | undefined {
  if (endpoint.kind !== 'port') return undefined;
  const component = project.design.components.find((c) => c.id === endpoint.componentId);
  return (
    component &&
    networkDefinition(component.definition.id, component.definition.version)?.ports.find(
      (p) => p.id === endpoint.portId,
    )
  );
}
export function networkEndpointActive(project: NetworkProject, endpoint: NetworkEndpoint): boolean {
  if (endpoint.kind !== 'port' || !['X', 'U', 'T'].includes(endpoint.portId)) return true;
  const component = project.design.components.find((c) => c.id === endpoint.componentId);
  return !!component && networkPortActive(component, endpoint.portId);
}
export function isExternalMotorPressureTap(project: NetworkProject, endpoint: NetworkEndpoint): boolean {
  return (
    endpoint.kind === 'port' &&
    endpoint.portId === 'X' &&
    project.design.components.some((c) => c.id === endpoint.componentId && c.externalMotorControl?.kind === 'pressure')
  );
}
export function networkParameter(
  definitionId: string,
  version: number,
  group: string,
  key: string,
): SIParameter | undefined {
  return networkDefinition(definitionId, version)?.groups[group]?.find((p) => p.key === key);
}
export function networkDefaultParameters(
  id: string,
  version: number,
): Readonly<Record<string, Readonly<Record<string, number>>>> | undefined {
  const definition = networkDefinition(id, version);
  return definition
    ? immutable(
        Object.fromEntries(
          Object.entries(definition.groups).map(([group, params]) => [
            group,
            Object.fromEntries(params.map((p) => [p.key, p.defaultValue])),
          ]),
        ),
      )
    : undefined;
}
export const physicalPipeModel = immutable({
  id: 'legacy-basic:pipe',
  version: '1.0.0-experimental',
});
export const physicalPipeParameters = immutable(legacySIGroup('pipe'));
