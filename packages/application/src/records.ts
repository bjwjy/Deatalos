import type { ProjectDocument, SimulationState, Result, ValvePositionId } from '@hyd/domain';
import type { Controls, Solution } from '@hyd/engine';
import type { SimulationConfig } from './simulation.js';

export interface ControlEvent {
  readonly sequence: number;
  readonly tick: number;
  readonly componentId: string;
  readonly positionId: ValvePositionId;
  readonly phase: 'preview' | 'step';
}
export interface Identity {
  readonly documentSessionId: string;
  readonly physicsRevision: number;
  readonly runId: number;
  readonly controlRevision: number;
  readonly stateRevision: number;
  readonly requestSequence: number;
}
export interface Sample {
  readonly timeS: number;
  readonly tick: number;
  readonly pumpGaugePressurePa: number;
  readonly actuatorFlowM3PerS: number;
  readonly shaftPowerW: number;
  readonly actuatorStates: SimulationState['actuatorStates'];
  readonly angularSpeedRadPerS: Solution['angularSpeedRadPerS'];
  readonly controls: Controls;
  readonly controlSequence: number;
  readonly source: 'scheduled' | 'single-step' | 'manual';
}
export interface HistoricalRun {
  readonly documentSessionId: string;
  readonly runId: number;
  readonly physicsRevision: number;
  readonly document: ProjectDocument;
  readonly controls: Controls;
  readonly result: Result<Solution>;
  readonly samples: readonly Sample[];
  readonly truncated: boolean;
  readonly documentRevision: number;
  readonly layoutRevision: number;
  readonly preview: RunPoint;
  readonly lastStep: RunPoint | null;
  readonly config: SimulationConfig;
  readonly initialControls: Controls;
  readonly initialState: SimulationState;
  readonly controlEvents: readonly ControlEvent[];
  readonly eventsTruncated: boolean;
  readonly samplesDropped: number;
}

export interface RunPoint {
  readonly identity: Identity;
  readonly state: SimulationState;
  readonly controls: Controls;
  readonly result: Result<Solution>;
  readonly controlSequence: number;
  readonly source: 'step' | 'static-preview';
}
