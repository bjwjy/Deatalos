import { unitScales, type Quantity } from './units.js';

export interface ParameterSpec {
  readonly legacyKey: string;
  readonly key: string;
  readonly label: string;
  readonly quantity: Quantity;
  readonly minimum: number;
  readonly maximum: number;
  readonly step: number;
  readonly defaultValue: number;
}

function parameter(
  legacyKey: string,
  key: string,
  label: string,
  quantity: Quantity,
  minimum: number,
  maximum: number,
  step: number,
  defaultValue: number,
): ParameterSpec {
  return Object.freeze({ legacyKey, key, label, quantity, minimum, maximum, step, defaultValue });
}

// The bounds/defaults here are in the explicitly declared legacy display unit.
// Schemas, parsers and the minimal legacy inspector bridge consume this registry.
export const parameterGroups: Readonly<Record<string, readonly ParameterSpec[]>> = Object.freeze({
  tank: [parameter('pressure', 'gaugePressurePa', '油箱表压', 'pressure', 0, 2, 0.01, 0)],
  pump: [
    parameter('displacement', 'displacementM3PerRev', '排量', 'displacement', 0.1, 2000, 0.1, 16),
    parameter('rpm', 'angularSpeedRadPerS', '转速', 'angularSpeed', 1, 10000, 1, 1450),
    parameter('etaV', 'volumetricEfficiency', '容积效率', 'ratio', 0.1, 1, 0.01, 0.92),
    parameter('etaTotal', 'totalEfficiency', '总效率', 'ratio', 0.1, 1, 0.01, 0.85),
  ],
  relief: [parameter('setting', 'openingDifferentialPa', '开启压差设定', 'pressure', 0.1, 70, 0.1, 12)],
  valve: [
    parameter('nominalFlow', 'nominalFlowM3PerS', '每通道标称流量', 'flow', 0.1, 3000, 1, 40),
    parameter('drop', 'nominalDropPa', '标称流量下通道压降', 'pressure', 0, 10, 0.05, 0.5),
  ],
  cylinder: [
    parameter('bore', 'boreM', '缸径', 'length', 5, 1000, 1, 63),
    parameter('rod', 'rodM', '杆径', 'length', 0, 999, 1, 36),
    parameter('stroke', 'strokeM', '行程', 'length', 1, 10000, 1, 500),
    parameter('loadExt', 'extensionResistanceN', '伸出阻力负载', 'force', 0, 10000, 0.1, 20),
    parameter('loadRet', 'retractionResistanceN', '缩回阻力负载', 'force', 0, 10000, 0.1, 10),
    parameter('eta', 'mechanicalEfficiency', '机械效率', 'ratio', 0.1, 1, 0.01, 0.95),
  ],
  motor: [
    parameter('displacement', 'displacementM3PerRev', '排量', 'displacement', 0.1, 2000, 0.1, 80),
    parameter('torque', 'resistanceTorqueNm', '双向阻力转矩', 'torque', 0, 100000, 1, 80),
    parameter('etaV', 'volumetricEfficiency', '容积效率', 'ratio', 0.1, 1, 0.01, 0.92),
    parameter('etaM', 'mechanicalEfficiency', '机械效率', 'ratio', 0.1, 1, 0.01, 0.9),
  ],
  pipe: [
    parameter('diameter', 'internalDiameterM', '实际内径', 'length', 2, 200, 1, 16),
    parameter('length', 'lengthM', '管路长度', 'pipeLength', 0, 1000, 0.1, 1),
    parameter('roughness', 'roughnessM', '绝对粗糙度', 'length', 0, 1, 0.001, 0.03),
    parameter('K', 'localLossCoefficient', '局部阻力系数 K', 'coefficient', 0, 1000, 0.1, 1),
  ],
  fluid: [
    parameter('density', 'densityKgPerM3', '油液密度', 'density', 400, 2000, 1, 870),
    parameter('viscosity', 'kinematicViscosityM2PerS', '运动黏度', 'viscosity', 1, 2000, 1, 46),
  ],
});

