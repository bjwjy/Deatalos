import {
  diagnostic,
  parseNetworkProject,
  networkNativeStepAllowed,
  networkPhysicalDesign,
  type NetworkNativeStepS,
  type Diagnostic,
  type NetworkIdentity,
  type NetworkControl,
  type NetworkProject,
  type NetworkSnapshot,
  type Result,
} from '@hyd/domain';
import { fixedPumpClosureGuard } from '@hyd/engine';
import { cylinderReading, type CylinderCondition, type CylinderStop } from './network-cylinder-query.js';
import { FixedClock, simulationConfig } from './simulation.js';
import {
  acceptKernelResponse,
  acceptKernelRelease,
  validateKernelRequest,
  type KernelCursor,
  type KernelRequest,
} from './kernel-protocol.js';
import {
  networkRecordCapacity,
  sameNetworkIdentity,
  type NetworkRecord,
  type NetworkRecordPage,
  type RecordSelection,
} from './network-records.js';
import type { NetworkControlLog, NetworkControlRecordPage } from './network-control-records.js';
import { NetworkControllerFleet } from './network-controllers.js';
import { continueAtLowPressure, samePhysicalPoint, type LowPressureContinuation } from './network-low-pressure.js';
import { canonical } from './content.js';
import { networkFlowCorrection, parseNetworkOnlineControlBatch } from './network-flow-regulation.js';

/** Platform implementations own native resources; callers never receive vendor handles. */
export interface KernelPort {
  execute(request: KernelRequest): Promise<Result<unknown>>;
  close(): Promise<Result<true>>;
}
const fail = (code: string, message: string): { readonly ok: false; readonly diagnostics: readonly Diagnostic[] } => ({
  ok: false,
  diagnostics: [diagnostic(code, '/simulation', message)],
});
type History = {
  readonly controlLog: NetworkControlLog;
  readonly document: NetworkProject;
  readonly last: NetworkSnapshot | null;
  readonly samples: readonly NetworkSnapshot[];
  readonly reason: string;
  readonly record: NetworkRecord;
};
// Consecutive advances (or reads at one tick) need only their first identity and count.
type ReplaySpan = { readonly first: KernelRequest; count: number };
const replaySpanLimit = 4096;
function* replayRequests(spans: readonly ReplaySpan[]) {
  for (const { first, count } of spans) {
    yield first;
    for (let index = 1; index < count; index++) {
      const tick = first.identity.tick + (first.kind === 'advance' ? index : 0);
      yield {
        ...first,
        identity: {
          ...first.identity,
          tick,
          timeS: tick * 0.01,
          requestSequence: first.identity.requestSequence + index,
        },
      };
    }
  }
}
const replayControlLimit = 16384;

