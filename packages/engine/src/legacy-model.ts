import type { ComponentType, Parameters } from '@hyd/domain';

// Private engineering-unit representation. No layout, file identity or UI data.
export interface LegacyComponent {
  readonly id: string;
  readonly type: ComponentType;
  readonly params: Parameters;
  readonly center: 'closed' | 'tandem';
}
export interface LegacyWire {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly params: Parameters;
}
export interface LegacyModel {
  readonly components: readonly LegacyComponent[];
  readonly wires: readonly LegacyWire[];
  readonly fluid: Parameters;
}
export const linkKeys = ['supply', 'reliefIn', 'reliefOut', 'return', 'suction', 'A', 'B'] as const;
export type LinkKey = (typeof linkKeys)[number];
export interface Link {
  readonly wire: LegacyWire;
  readonly a: string;
  readonly b: string;
}
export interface Topology {
  readonly tank: LegacyComponent;
  readonly pump: LegacyComponent;
  readonly relief: LegacyComponent;
  readonly valve: LegacyComponent;
  readonly act: LegacyComponent;
  readonly links: Readonly<Record<LinkKey, Link>>;
  readonly reversed: boolean;
}
export function parameter(values: Parameters, key: string): number {
  const value = values[key];
  // Only called after parseDocument and topology refinement. Missing keys are a defect.
  if (value === undefined) throw new Error(`Validated legacy parameter missing: ${key}`);
  return value;
}
