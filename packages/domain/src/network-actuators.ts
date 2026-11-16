import type { NetworkDefinition, SIParameter } from './network-registry.js';
import { immutable } from './reader.js';

const cylinderTypes = ['single-acting-cylinder', 'cushioned-cylinder', 'cushioned-double-rod-cylinder'] as const;
const rotaryType = 'limited-rotary-actuator';
export const teachingActuatorTypes = Object.freeze([...cylinderTypes, rotaryType]);
export function isTeachingActuatorType(type: string): boolean {
  return teachingActuatorTypes.some((id) => id === type);
}
export function isLinearActuatorType(type: string): boolean {
  return type === 'cylinder' || cylinderTypes.some((id) => id === type);
}
export function isNetworkActuatorType(type: string): boolean {
  return isLinearActuatorType(type) || type === 'motor' || type === rotaryType;
}

const si = (key: string, unit: string, minimum: number, maximum: number, defaultValue: number): SIParameter => ({
  key,
  unit,
  minimum,
  maximum,
  defaultValue,
});
const stroke = si('strokeM', 'm', 0.01, 5, 0.1);
const cap = si('capAreaM2', 'm²', 1e-5, 0.05, 0.001);
const linearMechanics = [
  si('massKg', 'kg', 0.1, 1e4, 20),
  si('loadDampingNsPerM', 'N·s/m', 0, 1e6, 1000),
  si('externalForceN', 'N', -1e6, 1e6, 0),
];
const storage = [si('portVolumeM3', 'm³', 1e-6, 0.05, 1.5e-4), si('initialPressurePa', 'Pa', 0, 70e6, 1e5)];
const cushion = [
  si('retractCushionLengthM', 'm', 0, 1, 0.015),
  si('extendCushionLengthM', 'm', 0, 1, 0.015),
  si('retractCushionAreaM2', 'm²', 1e-8, 1e-4, 2e-6),
  si('extendCushionAreaM2', 'm²', 1e-8, 1e-4, 2e-6),
  si('flowCoefficient', '1', 0.1, 1, 0.67),
];
function actuator(
  typeId: (typeof teachingActuatorTypes)[number],
  groups: NetworkDefinition['groups'],
): NetworkDefinition {
  const rotary = typeId === rotaryType;
  const single = typeId === 'single-acting-cylinder';
  const ports: NetworkDefinition['ports'] = rotary
    ? [
        { id: 'A', domain: 'hydraulic', positiveFlow: 'into-component', anchor: [-55, 28, -1, 0] },
        { id: 'B', domain: 'hydraulic', positiveFlow: 'into-component', anchor: [55, 28, 1, 0] },
      ]
    : [
        { id: 'A', domain: 'hydraulic', positiveFlow: 'into-component', anchor: [-55, 40, 0, 1] },
        ...(single
          ? []
          : [
              {
                id: 'B',
                domain: 'hydraulic' as const,
                positiveFlow: 'into-component' as const,
                anchor: [55, 40, 0, 1] as const,
              },
            ]),
      ];
  return {
    id: 'teaching:' + typeId,
    version: 1,
    typeId,
    model: { id: 'teaching:' + typeId, version: '0.1.0', solverId: 'hopsan' },
    evidence: 'runtime-candidate',
    ports,
    drawingBounds: rotary
      ? { left: -60, right: 60, top: -55, bottom: 34 }
      : { left: typeId === 'cushioned-double-rod-cylinder' ? -166 : -74, right: 166, top: -45, bottom: 45 },
    groups: { ...groups, storage },
    initialKind: rotary ? 'motor' : 'cylinder',
    control: 'none',
    flowPolicy: 'bidirectional',
  };
}

const actuatorDefinitions = [
  actuator('single-acting-cylinder', {
    geometry: [cap, stroke],
    mechanics: [
      ...linearMechanics,
      si('returnSpringNPerM', 'N/m', 1, 1e7, 10000),
      si('returnPreloadN', 'N', 0, 1e6, 200),
    ],
  }),
  actuator('cushioned-cylinder', {
    geometry: [cap, si('rodSideAreaM2', 'm²', 1e-5, 0.05, 0.00065), stroke],
    mechanics: linearMechanics,
    cushion,
  }),
  actuator('cushioned-double-rod-cylinder', {
    geometry: [si('equalAnnularAreaM2', 'm²', 1e-5, 0.05, 0.00075), stroke],
    mechanics: linearMechanics,
    cushion,
  }),
  actuator(rotaryType, {
    geometry: [si('angularTravelRad', 'rad', 0.05, 6.283185307179586, Math.PI / 2)],
    hydraulic: [si('sweptVolumeM3PerRad', 'm³/rad', 1e-8, 0.01, 5e-6)],
    mechanics: [
      si('inertiaKgM2', 'kg·m²', 0.001, 1e3, 0.08),
      si('viscousFrictionNmSPerRad', 'N·m·s/rad', 0, 1e5, 2),
      si('externalTorqueNm', 'N·m', -1e5, 1e5, 0),
    ],
  }),
];

export const shockMakeupParameters = immutable([
  si('reliefASettingPa', 'Pa', 1e5, 50e6, 3e6),
  si('reliefBSettingPa', 'Pa', 1e5, 50e6, 3e6),
  si('maximumAreaM2', 'm²', 1e-7, 1e-4, 1e-5),
  si('makeupAreaM2', 'm²', 1e-7, 1e-4, 1e-5),
  si('makeupCrackingPa', 'Pa', 0, 5e5, 1e4),
  si('flowCoefficient', '1', 0.1, 1, 0.67),
]);
const rotary = actuatorDefinitions.find((definition) => definition.typeId === rotaryType)!;
const protectedRotary: NetworkDefinition = {
  ...rotary,
  version: 2,
  model: { ...rotary.model, version: '0.2.0' },
  ports: [
    ...rotary.ports,
    {
      id: 'T',
      domain: 'hydraulic' as const,
      positiveFlow: 'into-component' as const,
      anchor: [0, 54, 0, 1] as const,
    },
  ],
  drawingBounds: { ...rotary.drawingBounds, bottom: 58 },
  groups: { ...rotary.groups, workProtection: [si('enabled', '1', 0, 1, 1), ...shockMakeupParameters] },
};
export const teachingActuatorDefinitions = immutable([
  ...actuatorDefinitions,
  protectedRotary,
  {
    ...protectedRotary,
    version: 3,
    model: { ...protectedRotary.model, version: '0.3.0' },
    groups: {
      ...protectedRotary.groups,
      protectionReturn: [si('internalTank', '1', 0, 1, 1), si('pressurePa', 'Pa', 0, 5e6, 1e5)],
    },
  },
]);