/** F05 fixed-clock policy with asynchronous kernel steps; no kinematic integration here. */
export class NetworkSimulation {
  readonly #closureGuard: ReturnType<typeof fixedPumpClosureGuard>;
  #flowTargets = new Map<string, number>();
  #sequence: NetworkControllerFleet | null = null;
  #document: NetworkProject;
  get document(): NetworkProject {
    return this.#document;
  }
  #cursor: KernelCursor | null = null;
  #point: NetworkSnapshot | null = null;
  #last: NetworkSnapshot | null = null;
  #running = false;
  #busy = false;
  #generation = 0;
  #status: 'new' | 'ready' | 'failed' | 'releasing' | 'released' = 'new';
  #dispose: Promise<Result<true>> | null = null;
  #samples: NetworkSnapshot[] = [];
  readonly #recordCapacity: number;
  #history: History[] = [];
  #samplesDropped = 0;
  #diagnostics: readonly Diagnostic[] = [];
  #controlLog: NetworkControlLog = { events: [], dropped: 0 };
  #replayRequests: ReplaySpan[] | null = [];
  #replayControlCount = 0;
  #port: KernelPort;
  #lowPressurePolicy?: LowPressureContinuation;
  #lowPressureStart: number | null = null;
  get lowPressureActive(): boolean {
    return this.#lowPressureStart !== null;
  }
  allowLowPressure(policy: LowPressureContinuation) {
    this.#lowPressurePolicy = policy;
  }
  #capture: {
    readonly identity: NetworkIdentity;
    readonly point: NetworkSnapshot;
    readonly samples: readonly NetworkSnapshot[];
    readonly record: NetworkRecord;
    readonly history: readonly History[];
    readonly controlLog: NetworkControlLog;
  } | null = null;
  readonly clock: FixedClock;
  get busy(): boolean {
    return this.#busy;
  }
  get running(): boolean {
    return this.#running;
  }
  #conditionRun: CylinderStop | undefined;
  configureCondition(condition: CylinderCondition | undefined, ticks?: number): Result<boolean> {
    if (!condition) {
      this.#conditionRun = undefined;
      return { ok: true, value: false };
    }
    const point = this.#point,
      reading = point && cylinderReading(point, condition.componentId);
    if (
      !point ||
      !reading ||
      ticks === undefined ||
      !Number.isSafeInteger(ticks) ||
      ticks < 1 ||
      ticks > 10000 ||
      !Number.isSafeInteger(point.identity.tick + ticks)
    )
      return fail('CONDITION_INVALID', '停止条件需要当前有效的液压缸位置和最大步数。');
    this.#conditionRun = {
      condition,
      startTick: point.identity.tick,
      targetTick: point.identity.tick + ticks,
      tick: point.identity.tick,
      positionM: reading.positionM,
      reason: 'running',
    };
    if (point.identity.tick > 0 && this.#samples.at(-1)?.identity.requestSequence !== point.identity.requestSequence)
      this.#recordSample(point);
    this.#checkCondition(point);
    return { ok: true, value: this.#conditionRun.reason === 'threshold' };
  }
  #recordSample(point: NetworkSnapshot) {
    this.#samples.push(point);
    if (this.#samples.length > this.#recordCapacity) {
      this.#samples.shift();
      this.#samplesDropped++;
    }
  }
  #checkCondition(point: NetworkSnapshot) {
    const run = this.#conditionRun;
    if (run?.reason !== 'running') return;
    const state = cylinderReading(point, run.condition.componentId);
    if (!state) {
      this.pause();
      return;
    }
    const threshold =
      run.condition.comparison === 'gte'
        ? state.positionM >= run.condition.positionM
        : state.positionM <= run.condition.positionM;
    const reason = threshold
      ? 'threshold'
      : point.identity.tick >= run.targetTick
        ? 'tick-limit'
        : !this.running && point.identity.tick > run.startTick
          ? 'interrupted'
          : 'running';
    this.#conditionRun = { ...run, tick: point.identity.tick, positionM: state.positionM, reason };
    if (reason !== 'running') this.pause();
  }
  /** The immutable accepted cursor, without constructing status, controller or flow-regulator views. */
  get identity(): NetworkIdentity | null {
    return this.#cursor?.identity ?? null;
  }
  private constructor(
    document: NetworkProject,
    readonly documentSessionId: string,
    readonly physicsRevision: number,
    private simulationSessionId: string,
    port: KernelPort,
    readonly nativeStepS: NetworkNativeStepS,
  ) {
    this.#document = document;
    this.#port = port;
    this.#closureGuard = fixedPumpClosureGuard(document);
    this.#recordCapacity = networkRecordCapacity(document);
    const config = simulationConfig(0.01);
    if (!config.ok) throw new Error('Fixed F05 configuration rejected');
    this.clock = new FixedClock(config.value);
  }
  static create(
    input: unknown,
    documentSessionId: string,
    simulationSessionId: string,
    physicsRevision: number,
    port: KernelPort,
    nativeStepS: NetworkNativeStepS = 0.0001,
  ): Result<NetworkSimulation> {
    const document = parseNetworkProject(input);
    if (!document.ok) return document;
    if (
      ![documentSessionId, simulationSessionId].every(
        (id) => /^[-\w]{1,40}$/.test(id) && !['constructor', 'prototype', '__proto__'].includes(id),
      ) ||
      !Number.isSafeInteger(physicsRevision) ||
      physicsRevision < 0
    )
      return fail('IDENTITY_INVALID', '运行会话或物理修订无效。');
    if (!networkNativeStepAllowed(document.value.design.components, nativeStepS))
      return fail('CLOCK_INVALID', '原生子步不在该模型集已验证配置内。');
    return {
      ok: true,
      value: new NetworkSimulation(
        document.value,
        documentSessionId,
        physicsRevision,
        simulationSessionId,
        port,
        nativeStepS,
      ),
    };
  }
  snapshot(includeRecords = true) {
    const point = this.#point;
    // All point/document members are already immutable. Status reads omit the recorded frames.
    return Object.freeze({
      sequence: this.#sequence?.view() ?? null,
      controllers: this.#sequence?.views() ?? [],
      flowRegulators: point
        ? [...this.#flowTargets].map(([id, target]) => networkFlowCorrection(this.document, point, id, target).view)
        : [],
      document: this.document,
      documentSessionId: this.documentSessionId,
      physicsRevision: this.physicsRevision,
      status: this.#status,
      running: this.#running,
      busy: this.#busy,
      identity: this.#cursor?.identity ?? null,
      ...(this.#conditionRun ? { conditionRun: this.#conditionRun } : {}),
      point: this.#point,
      lastSuccessfulHistorical: this.#status === 'failed' ? this.#last : null,
      samples: Object.freeze(includeRecords ? [...this.#samples] : []),
      historicalRuns: Object.freeze(
        this.#history.map((h) =>
          Object.freeze({
            document: h.document,
            last: h.last,
            reason: h.reason,
            record: h.record,
            samples: Object.freeze(includeRecords ? [...h.samples] : []),
          }),
        ),
      ),
      record: this.#record(),
      diagnostics:
        this.#lowPressureStart === null
          ? this.#diagnostics
          : [
              ...this.#diagnostics,
              {
                code: 'AUTO_LOW_PRESSURE_ACTIVE',
                field: '/simulation',
                severity: 'info' as const,
                message: '已从第 ' + this.#lowPressureStart + ' 步自动启用等效空穴预览。',
                suggestion: '可在设置的仿真页调整下次运行的策略。',
              },
            ],
      clock: Object.freeze({ ...this.clock.config, nativeStepS: this.nativeStepS }),
      samplesTruncated: this.#samplesDropped > 0,
      samplesDropped: this.#samplesDropped,
      quality: !this.#point
        ? 'unavailable'
        : this.#point.readings.some((r) => r.value.kind === 'unknown')
          ? 'partial'
          : 'known',
    });
  }
  #record(): NetworkRecord {
    return Object.freeze({
      mode: 'paged',
      count: this.#samples.length,
      samplesDropped: this.#samplesDropped,
      samplesTruncated: this.#samplesDropped > 0,
      capacity: this.#recordCapacity,
    });
  }
  /** Pin immutable accepted points and a bounded copy of the ring, without
   * pausing the solver. One window per runtime; controls/reset/failure retire it. */
  captureRecords(): Result<NetworkIdentity> {
    if (this.#busy || this.#status !== 'ready' || !this.#point || !this.#cursor)
      return fail('RUNTIME_NOT_READY', '当前没有可捕获的有效状态；检查诊断后重新初始化。');
    this.#capture = Object.freeze({
      identity: this.#cursor.identity,
      point: this.#point,
      samples: Object.freeze([...this.#samples]),
      record: this.#record(),
      history: Object.freeze([...this.#history]),
      controlLog: this.#controlLog,
    });
    return { ok: true, value: this.#capture.identity };
  }
  /** Exact pinned-anchor reads, or the original paused-current reads. A ring
   * advancing after capture never shifts pages or relabels accepted samples. */
  records(expected: NetworkIdentity, selection: RecordSelection): Result<NetworkRecordPage> {
    const captured = this.#capture && sameNetworkIdentity(expected, this.#capture.identity) ? this.#capture : null;
    if (!this.#cursor || (!captured && !sameNetworkIdentity(expected, this.#cursor.identity)))
      return fail('RESPONSE_STALE', '记录读取身份已过期。');
    if (!captured && (this.#busy || this.#running)) return fail('RUNTIME_BUSY', '先捕获有效状态或暂停后读取记录。');
    if (
      !Number.isSafeInteger(selection.offset) ||
      selection.offset < 0 ||
      !Number.isSafeInteger(selection.limit) ||
      selection.limit < 1 ||
      selection.limit > 20
    )
      return fail('RECORD_RANGE_INVALID', '每页1至20条，偏移须为非负安全整数。');
    const history =
      selection.simulationSessionId === null
        ? undefined
        : (captured?.history ?? this.#history).find(
            (h) => h.last?.identity.simulationSessionId === selection.simulationSessionId,
          );
    if (selection.simulationSessionId !== null && !history)
      return fail('HISTORY_UNAVAILABLE', '所选历史已淘汰或不属于当前工程上下文。');
    const point = history ? history.last : (captured?.point ?? this.#point),
      samples = history ? history.samples : (captured?.samples ?? this.#samples);
    if (!point) return fail('EXPORT_RESULT_UNAVAILABLE', '无当前有效结果；失败点只能显式选择已保留历史。');
    if (selection.offset > samples.length) return fail('RECORD_RANGE_INVALID', '记录偏移越界。');
    const end = Math.min(samples.length, selection.offset + selection.limit);
    return {
      ok: true,
      value: Object.freeze({
        sourceIdentity: captured?.identity ?? this.#cursor.identity,
        document: history?.document ?? this.document,
        point,
        record: history?.record ?? captured?.record ?? this.#record(),
        offset: selection.offset,
        nextOffset: end < samples.length ? end : null,
        samples: Object.freeze(samples.slice(selection.offset, end)),
        selection: history ? 'history' : 'current',
      }),
    };
  }
  initialize(): Promise<Result<NetworkSnapshot>> {
    return this.#operate('initialize');
  }
  controlRecords(expected: NetworkIdentity, selection: RecordSelection): Result<NetworkControlRecordPage> {
    const captured = this.#capture && sameNetworkIdentity(expected, this.#capture.identity) ? this.#capture : null;
    if (!this.#cursor || (!captured && !sameNetworkIdentity(expected, this.#cursor.identity)))
      return fail('RESPONSE_STALE', '控制记录捕获已过期。');
    if (!captured && (this.#busy || this.#running)) return fail('RUNTIME_BUSY', '请先捕获控制记录窗口。');
    if (
      !Number.isSafeInteger(selection.offset) ||
      selection.offset < 0 ||
      !Number.isSafeInteger(selection.limit) ||
      selection.limit < 1 ||
      selection.limit > 20
    )
      return fail('RECORD_RANGE_INVALID', '控制记录每页1至20项，偏移须为非负整数。');
    const history =
      selection.simulationSessionId === null
        ? undefined
        : (captured?.history ?? this.#history).find(
            (h) => h.last?.identity.simulationSessionId === selection.simulationSessionId,
          );
    if (selection.simulationSessionId !== null && !history) return fail('HISTORY_UNAVAILABLE', '控制记录历史已退役。');
    const point = history ? history.last : (captured?.point ?? this.#point),
      log = history ? history.controlLog : (captured?.controlLog ?? this.#controlLog);
    if (!point) return fail('RUNTIME_NOT_READY', '没有所选有效运行。');
    if (selection.offset > log.events.length) return fail('RECORD_RANGE_INVALID', '控制记录偏移越界。');
    const end = Math.min(log.events.length, selection.offset + selection.limit);
    return {
      ok: true,
      value: Object.freeze({
        sourceIdentity: captured?.identity ?? this.#cursor.identity,
        document: history?.document ?? this.document,
        point,
        record: { count: log.events.length, dropped: log.dropped, capacity: 256 as const },
        events: log.events.slice(selection.offset, end),
        offset: selection.offset,
        nextOffset: end < log.events.length ? end : null,
      }),
    };
  }
  start(): Result<true> {
    if (this.#status !== 'ready') return fail('RUNTIME_NOT_READY', '先初始化有效运行。');
    if (this.#sequence && ['running', 'paused', 'failed'].includes(this.#sequence.status))
      return fail('SEQUENCE_ACTIVE', '请使用动作序列的继续/停止；普通运行不能旁路自动控制。');
    // An explicit resume acknowledges the clock stop. Physical/model diagnostics remain.
    this.#diagnostics = this.#diagnostics.filter(
      (d) => !['CLOCK_GAP_PAUSED', 'CLOCK_BUDGET_PAUSED', 'CLOCK_INVALID'].includes(d.code),
    );
    this.clock.clear();
    this.#running = true;
    return { ok: true, value: true };
  }
  /** Stops future dispatch immediately. An already dispatched native step drains before pause acknowledgement. */
  pause(): void {
    const run = this.#conditionRun;
    if (run?.reason === 'running') {
      const point = this.#point,
        reading = point && cylinderReading(point, run.condition.componentId);
      this.#conditionRun = {
        ...run,
        ...(point && reading ? { tick: point.identity.tick, positionM: reading.positionM } : {}),
        reason: 'interrupted',
      };
    }
    this.#running = false;
    this.#sequence?.pause();
    this.clock.clear();
  }
  async singleStep(): Promise<Result<NetworkSnapshot>> {
    this.retireSequence('人工单步已接管；自动序列已退役，保持最后阀位。');
    this.pause();
    const corrected = await this.#regulateFlow();
    if (!corrected.ok) return corrected;
    return this.#operate('advance', undefined, true);
  }
  async control(changes: unknown): Promise<Result<NetworkSnapshot>> {
    if (this.#busy) return fail('RUNTIME_BUSY', '内核已有操作，未重复执行。');
    if (this.#status !== 'ready') return fail('RUNTIME_NOT_READY', '运行未初始化或已失效。');
    const parsed = parseNetworkOnlineControlBatch(this.document, changes);
    if (!parsed.ok) return parsed;
    if (
      parsed.value.some(
        (change) => change.kind === 'displacement' && this.#sequence?.controlsDisplacement(change.componentId),
      )
    )
      return fail('CONTROLLER_CONFLICT', '此排量由运行中的动态控制器给定；请先停止自动控制。');
    // Only an explicit directional-valve command takes ownership from the fleet.
    // Throttles cannot be sequence targets; their accepted control sequence still
    // has to be acknowledged by every active controller without restarting a step.
    const online = parsed.value.every((change) => change.kind !== 'position');
    if (!online) this.retireSequence('人工控制已接管；自动序列已退役。');
    const fleet = this.#sequence;
    const point = this.#point;
    if (!point) return fail('RUNTIME_NOT_READY', '没有有效反馈点。');
    const commands: NetworkControl[] = [];
    for (const change of parsed.value) {
      if (change.kind !== 'target-flow') commands.push(change);
      else {
        const applied = point.appliedControls.find((c) => c.componentId === change.componentId);
        if (applied?.kind !== 'opening-area') return fail('CONTROL_INVALID', '节流阀没有已确认的运行开口。');
        // Arm the mode without applying a second correction to this feedback sample.
        commands.push(applied);
      }
    }
    const result = await this.#operate('control', commands);
    if (result.ok)
      for (const change of parsed.value) {
        if (change.kind === 'target-flow') this.#flowTargets.set(change.componentId, change.targetM3PerS);
        else this.#flowTargets.delete(change.componentId);
      }
    if (result.ok && online && fleet === this.#sequence && fleet && ['running', 'paused'].includes(fleet.status))
      fleet.acknowledge(result.value);
    return result;
  }
  async #regulateFlow(): Promise<Result<true>> {
    const point = this.#point;
    if (!point || !this.#flowTargets.size) return { ok: true, value: true };
    const commands = [...this.#flowTargets].flatMap(([id, target]) => {
      const control = networkFlowCorrection(this.document, point, id, target).control;
      return control ? [control] : [];
    });
    if (!commands.length) return { ok: true, value: true };
    const fleet = this.#sequence;
    const result = await this.#operate('control', commands);
    if (!result.ok) {
      if (result.diagnostics.some((d) => d.code === 'PRESSURE_CONTROL_BLOCKED')) {
        this.pause();
        this.#diagnostics = result.diagnostics;
      }
      return result;
    }
    if (fleet === this.#sequence && fleet && ['running', 'paused'].includes(fleet.status))
      fleet.acknowledge(result.value);
    return { ok: true, value: true };
  }
  /** Explicit stop/takeover never synthesizes a neutral position that a two-position valve may not have. */
  retireSequence(message = '序列已停止；保持最后已确认阀位。'): void {
    if (this.#sequence && ['running', 'paused', 'failed'].includes(this.#sequence.status)) {
      this.#sequence.stop(message);
      this.#running = false;
      this.clock.clear();
    }
  }
  async startSequence(project: unknown, runId: string): Promise<Result<true>> {
    if (this.#busy || this.#status !== 'ready' || !this.#point)
      return fail('RUNTIME_NOT_READY', '先初始化有效运行，再开始动作序列。');
    if (this.#sequence && ['running', 'paused'].includes(this.#sequence.status))
      return fail('SEQUENCE_ACTIVE', '请先明确停止当前序列。');
    if (this.#sequence?.runId === runId) return fail('IDENTITY_INVALID', '重新开始必须使用新的序列运行编号。');
    const parsed = parseNetworkProject(project);
    if (!parsed.ok) return parsed;
    if (
      parsed.value.projectId !== this.document.projectId ||
      parsed.value.createdAt !== this.document.createdAt ||
      parsed.value.provenance.preferredSolverId !== this.document.provenance.preferredSolverId ||
      canonical(networkPhysicalDesign(parsed.value)) !== canonical(networkPhysicalDesign(this.document))
    )
      return fail('RESPONSE_STALE', '控制器配置所属工程或物理设计已改变，需重新初始化。');
    const created = NetworkControllerFleet.create(parsed.value, runId, this.#point);
    if (!created.ok) return created;
    this.pause();
    this.#document = parsed.value;
    const run = created.value;
    this.#sequence = run;
    const applied = run.initialCommands.length
      ? await this.#operate('control', run.initialCommands)
      : { ok: true as const, value: this.#point };
    if (!applied.ok) {
      if (this.#sequence === run && run.status !== 'stopped') run.fail('起始阀命令未确认');
      return applied;
    }
    if (this.#sequence !== run || run.status === 'stopped') return fail('RESPONSE_STALE', '序列起始控制已退役。');
    run.acknowledge(applied.value);
    this.#diagnostics = applied.value.diagnostics;
    this.clock.clear();
    this.#running = run.status === 'running';
    return { ok: true, value: true };
  }
  resumeSequence(runId: string): Result<true> {
    if (
      this.#busy ||
      this.#status !== 'ready' ||
      !this.#point ||
      this.#sequence?.runId !== runId ||
      this.#sequence.status !== 'paused'
    )
      return fail('SEQUENCE_STALE', '只有本次已暂停序列可以继续。');
    this.#sequence.resume(this.#point);
    this.clock.clear();
    this.#running = true;
    return { ok: true, value: true };
  }
  stopSequence(runId: string): Result<true> {
    if (this.#sequence?.runId !== runId) return fail('SEQUENCE_STALE', '停止请求不属于当前序列。');
    this.retireSequence();
    return { ok: true, value: true };
  }
  async #advanceSequence(point: NetworkSnapshot): Promise<Result<true>> {
    const run = this.#sequence;
    if (!run || run.status !== 'running') return { ok: true, value: true };
    const decision = run.evaluate(point);
    if (!decision.ok) {
      this.pause();
      this.#diagnostics = [...point.diagnostics, ...decision.diagnostics];
      return decision;
    }
    if (decision.value.kind === 'complete') {
      this.pause();
      return { ok: true, value: true };
    }
    if (decision.value.kind === 'next') {
      const next = decision.value;
      const applied = next.commands.length
        ? await this.#operate('control', next.commands)
        : { ok: true as const, value: point };
      if (!applied.ok) {
        if (this.#sequence === run && !['stopped'].includes(run.status)) run.fail('步骤阀命令未确认');
        this.pause();
        return applied;
      }
      if (this.#sequence === run && ['running', 'paused'].includes(run.status)) run.acknowledge(applied.value, next);
    }
    return { ok: true, value: true };
  }
  read(): Promise<Result<NetworkSnapshot>> {
    return this.#operate('snapshot');
  }
  /** A failed run owns its accepted history until a fresh kernel reproduces the exact last point. */
  async recover(
    openPort: () => Promise<Result<KernelPort>>,
    canContinue: () => boolean,
  ): Promise<Result<NetworkSnapshot>> {
    const requests = this.#replayRequests;
    const last = this.#last;
    if (this.#busy || this.#status !== 'failed' || this.#dispose || !last)
      return fail('RECOVERY_UNAVAILABLE', '当前运行没有可恢复的停算点。');
    if (!requests?.length) return fail('RECOVERY_LIMIT', '已确认操作记录超过续算容量，无法完整重放。');
    const generation = this.#generation;
    const active = () => generation === this.#generation && canContinue();
    const interrupted = () => fail('RECOVERY_INTERRUPTED', '续算已取消或超过重放时限，保留原停算记录。');
    this.#busy = true;
    let candidate: KernelPort | null = null;
    try {
      if (!active()) return interrupted();
      const opened = await openPort();
      if (!opened.ok) return opened;
      candidate = opened.value;
      const checkpoints = new Map([...this.#samples, last].map((point) => [point.identity.requestSequence, point]));
      let restored: NetworkSnapshot | null = null;
      for (const request of replayRequests(requests)) {
        if (!active()) return interrupted();
        const response = await candidate.execute(request);
        if (!active()) return interrupted();
        if (!response.ok) return response;
        const point = acceptKernelResponse(this.document, response.value, request.identity);
        if (!point.ok) return point;
        const expected = checkpoints.get(request.identity.requestSequence);
        const beforeSwitch = this.#lowPressureStart !== null && request.identity.tick < this.#lowPressureStart;
        if (
          expected &&
          !(beforeSwitch ? samePhysicalPoint(expected, point.value) : canonical(point.value) === canonical(expected))
        )
          return fail('RECOVERY_MISMATCH', `重放第 ${request.identity.tick} 步时与原有效记录不一致，仍停在原记录。`);
        restored = point.value;
      }
      if (!restored || !sameNetworkIdentity(restored.identity, last.identity))
        return fail('RECOVERY_MISMATCH', '重放结果与最后有效点不一致，仍停在原记录。');
      if (!active()) return interrupted();
      this.#port = candidate;
      candidate = null;
      this.#point = last;
      this.#status = 'ready';
      this.#diagnostics = last.diagnostics;
      this.retireSequence('已恢复到最后有效点；自动序列已退役，可手动调整后继续。');
      this.#flowTargets.clear();
      return { ok: true, value: last };
    } catch (cause) {
      return fail('RECOVERY_FAILED', '重放未完成，保留原停算记录：' + String(cause).slice(0, 160));
    } finally {
      try {
        const closed = await candidate?.close();
        if (closed && !closed.ok && generation === this.#generation)
          this.#diagnostics = [...this.#diagnostics, ...closed.diagnostics];
      } catch (cause) {
        if (generation === this.#generation)
          this.#diagnostics = [
            ...this.#diagnostics,
            diagnostic('RECOVERY_CLEANUP_FAILED', '/simulation', String(cause).slice(0, 160)),
          ];
      } finally {
        this.#busy = false;
      }
    }
  }
  async reset(newSimulationSessionId: string): Promise<Result<NetworkSnapshot>> {
    this.retireSequence('运行已复位，自动序列已退役。');
    this.pause();
    if (!/^[-\w]{1,40}$/.test(newSimulationSessionId) || newSimulationSessionId === this.simulationSessionId)
      return fail('IDENTITY_INVALID', '复位必须使用新的仿真会话。');
    if (this.#busy || this.#status !== 'ready')
      return fail('RUNTIME_NOT_READY', '当前操作未完成或运行失效，需重新初始化。');
    this.#archive('reset');
    this.#flowTargets.clear();
    const old = this.simulationSessionId;
    this.simulationSessionId = newSimulationSessionId;
    const result = await this.#operate('reset');
    if (!result.ok) this.simulationSessionId = old;
    else {
      this.#conditionRun = undefined;
      this.#samples = [];
      this.#samplesDropped = 0;
      this.#controlLog = { events: [], dropped: 0 };
    }
    return result;
  }
  async advanceTime(elapsedSeconds: number, speed = 1): Promise<Result<number>> {
    if (!this.#running) return { ok: true, value: 0 };
    if (this.#busy) return fail('RUNTIME_BUSY', '内核已有操作，不能重复推进。');
    const consumed = this.clock.consume(elapsedSeconds, speed);
    if (!consumed.ok) {
      this.pause();
      this.#diagnostics = [...(this.#point?.diagnostics ?? []), ...consumed.diagnostics];
      return consumed;
    }
    let completed = 0;
    for (let i = 0; i < consumed.value && this.#running; i++) {
      const corrected = await this.#regulateFlow();
      if (!corrected.ok) return corrected;
      if (!this.#running) break;
      const result = await this.#operate('advance', undefined, this.#conditionRun?.reason === 'running');
      if (!result.ok) return result;
      const sequence = await this.#advanceSequence(result.value);
      if (!sequence.ok) return sequence;
      this.#checkCondition(this.#point ?? result.value);
      completed++;
    }
    return { ok: true, value: completed };
  }
  async #operate(kind: KernelRequest['kind'], changes?: unknown, manual = false): Promise<Result<NetworkSnapshot>> {
    if (this.#busy) return fail('RUNTIME_BUSY', '内核已有操作，未重复执行。');
    if (this.#status === 'released' || this.#status === 'releasing' || this.#status === 'failed')
      return fail('RUNTIME_NOT_READY', '运行已释放或失效，需重新初始化。');
    const before = this.#cursor?.identity;
    const initialPoint = kind === 'advance' && before?.tick === 0 ? this.#point : null;
    const tick = kind === 'reset' ? 0 : (before?.tick ?? 0) + (kind === 'advance' ? 1 : 0);
    const identity: NetworkIdentity = {
      documentSessionId: this.documentSessionId,
      physicsRevision: this.physicsRevision,
      simulationSessionId: this.simulationSessionId,
      tick,
      timeS: tick * 0.01,
      controlSequence: kind === 'reset' ? 0 : (before?.controlSequence ?? 0) + (kind === 'control' ? 1 : 0),
      requestSequence: (before?.requestSequence ?? 0) + 1,
    };
    const request = validateKernelRequest(
      this.document,
      {
        protocol: 'HydraulicKernel',
        version: 1,
        kind,
        identity,
        ...(kind === 'initialize' ? { clock: { advanceIntervalS: 0.01, nativeStepS: this.nativeStepS } } : {}),
        ...(kind === 'control' ? { controls: changes } : {}),
      },
      this.#cursor,
    );
    if (!request.ok) return request;
    const guard = this.#closureGuard;
    if (
      kind === 'control' &&
      guard &&
      request.value.next.controls.some(
        (c) => c.kind === 'opening-area' && c.componentId === guard.loadId && c.areaM2 === 0,
      )
    )
      return { ok: false, diagnostics: [guard.diagnostic] };
    if (kind !== 'advance' && kind !== 'snapshot') this.#capture = null;
    this.#busy = true;
    const generation = this.#generation;
    try {
      const command = request.value.request;
      let response;
      if (kind === 'reset' && this.lowPressureActive && this.#lowPressurePolicy) {
        const fresh = await this.#lowPressurePolicy.open(false);
        if (fresh.ok) {
          await this.#port.close();
          this.#port = fresh.value;
          this.#lowPressureStart = null;
          response = await this.#port.execute({
            ...command,
            kind: 'initialize',
            clock: { advanceIntervalS: 0.01, nativeStepS: this.nativeStepS },
          });
        } else response = fresh;
      } else response = await this.#port.execute(command);
      if (generation !== this.#generation) return fail('RESPONSE_STALE', '运行已替换/销毁，忽略迟到响应。');
      let point = response.ok ? acceptKernelResponse(this.document, response.value, identity) : response;
      if (
        !response.ok &&
        'lowPressureOnly' in response &&
        response.lowPressureOnly === true &&
        kind === 'advance' &&
        !this.lowPressureActive &&
        this.#lowPressurePolicy &&
        this.#replayRequests &&
        this.#last
      ) {
        const resumed = await continueAtLowPressure(
          this.#lowPressurePolicy,
          this.document,
          replayRequests(this.#replayRequests),
          [...this.#samples, this.#last],
          command,
          () => generation === this.#generation,
        ).catch(() => null);
        if (resumed) await this.#port.close();
        if (generation !== this.#generation) {
          await resumed?.port.close();
          return fail('RESPONSE_STALE', '运行已取消。');
        }
        if (resumed) {
          this.#port = resumed.port;
          this.#lowPressureStart = identity.tick;
          point = resumed.point;
        } else {
          point = {
            ok: false,
            diagnostics: [
              ...response.diagnostics,
              diagnostic(
                'LOW_PRESSURE_CONTINUATION_UNAVAILABLE',
                '/simulation',
                '等效空穴模型未能验证并接续此步，已保留原停算点。',
              ),
            ],
          };
        }
      }
      if (!point.ok) {
        this.#sequence?.fail('内核结果失效，序列已停止');
        this.#capture = null;
        this.pause();
        this.#point = null;
        this.#status = 'failed';
        this.#diagnostics = point.diagnostics;
        await this.#port.close();
        return point;
      }
      // No cursor/control/tick transition is committed before native success AND identity validation.
      this.#cursor = request.value.next;
      this.#point = point.value;
      this.#last = point.value;
      this.#status = 'ready';
      this.#diagnostics = point.value.diagnostics;
      this.#recordReplay(request.value.request);
      if (kind === 'control') {
        const events = [
          ...this.#controlLog.events,
          Object.freeze({ identity: point.value.identity, controls: point.value.appliedControls }),
        ];
        const dropped = events.length > 256 ? 1 : 0;
        this.#controlLog = Object.freeze({
          events: Object.freeze(dropped ? events.slice(1) : events),
          dropped: this.#controlLog.dropped + dropped,
        });
      }
      // Start a trajectory only after a successful step, using the accepted pre-step frame at tick zero.
      if (initialPoint && this.#samples.length === 0) this.#samples.push(initialPoint);
      if (kind === 'advance' && (manual || tick % this.clock.config.sampleEveryTicks === 0)) {
        this.#recordSample(point.value);
      }
      return point;
    } catch (cause: unknown) {
      if (generation !== this.#generation) return fail('RESPONSE_STALE', '运行已取消。');
      this.#sequence?.fail('内核通信异常，序列已停止');
      this.#capture = null;
      this.pause();
      this.#point = null;
      this.#status = 'failed';
      const failure = fail('BACKEND_UNAVAILABLE', '内核通信异常，运行已隔离：' + String(cause).slice(0, 160));
      this.#diagnostics = failure.diagnostics;
      await this.#port.close();
      return failure;
    } finally {
      this.#busy = false;
    }
  }
  #recordReplay(request: KernelRequest): void {
    if (request.kind === 'initialize' || request.kind === 'reset') {
      this.#replayRequests = [
        {
          first: { ...request, kind: 'initialize', clock: { advanceIntervalS: 0.01, nativeStepS: this.nativeStepS } },
          count: 1,
        },
      ];
      this.#replayControlCount = 0;
      return;
    }
    if (!this.#replayRequests) return;
    const last = this.#replayRequests.at(-1);
    if ((request.kind === 'advance' || request.kind === 'snapshot') && last?.first.kind === request.kind) {
      last.count++;
      return;
    }
    this.#replayControlCount += request.controls?.length ?? 0;
    if (this.#replayRequests.length >= replaySpanLimit || this.#replayControlCount > replayControlLimit) {
      this.#replayRequests = null;
      return;
    }
    this.#replayRequests.push({ first: request, count: 1 });
  }
  #archive(reason: string): void {
    if (!this.#last) return;
    this.#history.push(
      Object.freeze({
        document: this.document,
        controlLog: this.#controlLog,
        last: this.#last,
        samples: Object.freeze([...this.#samples]),
        reason,
        record: this.#record(),
      }),
    );
    if (this.#history.length > 3) this.#history.shift();
  }
  dispose(): Promise<Result<true>> {
    this.#flowTargets.clear();
    this.retireSequence('运行上下文已释放，自动序列已退役。');
    if (this.#dispose) return this.#dispose;
    this.#capture = null;
    const orderly = this.#status === 'ready' && !this.#busy && this.#cursor;
    this.#archive('released');
    this.#generation++;
    this.pause();
    this.#status = 'releasing';
    this.#point = null;
    this.#dispose = (async (): Promise<Result<true>> => {
      try {
        if (orderly) {
          const identity = { ...orderly.identity, requestSequence: orderly.identity.requestSequence + 1 };
          const proposed = validateKernelRequest(
            this.document,
            { protocol: 'HydraulicKernel', version: 1, kind: 'release', identity },
            orderly,
          );
          const response = proposed.ok ? await this.#port.execute(proposed.value.request) : proposed;
          const accepted = response.ok ? acceptKernelRelease(response.value, identity) : response;
          if (!accepted.ok || !proposed.ok) {
            await this.#port.close();
            this.#status = 'failed';
            const result = !accepted.ok
              ? accepted
              : !proposed.ok
                ? proposed
                : fail('BACKEND_CLEANUP_FAILED', '释放未确认。');
            this.#diagnostics = result.diagnostics;
            return result;
          }
          this.#cursor = proposed.value.next;
        } else {
          // Cancellation of an in-flight operation cannot enqueue another mutation.
          // Close the owned resource, invalidate its generation and discard the late reply.
          const closed = await this.#port.close();
          if (!closed.ok) {
            this.#status = 'failed';
            this.#diagnostics = closed.diagnostics;
            return closed;
          }
        }
        this.#status = 'released';
        return { ok: true, value: true };
      } catch (cause) {
        this.#status = 'failed';
        const result = fail('BACKEND_CLEANUP_FAILED', '释放未完成：' + String(cause).slice(0, 160));
        this.#diagnostics = result.diagnostics;
        return result;
      }
    })();
    return this.#dispose;
  }
}
