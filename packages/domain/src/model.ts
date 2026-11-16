import type { ComponentType, ValvePositionId } from './registry.js';

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Parameters = Readonly<Record<string, number>>;
export interface Component {
  readonly id: string;
  readonly typeId: ComponentType;
  readonly definitionId: string;
  readonly definitionVersion: 1;
  readonly label: string;
  readonly params: Parameters;
}
export interface Endpoint {
  readonly componentId: string;
  readonly portId: string;
}
export interface Connection {
  readonly id: string;
  readonly from: Endpoint;
  readonly to: Endpoint;
  readonly params: Parameters;
}
export type ActuatorInitial =
  | { readonly componentId: string; readonly kind: 'cylinder'; readonly positionM: number }
  | { readonly componentId: string; readonly kind: 'motor'; readonly angleRad: number };
export interface InitialConditions {
  readonly actuators: readonly ActuatorInitial[];
  readonly valves: readonly { readonly componentId: string; readonly positionId: ValvePositionId }[];
}
export interface ProjectDesign {
  readonly fluid: Parameters;
  readonly components: readonly Component[];
  readonly connections: readonly Connection[];
  readonly initialConditions: InitialConditions;
  // Empty in F02. Unknown physics is refused until a definition/model is supported.
  readonly embeddedDefinitions: readonly never[];
}
export interface ProjectLayout {
  // World coordinates are visual DIP values, not SI lengths.
  readonly components: readonly { readonly componentId: string; readonly x: number; readonly y: number }[];
  readonly routes: readonly { readonly connectionId: string; readonly mode: 'auto' }[];
}
export interface ProjectDocument {
  readonly format: 'HydraulicWorkbench';
  readonly version: 2;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly note?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly design: ProjectDesign;
  readonly layout: ProjectLayout;
  readonly provenance: {
    readonly createdWithAppVersion: string;
    readonly preferredSolverId: 'legacy-basic';
    readonly modelVersion: '1.0.0-experimental';
  };
  readonly extensions: Readonly<Record<string, Json>>;
}
export interface Diagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly field: string;
  readonly message: string;
  readonly suggestion: string;
}
export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };
export const limits = Object.freeze({
  bytes: 2_000_000,
  components: 30,
  connections: 60,
  depth: 32,
  nodes: 50_000,
  note: 16_384,
  canvasCoordinate: 1_000_000,
});

// Runtime/result/editor data deliberately have no fields in ProjectDocument.
export interface SimulationState {
  readonly tick: number;
  readonly timeS: number;
  readonly actuatorStates: readonly ActuatorInitial[];
}
