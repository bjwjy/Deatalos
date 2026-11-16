import {
  diagnostic,
  immutable,
  sequenceConditionText,
  validateNetworkSequence,
  parseNetworkProject,
  networkProbePressure,
  type NetworkProject,
  type NetworkSnapshot,
  type NetworkSequence,
  type NetworkSequenceStep,
  type SequenceLeafCondition,
  type SequenceRunView,
  type Result,
} from '@hyd/domain';

export type SequenceDecision =
  | { readonly kind: 'stay' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'next'; readonly index: number; readonly cycle: number; readonly step: NetworkSequenceStep };
/** Deterministic control state. Only accepted kernel snapshots supply time/position/pressure. */
export class NetworkSequenceRun {
  #status: SequenceRunView['status'] = 'running';
  #index = 0;
  #cycle = 1;
  #enteredS: number;
  #lastS: number;
  #lastTick: number;
  #controlSequence: number;
  #matchedSince = new Map<number, number>();
  #message = '按已确认的阀位运行，条件只读取有效仿真结果。';
  private constructor(
    readonly project: NetworkProject,
    readonly program: NetworkSequence,
    readonly runId: string,
    readonly anchor: NetworkSnapshot['identity'],
    point: NetworkSnapshot,
  ) {
    this.#enteredS = this.#lastS = point.identity.timeS;
    this.#lastTick = point.identity.tick;
    this.#controlSequence = point.identity.controlSequence;
  }
  static create(
    project: NetworkProject,
    input: unknown,
    runId: string,
    point: NetworkSnapshot,
    controllerId?: string,
  ): Result<NetworkSequenceRun> {
    const parsed = validateNetworkSequence(project, input, controllerId);
    if (!parsed.ok) return parsed;
    if (!/^[-\w]{1,40}$/.test(runId))
      return { ok: false, diagnostics: [diagnostic('IDENTITY_INVALID', '/sequence', '序列运行编号无效。')] };
    return { ok: true, value: new NetworkSequenceRun(project, parsed.value, runId, point.identity, point) };
  }
  get step(): NetworkSequenceStep {
    const step = this.program.steps[this.#index];
    if (!step) throw new Error('Validated sequence cursor is out of bounds');
    return step;
  }
  get status() {
    return this.#status;
  }
  view(): SequenceRunView {
    return immutable({
      runId: this.runId,
      status: this.#status,
      cycle: this.#cycle,
      cycles: this.program.cycles,
      stepIndex: this.#index,
      stepName: this.step.name,
      elapsedS: Math.max(0, this.#lastS - this.#enteredS),
      condition: sequenceConditionText(this.step.until, this.project),
      message: this.#message,
    });
  }
  pause(): void {
    if (this.#status === 'running') {
      this.#status = 'paused';
      this.#message = '已暂停；保持最后已确认阀位，继续时保留本步和条件计时。';
    }
  }
  resume(point: NetworkSnapshot): void {
    if (this.#status === 'paused') {
      const gap = Math.max(0, point.identity.timeS - this.#lastS);
      this.#enteredS += gap;
      for (const [key, since] of this.#matchedSince) this.#matchedSince.set(key, since + gap);
      this.acknowledge(point);
      this.#status = 'running';
      this.#message = '继续当前步骤。';
    }
  }
  stop(message = '序列已停止；保持最后已确认阀位，仿真不再推进。'): void {
    this.#status = 'stopped';
    this.#message = message;
  }
  fail(message: string): void {
    this.#status = 'failed';
    this.#message = message + '；保持最后已确认阀位并停止推进。';
  }
  /** A step becomes current only after its complete command batch is acknowledged by the existing control protocol. */
  acknowledge(point: NetworkSnapshot, next?: Extract<SequenceDecision, { kind: 'next' }>): void {
    if (next) {
      this.#index = next.index;
      this.#cycle = next.cycle;
      this.#enteredS = point.identity.timeS;
      this.#matchedSince.clear();
    }
    this.#lastS = point.identity.timeS;
    this.#lastTick = point.identity.tick;
    this.#controlSequence = point.identity.controlSequence;
  }
  evaluate(point: NetworkSnapshot): Result<SequenceDecision> {
    if (this.#status !== 'running') return { ok: true, value: { kind: 'stay' } };
    const id = point.identity;
    const failure = (message: string): Result<never> => {
      this.fail(message);
      return { ok: false, diagnostics: [diagnostic('SEQUENCE_FAILED', '/sequence/' + this.step.id, message)] };
    };
    if (
      id.documentSessionId !== this.anchor.documentSessionId ||
      id.physicsRevision !== this.anchor.physicsRevision ||
      id.simulationSessionId !== this.anchor.simulationSessionId
    )
      return failure('条件结果不属于本次工程/运行身份');
    if (id.tick <= this.#lastTick) return { ok: true, value: { kind: 'stay' } };
    if (id.controlSequence !== this.#controlSequence || !Number.isFinite(id.timeS) || id.timeS < this.#lastS)
      return failure('控制源冲突或仿真时间倒退');
    this.#lastTick = id.tick;
    this.#lastS = id.timeS;
    const condition = this.step.until,
      elapsed = id.timeS - this.#enteredS;
    const evaluateLeaf = (condition: SequenceLeafCondition, index: number): Result<boolean> => {
      if (condition.kind === 'time') return { ok: true, value: elapsed + 1e-9 >= condition.durationS };
      let value: number;
      if (condition.kind === 'pressure-switch') {
        const reading = point.readings.find(
          (r) =>
            r.quantity === 'pressure-switch-state' &&
            r.location.kind === 'component' &&
            r.location.componentId === condition.componentId,
        )?.value;
        if (reading?.kind !== 'known' || (reading.value !== 0 && reading.value !== 1))
          return failure('压力开关触点缺少当前有效状态，自动控制已停止');
        value = reading.value;
      } else if (condition.kind === 'probe-pressure') {
        const reading = networkProbePressure(this.project, condition.probeId, point);
        if (reading.kind !== 'known') return failure('压力表读数未知或连接失效，自动控制已停止');
        value = reading.value;
      } else if (condition.kind === 'position') {
        const state = point.states.find((s) => s.componentId === condition.componentId && s.kind === 'cylinder');
        if (!state || state.kind !== 'cylinder' || !Number.isFinite(state.positionM))
          return failure('位置条件缺少当前有效缸位置');
        value = state.positionM;
      } else {
        const reading = point.readings.find(
          (r) =>
            r.quantity === (condition.kind === 'flow' ? 'flow' : 'pressure') &&
            r.unit === (condition.kind === 'flow' ? 'm³/s' : 'Pa') &&
            r.location.kind === 'port' &&
            r.location.componentId === condition.componentId &&
            r.location.portId === condition.portId,
        );
        if (!reading || reading.value.kind !== 'known' || !Number.isFinite(reading.value.value))
          return failure((condition.kind === 'flow' ? '流量' : '压力') + '条件为未知/缺失，不能补零或继续');
        value = reading.value.value;
      }
      const matches =
        condition.kind === 'pressure-switch'
          ? value === (condition.contact === 'closed' ? 1 : 0)
          : compareReading(condition, value);
      if (!matches) this.#matchedSince.delete(index);
      else if (!this.#matchedSince.has(index)) this.#matchedSince.set(index, id.timeS);
      const since = this.#matchedSince.get(index);
      return { ok: true, value: since !== undefined && id.timeS - since + 1e-9 >= condition.holdS };
    };
    function compareReading(
      condition: Exclude<SequenceLeafCondition, { kind: 'time' | 'pressure-switch' }>,
      value: number,
    ): boolean {
      const threshold =
        condition.kind === 'position'
          ? condition.thresholdM
          : condition.kind === 'flow'
            ? condition.thresholdM3PerS
            : condition.thresholdPa;
      return condition.comparison === 'gte' ? value >= threshold : value <= threshold;
    }
    const leaves = condition.kind === 'all' || condition.kind === 'any' ? condition.conditions : [condition],
      values: boolean[] = [];
    // Evaluate every referenced signal even for OR: an unknown signal never silently hides behind a true branch.
    for (const [i, leaf] of leaves.entries()) {
      const result = evaluateLeaf(leaf, i);
      if (!result.ok) return result;
      values.push(result.value);
    }
    const satisfied = condition.kind === 'any' ? values.some(Boolean) : values.every(Boolean);
    if (satisfied) {
      const index = this.#index + 1;
      if (index === this.program.steps.length && this.#cycle === this.program.cycles) {
        this.#status = 'completed';
        this.#message = '已完成指定循环；保持最后阀位并停止仿真推进。';
        return { ok: true, value: { kind: 'complete' } };
      }
      const nextIndex = index === this.program.steps.length ? 0 : index,
        next = this.program.steps[nextIndex];
      if (!next) return failure('序列步骤不存在');
      return {
        ok: true,
        value: {
          kind: 'next',
          index: nextIndex,
          cycle: index === this.program.steps.length ? this.#cycle + 1 : this.#cycle,
          step: next,
        },
      };
    }
    if (elapsed + 1e-9 >= this.step.timeoutS) return failure(this.step.name + ' 条件不可达或等待超时');
    return { ok: true, value: { kind: 'stay' } };
  }
}

/** Configuration is persisted outside physical design; the document session still owns undo/save/revisions. */
export function planNetworkSequence(document: unknown, componentId: string, input: unknown): Result<NetworkProject> {
  const project = parseNetworkProject(document);
  if (!project.ok) return project;
  if (!project.value.design.components.some((c) => c.id === componentId && c.typeId === 'dynamic-controller'))
    return { ok: false, diagnostics: [diagnostic('SELECTION_STALE', '/controller', '动态控制器已不存在。')] };
  const replace = (program: NetworkSequence | null) =>
    parseNetworkProject({
      ...project.value,
      design: {
        ...project.value.design,
        components: project.value.design.components.map((c) => {
          if (c.id !== componentId) return c;
          const { controller: _previous, ...rest } = c;
          return program === null ? rest : { ...rest, controller: program };
        }),
      },
    });
  if (input === null) return replace(null);
  const sequence = validateNetworkSequence(project.value, input, componentId);
  return sequence.ok ? replace(sequence.value) : sequence;
}