export const componentTypes = ['tank', 'pump', 'relief', 'valve', 'cylinder', 'motor'] as const;
Object.freeze(componentTypes);
export type ComponentType = (typeof componentTypes)[number];
export function isComponentType(value: unknown): value is ComponentType {
  return typeof value === 'string' && componentTypes.some((type) => type === value);
}
export const componentPorts: Readonly<Record<ComponentType, readonly string[]>> = Object.freeze({
  tank: ['T'],
  pump: ['P', 'S'],
  relief: ['P', 'T'],
  valve: ['P', 'T', 'A', 'B'],
  cylinder: ['A', 'B'],
  motor: ['A', 'B'],
});
export const componentNames: Readonly<Record<ComponentType, string>> = Object.freeze({
  tank: '油箱',
  pump: '定量泵',
  relief: '溢流阀',
  valve: '三位四通阀',
  cylinder: '双作用液压缸',
  motor: '液压马达',
});
export type ValvePositionId = 'extend' | 'neutral' | 'retract';
export interface ValvePosition {
  readonly id: ValvePositionId;
  readonly connections: readonly (readonly [string, string])[];
  readonly blockedPorts: readonly string[];
}
const extend: ValvePosition = {
  id: 'extend',
  connections: [
    ['P', 'A'],
    ['B', 'T'],
  ],
  blockedPorts: [],
};
const retract: ValvePosition = {
  id: 'retract',
  connections: [
    ['P', 'B'],
    ['A', 'T'],
  ],
  blockedPorts: [],
};
export const valveDefinitions = Object.freeze({
  'builtin:valve-o': {
    version: 1,
    defaultPositionId: 'neutral',
    positions: [extend, { id: 'neutral', connections: [], blockedPorts: ['P', 'T', 'A', 'B'] }, retract],
  },
  'builtin:valve-m': {
    version: 1,
    defaultPositionId: 'neutral',
    positions: [extend, { id: 'neutral', connections: [['P', 'T']], blockedPorts: ['A', 'B'] }, retract],
  },
});
export function definitionIds(type: ComponentType): readonly string[] {
  return type === 'valve' ? Object.keys(valveDefinitions) : [`builtin:${type}`];
}
export function defaultDefinitionId(type: ComponentType): string {
  return type === 'valve' ? 'builtin:valve-o' : `builtin:${type}`;
}
export function specs(group: string): readonly ParameterSpec[] {
  return parameterGroups[group] ?? [];
}
export function legacyParameterView() {
  const bounds: Record<string, readonly number[]> = {};
  const labels: Record<string, readonly string[]> = {};
  const groups: Record<
    string,
    { readonly defaults: Record<string, number>; readonly bounds: Record<string, readonly number[]> }
  > = {};
  for (const [group, list] of Object.entries(parameterGroups))
    groups[group] = {
      defaults: Object.fromEntries(list.map((spec) => [spec.legacyKey, spec.defaultValue])),
      bounds: Object.fromEntries(list.map((spec) => [spec.legacyKey, [spec.minimum, spec.maximum, spec.step]])),
    };
  for (const list of Object.values(parameterGroups))
    for (const spec of list) {
      bounds[spec.legacyKey] = [spec.minimum, spec.maximum, spec.step];
      labels[spec.legacyKey] = [spec.label, unitScales[spec.quantity].legacy];
    }
  const types = Object.fromEntries(
    componentTypes.map((type) => [
      type,
      {
        name: componentNames[type],
        ports: componentPorts[type],
        params: Object.fromEntries(specs(type).map((spec) => [spec.legacyKey, spec.defaultValue])),
      },
    ]),
  );
  return { bounds, labels, groups, types };
}

// Freeze nested registry data too; consumers cannot mutate the shared contract.
function freeze(value: unknown): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) Object.freeze(value);
  if (value && typeof value === 'object') for (const child of Object.values(value)) freeze(child);
}
freeze(parameterGroups);
freeze(componentPorts);
freeze(valveDefinitions);
