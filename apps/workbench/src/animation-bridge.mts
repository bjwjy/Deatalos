// Transitional ESM kinematic animation only. F05 owns fixed-step scheduling/control events.
// Input/output are SI. Keep the former 0.1 s cap and Euler/clamp/modulo behavior.
import type { SimulationState } from '@hyd/domain';
import type { Solution } from '@hyd/engine';
export function animatedState(state: SimulationState, solution: Solution, dt: number): SimulationState {
  if (!Number.isFinite(dt) || dt < 0) throw new TypeError('Animation seconds must be finite and nonnegative');
  const seconds = Math.min(0.1, dt);
  return {
    tick: state.tick + 1,
    timeS: state.timeS + seconds,
    actuatorStates: state.actuatorStates.map((a) => {
      if (a.kind === 'cylinder') {
        if (solution.speedMPerS.kind !== 'known' || solution.strokeM.kind !== 'known') return a;
        return {
          ...a,
          positionM: Math.max(0, Math.min(solution.strokeM.value, a.positionM + solution.speedMPerS.value * seconds)),
        };
      }
      if (solution.angularSpeedRadPerS.kind !== 'known') return a;
      return { ...a, angleRad: (a.angleRad + solution.angularSpeedRadPerS.value * seconds) % (2 * Math.PI) };
    }),
  };
}
