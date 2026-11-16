import type { NetworkSimulation } from '@hyd/application' with { 'resolution-mode': 'import' };

export interface KernelScheduleTimer {
  nowMs(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
const systemTimer: KernelScheduleTimer = {
  nowMs: () => performance.now(),
  schedule(callback, delayMs) {
    if (delayMs === 0) {
      const pulse = setImmediate(callback);
      return () => clearImmediate(pulse);
    }
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
type ScheduledRuntime = Pick<NetworkSimulation, 'running' | 'busy' | 'clock' | 'advanceTime' | 'pause'>;
interface TickLimit {
  readonly targetTick: number;
  tick(): number | null;
}

/** Wall time paces dispatch; native compute time never becomes catch-up debt.
 * One fixed host interval per pulse, with the application's unchanged idle-gap
 * protection. Cancellation retires rearming; callers drain before commands. */
export class KernelRunScheduler {
  #generation = 0;
  #cancelTimer: (() => void) | undefined;
  #pending: Promise<void> = Promise.resolve();
  #limit: TickLimit | undefined;
  constructor(
    readonly runtime: ScheduledRuntime,
    readonly onFailure: (cause?: unknown) => void,
    readonly timer: KernelScheduleTimer = systemTimer,
  ) {}
  start(speed: number, limit?: TickLimit): void {
    this.stop();
    if (limit && (speed !== 1 || !Number.isSafeInteger(limit.targetTick) || limit.targetTick < 0)) {
      this.runtime.pause();
      this.onFailure(new Error('Invalid bounded schedule'));
      return;
    }
    this.#limit = limit;
    this.#arm(this.#generation, speed, this.timer.nowMs(), this.runtime.clock.config.stepSeconds * 1000);
  }
  stop(): void {
    this.#generation++;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
  }
  async drain(): Promise<void> {
    await this.#pending;
  }
  #limited(): boolean {
    if (!this.#limit) return false;
    const tick = this.#limit.tick();
    if (tick !== null && tick < this.#limit.targetTick) return false;
    this.stop();
    this.runtime.pause();
    if (tick === null) this.onFailure(new Error('Bounded runtime identity unavailable'));
    return true;
  }
  #arm(generation: number, speed: number, idleSinceMs: number, delayMs: number): void {
    const dueMs = idleSinceMs + delayMs;
    this.#cancelTimer = this.timer.schedule(() => {
      if (generation !== this.#generation || !this.runtime.running) return;
      this.#cancelTimer = undefined;
      if (this.#limited()) return;
      const startedMs = this.timer.nowMs();
      if (this.runtime.busy) {
        // Explicit native operations own this time too; do not race their work.
        this.#arm(generation, speed, startedMs, 10);
        return;
      }
      const config = this.runtime.clock.config;
      const idleSeconds = (startedMs - idleSinceMs) / 1000;
      const elapsedSeconds =
        !Number.isFinite(idleSeconds) || idleSeconds < 0 || idleSeconds > config.maxGapSeconds
          ? idleSeconds
          : config.stepSeconds;
      this.#pending = (async () => {
        try {
          const result = await this.runtime.advanceTime(elapsedSeconds, speed);
          if (generation !== this.#generation) return;
          if (result.ok && this.#limited()) return;
          if (!result.ok || !this.runtime.running) {
            this.stop();
            this.onFailure();
            return;
          }
          const completedMs = this.timer.nowMs();
          const intervalMs = config.stepSeconds * 1000;
          // Recover at most one interval of timer overshoot. Each pulse still
          // advances one interval, and slow native work never builds debt.
          const timerOvershootMs = Math.min(intervalMs, Math.max(0, startedMs - dueMs));
          const delay = Math.max(0, intervalMs - (completedMs - startedMs) - timerOvershootMs);
          this.#arm(generation, speed, completedMs, delay);
        } catch (cause: unknown) {
          if (generation !== this.#generation) return;
          this.stop();
          this.onFailure(cause);
        }
      })();
    }, delayMs);
  }
}
