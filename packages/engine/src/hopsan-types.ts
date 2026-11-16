import type { Diagnostic, MotorCurveSegment, networkModelSetVersion, NetworkNativeStepS } from '@hyd/domain';
import type { ConnectionGraph } from './network-graph.js';
export const networkPortPressureLimitPa = 70e6;
export interface NativePort {
  readonly component: string;
  readonly port: string;
}
export interface NativeComponent {
  readonly id: string;
  readonly type: string;
  readonly inputs: Readonly<Record<string, number>>;
  readonly constants: Readonly<Record<string, number>>;
  readonly start: readonly (readonly [string, string, number])[];
}
export interface PortBinding {
  readonly key: string;
  readonly pressure: readonly NativePort[];
  readonly flow: readonly { readonly ref: NativePort; readonly sign: number }[];
  readonly unknownFlow: string | null;
  readonly cavity?: NativePort;
}
export interface MappingOptions {
  readonly lowPressureModel?: 'equivalent-cavity-v1';
  readonly nativeStepS: NetworkNativeStepS;
  readonly junctionPolicy: 'strict' | 'tlm-limit';
  readonly initialPressurePa: number;
  readonly volumeScale: number;
  readonly constraintPressureTolerancePa: number;
}
export interface MappingPlan {
  readonly format: 'E04A-Hopsan-Mapping';
  readonly version: 1;
  readonly graph: ConnectionGraph;
  readonly options: MappingOptions;
  readonly pressureOffsetPa: number;
  readonly components: readonly NativeComponent[];
  readonly connections: readonly (readonly [string, string, string, string])[];
  readonly ports: readonly PortBinding[];
  readonly controls: readonly {
    readonly componentId: string;
    readonly ref: NativePort;
    readonly travelM: number | null;
    readonly readBack?: 'displacement';
  }[];
  readonly cylinders: readonly { readonly componentId: string; readonly ref: NativePort; readonly source?: 'signal' }[];
  readonly motors: readonly {
    readonly componentId: string;
    readonly ref: NativePort;
    readonly angleOriginRad: number;
    readonly source?: 'signal';
    readonly externalDisplacement?: {
      readonly input: NativePort;
      readonly voltage: NativePort;
      readonly minimum: number;
      readonly maximum: number;
    };
    readonly displacementCurve?: {
      readonly input: NativePort;
      readonly pressure: NativePort;
      readonly voltage?: NativePort;
      readonly segments: readonly MotorCurveSegment[];
    };
  }[];
  readonly integratedPorts: readonly {
    readonly componentId: string;
    readonly portId: string;
    readonly core: readonly NativePort[];
    readonly storage: NativePort;
    readonly makeup: NativePort | null;
  }[];
  readonly reliefBranches: readonly { readonly componentId: string; readonly ref: NativePort; readonly portId?: 'H' }[];
  readonly modelSetVersion: ReturnType<typeof networkModelSetVersion>;
  readonly approximations: readonly {
    readonly netId: string;
    readonly kind: 'numerical-compliance' | 'constraint-resistance';
    readonly value: number;
    readonly unit: 'm³' | 'Pa·s/m³';
    readonly basis: string;
  }[];
  readonly diagnostics: readonly Diagnostic[];
  readonly constraints: readonly {
    readonly netId: string;
    readonly ports: readonly [NativePort, NativePort];
    readonly pressureBudgetPa: number;
  }[];
}
export type Terminal = {
  readonly category: 'Q' | 'C' | 'boundary';
  readonly ref: NativePort | null;
  readonly pressurePa: number | null;
};
