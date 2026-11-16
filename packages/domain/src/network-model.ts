import type { NetworkRotation } from './network-geometry.js';
import type { Diagnostic, Json, Parameters } from './model.js';
import type { ValvePositionId } from './registry.js';
import type { ValveActuation } from './network-valve-actuation.js';
import type { NetworkSequence } from './network-sequence.js';
import type { MotorDisplacementCurve } from './motor-displacement-curve.js';
export interface ModelReference {
  readonly id: string;
  readonly version: string;
}
export type NetworkParameterRule = {
  readonly group: string;
  readonly key: string;
} & ({ readonly mode: 'locked' } | { readonly mode: 'variable'; readonly minimum: number; readonly maximum: number });
export interface ControlPressureRange {
  readonly lowPa: number;
  readonly highPa: number;
}
export type ExternalMotorControl =
  | ({ readonly kind: 'pressure' } & ControlPressureRange)
  | ({ readonly kind: 'voltage' } & (ControlPressureRange | { readonly lowPa?: never; readonly highPa?: never }));
export interface NetworkComponent {
  readonly controllerColor?: number;
  readonly controller?: NetworkSequence;
  readonly id: string;
  readonly typeId: string;
  readonly definition: {
    readonly id: string;
    readonly version: number;
  };
  readonly model: ModelReference;
  readonly label: string;
  readonly parameters: Readonly<Record<string, Parameters>>;
  readonly motorDisplacementCurve?: MotorDisplacementCurve;
  readonly externalMotorControl?: ExternalMotorControl;
  readonly pressureSwitchOutput?: { readonly mode: 'switch' | 'analog' } & ControlPressureRange;
  readonly valveActuation?: ValveActuation;
  readonly parameterRules?: readonly NetworkParameterRule[];
}
export type NetworkEndpoint =
  | {
      readonly kind: 'port';
      readonly componentId: string;
      readonly portId: string;
    }
  | {
      readonly kind: 'node';
      readonly nodeId: string;
    };
