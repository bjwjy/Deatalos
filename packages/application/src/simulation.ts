import { diagnostic, immutable, type Result, type SimulationState } from '@hyd/domain';
import type { Solution } from '@hyd/engine';

export interface SimulationConfig {
  readonly stepSeconds: number;
  readonly sampleEveryTicks: number;
  readonly maxGapSeconds: number;
  readonly maxStepsPerPulse: number;
}
export function simulationConfig(input: unknown): Result<SimulationConfig> {
  if (input !== undefined && input !== 0.01 && input !== 0.005)
    return {
      ok: false,
      diagnostics: [diagnostic('STEP_INVALID', '/simulation/stepSeconds', '仅支持0.01s及减半对照0.005s固定步长。')],
    };
  const stepSeconds = input === 0.005 ? 0.005 : 0.01;
  return {
    ok: true,
    value: immutable({
      stepSeconds,
      sampleEveryTicks: Math.round(0.05 / stepSeconds),
      maxGapSeconds: 0.25,
      maxStepsPerPulse: 50,
    }),
  };
}

/** Elapsed monotonic seconds are supplied by the shell. Never reads a clock. */
export class FixedClock {
  #remainder = 0;
  constructor(readonly config: SimulationConfig) {}
  get remainderSeconds(): number {
    return this.#remainder;
  }
  clear(): void {
    this.#remainder = 0;
  }
  consume(elapsedSeconds: number, speed: number): Result<number> {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || ![0.25, 0.5, 1, 2].includes(speed))
      return this.#failure('CLOCK_INVALID', '时钟间隔或演示倍速无效，已暂停。');
    if (elapsedSeconds > this.config.maxGapSeconds)
      return this.#failure('CLOCK_GAP_PAUSED', '计算间隔超过0.25s，已暂停且丢弃间隔；请手动继续。');
    const accumulated = this.#remainder + elapsedSeconds * speed;
    const steps = Math.floor(accumulated / this.config.stepSeconds + 1e-9);
    if (steps > this.config.maxStepsPerPulse)
      return this.#failure('CLOCK_BUDGET_PAUSED', '本次所需步数超过50步，已暂停且丢弃间隔；请降低倍速后继续。');
    this.#remainder = Math.max(0, accumulated - steps * this.config.stepSeconds);
    return { ok: true, value: steps };
  }
  #failure(code: string, message: string): Result<never> {
    this.clear();
    return { ok: false, diagnostics: [diagnostic(code, '/simulation/clock', message)] };
  }
}

/** SI kinematic Euler/clamp/modulo, retaining the former quasi-static assumptions.
 * The application supplies a fixed h; this adds no pressure/flow transient model. */
export function advanceState(state: SimulationState, solution: Solution, seconds: number): SimulationState {
  return {
    tick: state.tick + 1,
    timeS: (state.tick + 1) * seconds,
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
