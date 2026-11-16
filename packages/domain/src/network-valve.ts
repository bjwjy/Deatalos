import { immutable } from './reader.js';
import type { NetworkComponent } from './network-model.js';
import type { ValvePositionId } from './registry.js';
export interface DirectionalValveSpec {
  readonly id: string;
  readonly label: string;
  readonly ports: readonly string[];
  readonly slots: readonly ValvePositionId[];
  readonly defaults: readonly number[];
  readonly profiles: readonly (readonly number[])[];
}
const two: readonly ValvePositionId[] = ['extend', 'retract'];
const three: readonly ValvePositionId[] = ['extend', 'neutral', 'retract'];
/** Static port connectivity. Codes 0..7 retain their original v1 meaning. */
export const directionalFunctions: readonly {
  readonly code: number;
  readonly label: string;
  readonly paths: readonly (readonly [string, string])[];
}[] = immutable([
  { code: 0, label: '各口封闭', paths: [] },
  { code: 1, label: 'P↔A', paths: [['P', 'A']] },
  { code: 2, label: 'A↔T', paths: [['A', 'T']] },
  {
    code: 3,
    label: 'P↔B，A↔T',
    paths: [
      ['P', 'B'],
      ['A', 'T'],
    ],
  },
  {
    code: 4,
    label: 'P↔A，B↔T',
    paths: [
      ['P', 'A'],
      ['B', 'T'],
    ],
  },
  { code: 5, label: 'P↔T卸荷，其余封闭', paths: [['P', 'T']] },
  {
    code: 6,
    label: 'P↔B，A↔T，R封闭',
    paths: [
      ['P', 'B'],
      ['A', 'T'],
    ],
  },
  {
    code: 7,
    label: 'P↔A，B↔R，T封闭',
    paths: [
      ['P', 'A'],
      ['B', 'R'],
    ],
  },
  { code: 8, label: 'P↔B，其余封闭', paths: [['P', 'B']] },
  { code: 9, label: 'B↔T，其余封闭', paths: [['B', 'T']] },
  { code: 10, label: 'A↔B，其余封闭', paths: [['A', 'B']] },
  {
    code: 11,
    label: 'P、A、T互通',
    paths: [
      ['P', 'A'],
      ['A', 'T'],
    ],
  },
  {
    code: 12,
    label: 'P、A、B互通，其余封闭',
    paths: [
      ['P', 'A'],
      ['P', 'B'],
    ],
  },
  {
    code: 13,
    label: 'P、B、T互通，其余封闭',
    paths: [
      ['P', 'B'],
      ['B', 'T'],
    ],
  },
  {
    code: 14,
    label: 'A、B、T互通（浮动）',
    paths: [
      ['A', 'T'],
      ['B', 'T'],
    ],
  },
  {
    code: 15,
    label: 'P、A、B、T互通',
    paths: [
      ['P', 'A'],
      ['A', 'T'],
      ['B', 'T'],
    ],
  },
  {
    code: 16,
    label: 'P↔T、A↔B',
    paths: [
      ['P', 'T'],
      ['A', 'B'],
    ],
  },
  {
    code: 17,
    label: 'P、A、B、T、R互通',
    paths: [
      ['P', 'A'],
      ['A', 'T'],
      ['B', 'T'],
      ['B', 'R'],
    ],
  },
  { code: 18, label: 'B↔R，其余封闭', paths: [['B', 'R']] },
  { code: 19, label: 'A↔R，其余封闭', paths: [['A', 'R']] },
  { code: 20, label: 'P↔R，其余封闭', paths: [['P', 'R']] },
  {
    code: 21,
    label: 'A、B、T、R互通，P封闭',
    paths: [
      ['A', 'T'],
      ['B', 'T'],
      ['B', 'R'],
    ],
  },
]);
/** Three-way has all five partitions; four-way all fifteen partitions. */
export function directionalFunctionOptions(portCount: number) {
  const codes =
    portCount === 2
      ? [0, 1]
      : portCount === 3
        ? [0, 1, 2, 5, 11]
        : portCount === 4
          ? [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16]
          : portCount === 5
            ? [0, 1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
            : [];
  return directionalFunctions.filter((fn) => codes.includes(fn.code));
}
export const directionalValveCatalog: readonly DirectionalValveSpec[] = immutable([
  {
    id: 'teaching:directional-2-2',
    label: '二位二通阀',
    ports: ['P', 'A'],
    slots: two,
    defaults: [1, 0],
    profiles: [[0, 1]],
  },
  {
    id: 'teaching:directional-3-2',
    label: '三位二通阀',
    ports: ['P', 'A'],
    slots: three,
    defaults: [1, 0, 1],
    profiles: [[0, 1, 1]],
  },
  {
    id: 'teaching:directional-2-3',
    label: '二位三通阀',
    ports: ['P', 'A', 'T'],
    slots: two,
    defaults: [1, 2],
    profiles: [[1, 2]],
  },
  {
    id: 'teaching:directional-3-3',
    label: '三位三通阀',
    ports: ['P', 'A', 'T'],
    slots: three,
    defaults: [1, 0, 2],
    profiles: [[0, 1, 2]],
  },
  {
    id: 'teaching:directional-2-4',
    label: '二位四通阀',
    ports: ['P', 'A', 'T', 'B'],
    slots: two,
    defaults: [4, 3],
    profiles: [[3, 4]],
  },
  {
    id: 'teaching:directional-3-4',
    label: '三位四通阀',
    ports: ['P', 'A', 'T', 'B'],
    slots: three,
    defaults: [4, 0, 3],
    profiles: [
      [0, 3, 4],
      [3, 4, 5],
    ],
  },
  {
    id: 'teaching:directional-2-5',
    label: '二位五通阀',
    ports: ['P', 'A', 'T', 'B', 'R'],
    slots: two,
    defaults: [7, 6],
    profiles: [[6, 7]],
  },
  {
    id: 'teaching:directional-3-5',
    label: '三位五通阀',
    ports: ['P', 'A', 'T', 'B', 'R'],
    slots: three,
    defaults: [7, 0, 6],
    profiles: [[0, 6, 7]],
  },
]);
export function directionalValveSpec(id: string): DirectionalValveSpec | undefined {
  return directionalValveCatalog.find((spec) => spec.id === id);
}
export function networkValvePositions(component: NetworkComponent): readonly ValvePositionId[] {
  return directionalValveSpec(component.definition.id)?.slots ?? three;
}
export function directionalConfigurationValid(
  spec: DirectionalValveSpec,
  positions: Readonly<Record<string, number>> | undefined,
  version = 1,
): boolean {
  const values = spec.slots.map((slot) => positions?.[slot + 'Function']);
  if (values.some((value) => value === undefined || !Number.isInteger(value))) return false;
  if (version === 2)
    return values.every((value) => directionalFunctionOptions(spec.ports.length).some((fn) => fn.code === value));
  const signature = [...values].sort().join(',');
  return spec.profiles.some((profile) => [...profile].sort().join(',') === signature);
}
export function networkValvePaths(
  component: NetworkComponent,
  slot: ValvePositionId,
): readonly (readonly [string, string])[] {
  const spec = directionalValveSpec(component.definition.id);
  if (spec) {
    if (!spec.slots.includes(slot)) throw new Error('Unsupported position on validated valve');
    const value = component.parameters.positions?.[slot + 'Function'];
    const fn = directionalFunctions.find((item) => item.code === value);
    if (!fn) throw new Error('Validated directional function missing');
    return fn.paths;
  }
  const value = networkValveFunction(component, slot);
  return value > 0
    ? [
        ['P', 'A'],
        ['B', 'T'],
      ]
    : value < 0
      ? [
          ['P', 'B'],
          ['A', 'T'],
        ]
      : component.definition.id.endsWith('-m')
        ? [['P', 'T']]
        : [];
}
export function networkValveFunction(component: NetworkComponent, slot: ValvePositionId): number {
  if (directionalValveSpec(component.definition.id)) {
    if (!networkValvePositions(component).includes(slot)) throw new Error('Unsupported directional position');
    return slot === 'extend' ? 1 : slot === 'retract' ? -1 : 0;
  }
  if (component.definition.id === 'teaching:custom-o' || component.definition.id === 'teaching:custom-m') {
    const value = component.parameters.positions?.[slot + 'Function'];
    if (value !== -1 && value !== 0 && value !== 1) throw new Error('Validated valve function missing');
    return value;
  }
  return slot === 'extend' ? 1 : slot === 'retract' ? -1 : 0;
}
export function networkValveFunctionLabel(component: NetworkComponent, slot: ValvePositionId): string {
  if (directionalValveSpec(component.definition.id))
    return (
      directionalFunctions.find((item) => item.code === component.parameters.positions?.[slot + 'Function'])?.label ??
      '不支持的机能'
    );
  const value = networkValveFunction(component, slot);
  return value > 0
    ? 'P↔A，B↔T'
    : value < 0
      ? 'P↔B，A↔T'
      : component.definition.id.endsWith('-m')
        ? 'P↔T卸荷，A/B封闭'
        : '四口封闭';
}