export type NetworkConnection = {
  readonly id: string;
  readonly from: NetworkEndpoint;
  readonly to: NetworkEndpoint;
} & (
  | {
      readonly kind: 'ideal';
    }
  | { readonly kind: 'signal' }
  | {
      readonly kind: 'pipe';
      readonly model: ModelReference;
      readonly parameters: Parameters;
    }
);
export type NetworkInitial = {
  readonly componentId: string;
} & (
  | {
      readonly kind: 'valve';
      readonly positionId: ValvePositionId;
    }
  | {
      readonly kind: 'cylinder';
      readonly positionM: number;
      readonly velocityMPerS: number | null;
      readonly capPressurePa: number | null;
      readonly rodPressurePa: number | null;
    }
  | {
      readonly kind: 'motor';
      readonly angleRad: number;
      readonly angularSpeedRadPerS: number | null;
    }
  | {
      readonly kind: 'throttle';
      readonly openingAreaM2: number;
    }
  | {
      readonly kind: 'accumulator';
      readonly oilVolumeM3: number;
    }
  | {
      readonly kind: 'volume';
      readonly pressurePa: number | null;
    }
);
export interface NetworkPressureProbe {
  readonly id: string;
  /** Null for an independent gauge; legacy owner IDs remain readable. */
  readonly controllerId: string | null;
  readonly number: number;
  readonly name: string;
  readonly nodeId: string | null;
  readonly port?: Extract<NetworkEndpoint, { kind: 'port' }>;
}
export interface NetworkTextAnnotation {
  readonly id: string;
  readonly kind: 'text';
  readonly version: 1;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly text: string;
  readonly fontSize: number;
  readonly color: string;
  readonly align: 'left' | 'center' | 'right';
  readonly border: boolean;
  readonly background: '#ffffff' | null;
}
export interface NetworkProject {
  readonly controlProbes?: readonly NetworkPressureProbe[];
  readonly format: 'HydraulicWorkbench';
  readonly version: 3;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly note?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly design: {
    readonly fluid: {
      readonly densityKgPerM3: number;
      readonly kinematicViscosityM2PerS: number;
      readonly bulkModulusPa: number | null;
    };
    readonly pressureReference: {
      readonly kind: 'gauge' | 'kernel-numeric';
      readonly absoluteReferencePa: number | null;
    };
    readonly components: readonly NetworkComponent[];
    readonly nodes: readonly {
      readonly id: string;
      readonly kind: 'ideal-hydraulic';
      readonly label: string;
    }[];
    readonly connections: readonly NetworkConnection[];
    readonly initialConditions: readonly NetworkInitial[];
  };
  readonly layout: {
    readonly texts?: readonly NetworkTextAnnotation[];
    readonly probes?: readonly {
      readonly probeId: string;
      readonly x: number;
      readonly y: number;
      readonly signalPoints?: readonly { readonly x: number; readonly y: number }[];
    }[];
    readonly components: readonly {
      readonly componentId: string;
      readonly rotation?: NetworkRotation;
      /** Drawing reflection before the quarter turn; absent means no reflection. */
      readonly mirrored?: true;
      /** Drawing scale only, 0.5..1.5; omitted uses the registered display default. */
      readonly scale?: number;
      readonly x: number;
      readonly y: number;
    }[];
    readonly nodes: readonly {
      readonly nodeId: string;
      readonly x: number;
      readonly y: number;
    }[];
    readonly routes: readonly NetworkRoute[];
    readonly viewport?: { readonly centerX: number; readonly centerY: number; readonly zoom: number };
  };
  readonly provenance: {
    readonly createdWithAppVersion: string;
    readonly preferredSolverId: 'legacy-basic' | 'hopsan';
  };
  readonly extensions: Readonly<Record<string, Json>>;
}
/** Drawing geometry only; never a physical pipe length or a connection endpoint. */
export type NetworkRoute = { readonly connectionId: string } & (
  | { readonly mode: 'auto' | 'avoid' }
  | { readonly mode: 'manual'; readonly points: readonly { readonly x: number; readonly y: number }[] }
);
export type NetworkControl = {
  readonly componentId: string;
} & (
  | {
      readonly kind: 'position';
      readonly positionId: ValvePositionId;
    }
  | {
      readonly kind: 'opening-area';
      readonly areaM2: number;
    }
  | {
      readonly kind: 'displacement';
      readonly source: 'manual' | 'controller' | 'voltage';
      /** m³/rev for manual, fraction 0–1 for a controller, V for voltage. */
      readonly value: number;
    }
);
export interface NetworkIdentity {
  readonly documentSessionId: string;
  readonly physicsRevision: number;
  readonly simulationSessionId: string;
  readonly tick: number;
  readonly timeS: number;
  readonly controlSequence: number;
  readonly requestSequence: number;
}
export interface NetworkClock {
  readonly advanceIntervalS: number;
  readonly nativeStepS: number;
}
export type NetworkState = {
  readonly componentId: string;
} & (
  | {
      readonly kind: 'cylinder';
      readonly positionM: number;
      readonly velocityMPerS: number;
    }
  | {
      readonly kind: 'motor';
      readonly angleRad: number;
      readonly angularSpeedRadPerS: number;
    }
  | {
      readonly kind: 'accumulator';
      readonly oilVolumeM3: number;
      readonly gasVolumeM3: number;
      readonly gasPressureAbsolutePa: number;
      readonly compressionEnergyJ: number;
    }
  | {
      readonly kind: 'valve';
      readonly effectivePositionId: ValvePositionId | null;
      readonly spoolPositionM: number;
    }
);
export type MeasurementLocation =
  | {
      readonly kind: 'component';
      readonly componentId: string;
    }
  | {
      readonly kind: 'port';
      readonly componentId: string;
      readonly portId: string;
    }
  | {
      readonly kind: 'node';
      readonly nodeId: string;
    }
  | {
      readonly kind: 'connection';
      readonly connectionId: string;
    };
export interface NetworkReading {
  readonly location: MeasurementLocation;
  readonly quantity:
    | 'pressure'
    | 'flow'
    | 'core-flow'
    | 'differential-pressure'
    | 'pressure-switch-state'
    | 'control-voltage'
    | 'unloading-state'
    | 'makeup-flow'
    | 'relief-flow'
    | 'force'
    | 'torque'
    | 'position'
    | 'velocity'
    | 'power'
    | 'oil-volume'
    | 'cavity-volume'
    | 'gas-volume'
    | 'gas-pressure'
    | 'compression-energy'
    | 'displacement'
    | 'angular-position'
    | 'angular-velocity';
  readonly unit: '1' | 'V' | 'Pa' | 'm³/s' | 'N' | 'N·m' | 'm' | 'm/s' | 'W' | 'rad' | 'rad/s' | 'm³' | 'J' | 'm³/rev';
  readonly value:
    | {
        readonly kind: 'known';
        readonly value: number;
      }
    | {
        readonly kind: 'unknown';
        readonly reason: string;
      };
}
export interface NetworkSnapshot {
  readonly identity: NetworkIdentity;
  readonly clock: NetworkClock;
  readonly solver: {
    readonly id: 'legacy-basic' | 'hopsan';
    readonly version: string;
    readonly modelSetVersion: string;
  };
  readonly source: 'kernel';
  readonly initialization: 'transient' | 'settled';
  readonly appliedControls: readonly NetworkControl[];
  readonly states: readonly NetworkState[];
  readonly readings: readonly NetworkReading[];
  readonly diagnostics: readonly Diagnostic[];
}
