export { parseExportArtifact, exportLimits, utf8Bytes } from './export-artifact.js';
export { createNetworkDraftSession, networkDocumentContent } from './network-draft.js';
export type { NetworkDraftSession, NetworkEditKind } from './network-draft.js';
export {
  parseServiceResult,
  parseNetworkRuntimeView,
  parseNetworkRuntimeResult,
  networkRuntimeReference,
  createNetworkRuntimeResponseReader,
  parseNetworkFileRequest,
  parseNetworkFileOutcome,
} from './network-services.js';
export type { NetworkRuntimeView, NetworkFileRequest, NetworkFileOutcome } from './network-services.js';
export { networkDiagnosticArchive } from './network-diagnostic-export.js';
export type { NetworkSaveCapture } from './network-draft.js';
export type { ExportArtifact } from './export-artifact.js';
import { canonical, content, physicalContent } from './content.js';
export { FileController, documentContent } from './files.js';
export type { FileRequest, FileReply, FilePort, FileReference } from './files.js';
import { applyCommand } from './commands.js';
import { advanceState, FixedClock, simulationConfig, type SimulationConfig } from './simulation.js';
export { validateKernelRequest, acceptKernelResponse, acceptKernelRelease } from './kernel-protocol.js';
export type { KernelRequest, KernelCursor } from './kernel-protocol.js';
export { NetworkSimulation } from './network-simulation.js';
export { legacyNetworkRecordCapacity, networkRecordMaximum, sameNetworkIdentity } from './network-records.js';
export { captureNetworkExport, parseNetworkRecordPage, networkCurve, exportNetworkCsv } from './network-export.js';
export type { NetworkExportCapture, NetworkRecordPort } from './network-export.js';
export type { NetworkRecord, NetworkRecordPage, RecordSelection } from './network-records.js';
export type { KernelPort } from './network-simulation.js';
export { parseKernelServiceRequest } from './kernel-service.js';
export { compareCylinders } from './network-cylinder-query.js';
export type { CylinderCondition, CylinderStop } from './network-cylinder-query.js';
export type { KernelServiceRequest, KernelServiceCommand } from './kernel-service.js';
import {
  diagnostic,
  immutable,
  parseDocument,
  type Diagnostic,
  type ProjectDocument,
  type Result,
  type SimulationState,
  type ValvePositionId,
} from '@hyd/domain';
import { compileCircuit, solve, type CompiledCircuit, type Controls, type Solution } from '@hyd/engine';

export const budgets = Object.freeze({
  historyCount: 40,
  historyBytes: 32 * 1024 * 1024,
  samples: 2000,
  controlEvents: 2000,
  scheduledControls: 2000,
  historicalRuns: 3,
});
import type { ControlEvent, Identity, Sample, HistoricalRun, RunPoint } from './records.js';
export type { ControlEvent, Identity, Sample, HistoricalRun, RunPoint } from './records.js';
export { captureExport } from './export-snapshot.js';
export type { ExportSnapshot, ExportSelection } from './export-snapshot.js';
export { exportCsv } from './export-csv.js';
export interface SolveRequest {
  readonly identity: Identity;
  readonly document: ProjectDocument;
  readonly state: SimulationState;
  readonly controls: Controls;
}
export interface SaveCapture {
  readonly documentSessionId: string;
  readonly requestId: string;
  readonly documentRevision: number;
  readonly document: ProjectDocument;
  readonly content: string;
}
export interface TransitionCapture {
  readonly documentSessionId: string;
  readonly documentRevision: number;
  readonly requestId: string;
}
export type Selection = { readonly kind: 'component' | 'connection'; readonly id: string } | null;
interface Drag {
  readonly componentId: string;
  readonly x: number;
  readonly y: number;
}
interface HistoryEntry {
  readonly before: ProjectDocument;
  readonly after: ProjectDocument;
  readonly bytes: number;
}
const failure = (code: string, field: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, field, message)],
});
const changed = (value: boolean): Result<{ readonly changed: boolean }> => ({ ok: true, value: { changed: value } });
export function evaluateRequest(request: SolveRequest): Result<Solution> {
  const compiled = compileCircuit(request.document);
  return compiled.ok ? solve(compiled.value, request.state, request.controls) : compiled;
}

class Application {
  #document: ProjectDocument;
  #session: string;
  #usedSessions: Set<string>;
  #savedContent: string | null;
  #documentRevision = 0;
  #physicsRevision = 0;
  #layoutRevision = 0;
  #runId = 0;
  #controlRevision = 0;
  #stateRevision = 0;
  #requestSequence = 0;
  #state: SimulationState;
  #controls: Controls;
  #running = false;
  #result: Result<Solution>;
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #samples: readonly Sample[] = Object.freeze([]);
  #truncated = false;
  #past: readonly HistoricalRun[] = Object.freeze([]);
  #selection: Selection = null;
  #drag: Drag | null = null;
  #latestRequest: Identity | null = null;
  #pendingSave: SaveCapture | null = null;
  #transition: TransitionCapture | null = null;
  #fileTransition: TransitionCapture | null = null;
  #diagnostics: readonly Diagnostic[] = Object.freeze([]);
  #clock: FixedClock;
  #compiled: Result<CompiledCircuit> | null = null;
  #events: readonly ControlEvent[] = Object.freeze([]);
  #scheduled: readonly Omit<ControlEvent, 'phase'>[] = Object.freeze([]);
  #controlSequence = 0;
  #eventsTruncated = false;
  #samplesDropped = 0;
  #lastStepControls: Controls;
  #lastStep: RunPoint | null = null;
  #timingDiagnostics: readonly Diagnostic[] = Object.freeze([]);

  constructor(document: ProjectDocument, session: string, saved: boolean, config: SimulationConfig) {
    this.#document = document;
    this.#session = session;
    this.#usedSessions = new Set([session]);
    this.#savedContent = saved ? content(document) : null;
    this.#state = this.#initialState();
    this.#controls = immutable({ valves: document.design.initialConditions.valves });
    this.#lastStepControls = this.#controls;
    this.#clock = new FixedClock(config);
    this.#result = failure('RESULT_PENDING', '/result', '当前工况尚未求值。');
    this.refresh();
  }
  snapshot() {
    return Object.freeze({
      document: this.#document,
      documentSessionId: this.#session,
      documentRevision: this.#documentRevision,
      physicsRevision: this.#physicsRevision,
      layoutRevision: this.#layoutRevision,
      dirty: this.#savedContent === null || content(this.#document) !== this.#savedContent,
      history: Object.freeze({
        undoCount: this.#undo.length,
        redoCount: this.#redo.length,
        bytes: this.#historyBytes(),
        capacity: budgets.historyCount,
      }),
      runtime: Object.freeze({
        identity: this.#identity(),
        state: this.#state,
        controls: this.#controls,
        running: this.#running,
        result: this.#result,
        lastStep: this.#lastStep,
        samples: this.#samples,
        truncated: this.#truncated,
        simulation: Object.freeze({
          config: this.#clock.config,
          remainderSeconds: this.#clock.remainderSeconds,
          sampleIntervalSeconds: this.#clock.config.stepSeconds * this.#clock.config.sampleEveryTicks,
          sampleCapacity: budgets.samples,
          samplesDropped: this.#samplesDropped,
          eventsTruncated: this.#eventsTruncated,
          eventCapacity: budgets.controlEvents,
          diagnostics: this.#timingDiagnostics,
        }),
        controlEvents: this.#events,
        scheduledControls: this.#scheduled,
      }),
      historicalRuns: this.#past,
      editor: Object.freeze({ selection: this.#selection, drag: this.#drag }),
      diagnostics: this.#diagnostics,
      saving: this.#pendingSave !== null,
    });
  }
  execute(command: unknown): Result<{ readonly changed: boolean }> {
    if (this.#fileTransition) return failure('FILE_BUSY', '/files', '文件切换提交中，请稍后编辑。');
    const result = applyCommand(this.#document, command);
    if (!result.ok) {
      this.#diagnostics = immutable([...result.diagnostics]);
      return result;
    }
    if (content(result.value) === content(this.#document)) {
      this.#diagnostics = Object.freeze([]);
      return changed(false);
    }
    const entry = {
      before: this.#document,
      after: result.value,
      bytes: 2 * (content(this.#document).length + content(result.value).length),
    };
    if (entry.bytes > budgets.historyBytes)
      return failure('HISTORY_LIMIT', '/history', '此项编辑快照超出历史预算，未提交。');
    this.#redo = [];
    this.#undo.push(entry);
    while (this.#undo.length > budgets.historyCount || this.#historyBytes() > budgets.historyBytes) this.#undo.shift();
    this.#adopt(result.value);
    return changed(true);
  }
  undo(): Result<{ readonly changed: boolean }> {
    if (this.#fileTransition) return failure('FILE_BUSY', '/files', '文件切换提交中，请稍后撤销。');
    const entry = this.#undo.pop();
    if (!entry) return changed(false);
    this.#redo.push(entry);
    this.#adopt(entry.before);
    return changed(true);
  }
  redo(): Result<{ readonly changed: boolean }> {
    if (this.#fileTransition) return failure('FILE_BUSY', '/files', '文件切换提交中，请稍后重做。');
    const entry = this.#redo.pop();
    if (!entry) return changed(false);
    this.#undo.push(entry);
    this.#adopt(entry.after);
    return changed(true);
  }
  select(selection: Selection): Result<true> {
    if (
      selection &&
      !(selection.kind === 'component' ? this.#document.design.components : this.#document.design.connections).some(
        (c) => c.id === selection.id,
      )
    )
      return failure('REFERENCE_INVALID', '/selection', '选择对象不存在。');
    this.#selection = selection ? immutable({ ...selection }) : null;
    return { ok: true, value: true };
  }
  beginDrag(componentId: string): Result<true> {
    const p = this.#document.layout.components.find((p) => p.componentId === componentId);
    if (!p) return failure('REFERENCE_INVALID', '/drag', '拖动元件不存在。');
    this.#drag = immutable({ componentId, x: p.x, y: p.y });
    return this.select({ kind: 'component', id: componentId });
  }
  previewDrag(x: number, y: number): Result<true> {
    if (!this.#drag) return failure('DRAG_INACTIVE', '/drag', '没有活动的拖动预览。');
    if (![x, y].every((v) => Number.isFinite(v) && Math.abs(v) <= 1_000_000))
      return failure('PARAMETER_INVALID', '/drag', '预览坐标超出文档布局范围。');
    this.#drag = immutable({ ...this.#drag, x, y });
    return { ok: true, value: true };
  }
  cancelDrag(): void {
    this.#drag = null;
  }
  commitDrag(): Result<{ readonly changed: boolean }> {
    const drag = this.#drag;
    this.#drag = null;
    return drag ? this.execute({ type: 'move-component', id: drag.componentId, x: drag.x, y: drag.y }) : changed(false);
  }
  prepareSolve(): SolveRequest {
    this.#requestSequence++;
    const identity = this.#identity();
    this.#latestRequest = identity;
    return Object.freeze({ identity, document: this.#document, state: this.#state, controls: this.#controls });
  }
  acceptSolve(identity: Identity, result: Result<Solution>): boolean {
    if (
      !this.#latestRequest ||
      canonical(identity) !== canonical(this.#latestRequest) ||
      canonical(identity) !== canonical(this.#identity())
    )
      return false;
    if (
      result.ok &&
      (canonical(result.value.state) !== canonical(this.#state) ||
        canonical(result.value.controls) !== canonical(this.#controls))
    )
      return false;
    this.#result = immutable(result);
    this.#latestRequest = null;
    return true;
  }
  refresh(): Result<Solution> {
    const request = this.prepareSolve();
    this.acceptSolve(request.identity, this.#solve(request.state));
    return this.#result;
  }
  #solve(state: unknown): Result<Solution> {
    this.#compiled ??= compileCircuit(this.#document);
    return this.#compiled.ok ? solve(this.#compiled.value, state, this.#controls) : this.#compiled;
  }
  setControl(componentId: string, positionId: ValvePositionId): Result<{ readonly changed: boolean }> {
    if (
      !this.#controls.valves.some((v) => v.componentId === componentId) ||
      !['extend', 'neutral', 'retract'].includes(positionId)
    )
      return failure('CONTROL_INVALID', '/controls', '换向阀或阀位无效。');
    const controls = {
      valves: this.#controls.valves.map((v) => (v.componentId === componentId ? { ...v, positionId } : v)),
    };
    if (canonical(controls) === canonical(this.#controls)) return changed(false);
    this.#controls = immutable(controls);
    this.#controlRevision++;
    this.#invalidate();
    this.#event({ componentId, positionId, tick: this.#state.tick, phase: 'preview' });
    if (!this.refresh().ok) this.pause();
    return changed(true);
  }
  scheduleControl(componentId: string, positionId: ValvePositionId, tick: number): Result<true> {
    if (
      !this.#controls.valves.some((v) => v.componentId === componentId) ||
      !['extend', 'neutral', 'retract'].includes(positionId) ||
      !Number.isSafeInteger(tick) ||
      tick <= this.#state.tick
    )
      return failure('CONTROL_INVALID', '/controls', '控制事件必须指向有效阀及未来安全整数tick。');
    if (this.#scheduled.length >= budgets.scheduledControls)
      return failure('CONTROL_QUEUE_LIMIT', '/controls', '待执行控制事件超过2000条，未加入。');
    this.#scheduled = immutable(
      [...this.#scheduled, { componentId, positionId, tick, sequence: ++this.#controlSequence }].sort(
        (a, b) => a.tick - b.tick || a.sequence - b.sequence,
      ),
    );
    return { ok: true, value: true };
  }
  #event(event: Omit<ControlEvent, 'sequence'>): void {
    const events = [...this.#events, { ...event, sequence: ++this.#controlSequence }];
    if (events.length > budgets.controlEvents) {
      events.shift();
      this.#eventsTruncated = true;
    }
    this.#events = immutable(events);
  }
  start(): Result<true> {
    const result = this.refresh();
    if (!result.ok) return result;
    if (!this.#running) this.#clock.clear();
    this.#timingDiagnostics = Object.freeze([]);
    this.#running = true;
    return { ok: true, value: true };
  }
  pause(): void {
    this.#running = false;
    this.#clock.clear();
    this.#invalidate();
  }
  suspend(reason: 'blur' | 'hidden'): void {
    if (!this.#running) return;
    this.pause();
    this.#timingDiagnostics = immutable([
      diagnostic(
        'FOCUS_PAUSED',
        '/simulation/clock',
        reason === 'hidden' ? '窗口已隐藏，运行暂停；请手动继续。' : '窗口失焦，运行暂停；请手动继续。',
      ),
    ]);
  }
  reset(): void {
    this.#archive();
    this.#resetRuntime();
    this.refresh();
  }
  captureRuntime(): Identity {
    return this.#identity();
  }
  acceptRuntime(identity: Identity, next: unknown): Result<boolean> {
    if (canonical(identity) !== canonical(this.#identity())) return { ok: true, value: false };
    const result = this.#solve(next);
    if (!result.ok) {
      this.#result = immutable(result);
      this.pause();
      return result;
    }
    if (
      result.value.state.tick !== this.#state.tick + 1 ||
      result.value.state.timeS !== (this.#state.tick + 1) * this.#clock.config.stepSeconds
    )
      return failure('STATE_INVALID', '/state', '运行响应必须恰好推进一个固定步长。');
    this.#state = result.value.state;
    this.#stateRevision++;
    this.#invalidate();
    this.refresh();
    return { ok: true, value: true };
  }
  /** One fixed step. Does not change the run/pause flag; singleStep is the UI action. */
  step(): Result<true> {
    return this.#step('single-step');
  }
  singleStep(): Result<true> {
    this.pause();
    return this.step();
  }
  advanceTime(elapsedSeconds: number, speed = 1, identity: Identity = this.#identity()): Result<number> {
    if (canonical(identity) !== canonical(this.#identity()) || !this.#running) return { ok: true, value: 0 };
    const consumed = this.#clock.consume(elapsedSeconds, speed);
    if (!consumed.ok) {
      this.pause();
      this.#timingDiagnostics = immutable(consumed.diagnostics);
      return consumed;
    }
    for (let i = 0; i < consumed.value; i++) {
      const result = this.#step('scheduled');
      if (!result.ok) {
        this.pause();
        return result;
      }
    }
    return consumed;
  }
  #step(source: 'scheduled' | 'single-step'): Result<true> {
    if (!Number.isSafeInteger(this.#state.tick + 1)) {
      this.pause();
      return failure('STATE_INVALID', '/state/tick', '运行tick超出安全整数范围。');
    }
    const tick = this.#state.tick + 1;
    const due = this.#scheduled.filter((e) => e.tick === tick);
    for (const event of due) {
      const controls = immutable({
        valves: this.#controls.valves.map((v) =>
          v.componentId === event.componentId ? { componentId: v.componentId, positionId: event.positionId } : v,
        ),
      });
      if (canonical(controls) !== canonical(this.#controls)) {
        this.#controls = controls;
        this.#controlRevision++;
        this.#invalidate();
      }
    }
    this.#scheduled = Object.freeze(this.#scheduled.filter((e) => e.tick > tick));
    const before = this.refresh();
    if (!before.ok) {
      this.pause();
      return before;
    }
    const accepted = this.acceptRuntime(
      this.#identity(),
      advanceState(this.#state, before.value, this.#clock.config.stepSeconds),
    );
    if (!accepted.ok) return accepted;
    for (const valve of this.#controls.valves) {
      if (
        this.#lastStepControls.valves.find((v) => v.componentId === valve.componentId)?.positionId !== valve.positionId
      )
        this.#event({ ...valve, tick, phase: 'step' });
    }
    this.#lastStepControls = this.#controls;
    this.#lastStep = Object.freeze({
      identity: this.#identity(),
      state: this.#state,
      controls: this.#controls,
      result: this.#result,
      controlSequence: this.#controlSequence,
      source: 'step',
    });
    if (source === 'single-step' || tick % this.#clock.config.sampleEveryTicks === 0) this.recordSample(source);
    return { ok: true, value: true };
  }
  recordSample(source: Sample['source'] = 'manual'): boolean {
    if (!this.#result.ok) return false;
    const r = this.#result.value;
    const sample: Sample = immutable({
      timeS: this.#state.timeS,
      tick: this.#state.tick,
      pumpGaugePressurePa: r.pumpGaugePressurePa,
      actuatorFlowM3PerS: r.actuatorFlowM3PerS,
      shaftPowerW: r.shaftPowerW,
      actuatorStates: this.#state.actuatorStates,
      angularSpeedRadPerS: r.angularSpeedRadPerS,
      controls: this.#controls,
      controlSequence: this.#controlSequence,
      source,
    });
    const samples = [...this.#samples, sample];
    if (samples.length > budgets.samples) {
      samples.shift();
      this.#truncated = true;
      this.#samplesDropped++;
    }
    this.#samples = Object.freeze(samples);
    return true;
  }
  captureSave(requestId: string): Result<SaveCapture> {
    if (this.#fileTransition) return failure('FILE_BUSY', '/files', '文件切换提交中，请稍后保存。');
    if (!requestId || this.#pendingSave) return failure('SAVE_BUSY', '/save', '一次只能确认一个保存请求。');
    this.#pendingSave = Object.freeze({
      documentSessionId: this.#session,
      requestId,
      documentRevision: this.#documentRevision,
      document: this.#document,
      content: content(this.#document),
    });
    return { ok: true, value: this.#pendingSave };
  }
  confirmSave(capture: SaveCapture, outcome: 'saved' | 'cancelled' | 'failed'): boolean {
    if (capture !== this.#pendingSave || capture.documentSessionId !== this.#session) return false;
    this.#pendingSave = null;
    if (outcome === 'saved') this.#savedContent = capture.content;
    return true;
  }
  captureTransition(requestId: string): TransitionCapture {
    if (this.#fileTransition) return this.#fileTransition;
    this.#transition = Object.freeze({
      documentSessionId: this.#session,
      documentRevision: this.#documentRevision,
      requestId,
    });
    return this.#transition;
  }
  lockTransition(capture: TransitionCapture): Result<true> {
    if (this.#fileTransition) return failure('FILE_BUSY', '/files', '已有文件切换提交。');
    if (
      capture !== this.#transition ||
      capture.documentSessionId !== this.#session ||
      capture.documentRevision !== this.#documentRevision
    )
      return failure('RESPONSE_STALE', '/files', '打开令牌已经失效。');
    this.#fileTransition = capture;
    return { ok: true, value: true };
  }
  unlockTransition(capture: TransitionCapture): void {
    if (capture === this.#fileTransition) this.#fileTransition = null;
  }
  openDocument(input: unknown, session: string, saved = false, expected?: TransitionCapture): Result<true> {
    if (this.#fileTransition && expected !== this.#fileTransition)
      return failure('FILE_BUSY', '/files', '文件切换提交中。');
    if (
      expected &&
      (expected !== this.#transition ||
        expected.documentSessionId !== this.#session ||
        expected.documentRevision !== this.#documentRevision)
    )
      return failure('RESPONSE_STALE', '/open', '读取期间工程已改变，未替换当前内容。');
    if (!session || this.#usedSessions.has(session))
      return failure('SESSION_INVALID', '/session', '新工程会话身份不能为空或复用。');
    const parsed = parseDocument(input);
    if (!parsed.ok) return parsed;
    this.#usedSessions.add(session);
    this.#session = session;
    this.#document = parsed.value;
    this.#savedContent = saved ? content(parsed.value) : null;
    this.#documentRevision = 0;
    this.#physicsRevision = 0;
    this.#layoutRevision = 0;
    this.#undo = [];
    this.#redo = [];
    this.#past = Object.freeze([]);
    this.#samples = Object.freeze([]);
    this.#selection = null;
    this.#drag = null;
    this.#pendingSave = null;
    this.#transition = null;
    this.#fileTransition = null;
    this.#resetRuntime();
    this.refresh();
    return { ok: true, value: true };
  }
  #identity(): Identity {
    return Object.freeze({
      documentSessionId: this.#session,
      physicsRevision: this.#physicsRevision,
      runId: this.#runId,
      controlRevision: this.#controlRevision,
      stateRevision: this.#stateRevision,
      requestSequence: this.#requestSequence,
    });
  }
  #initialState(): SimulationState {
    return immutable({ tick: 0, timeS: 0, actuatorStates: this.#document.design.initialConditions.actuators });
  }
  #invalidate(): void {
    this.#requestSequence++;
    this.#latestRequest = null;
  }
  #historyBytes(): number {
    return [...this.#undo, ...this.#redo].reduce((n, entry) => n + entry.bytes, 0);
  }
  #archive(): void {
    if (!this.#samples.length && !this.#events.length && !this.#state.tick) return;
    this.#past = Object.freeze(
      [
        ...this.#past,
        immutable({
          documentSessionId: this.#session,
          runId: this.#runId,
          physicsRevision: this.#physicsRevision,
          document: this.#document,
          documentRevision: this.#documentRevision,
          layoutRevision: this.#layoutRevision,
          preview: {
            identity: this.#identity(),
            state: this.#state,
            controls: this.#controls,
            result: this.#result,
            controlSequence: this.#controlSequence,
            source: 'static-preview' as const,
          },
          lastStep: this.#lastStep,
          controls: this.#controls,
          result: this.#result,
          samples: this.#samples,
          truncated: this.#truncated,
          config: this.#clock.config,
          initialState: this.#initialState(),
          initialControls: { valves: this.#document.design.initialConditions.valves },
          controlEvents: this.#events,
          eventsTruncated: this.#eventsTruncated,
          samplesDropped: this.#samplesDropped,
        }),
      ].slice(-budgets.historicalRuns),
    );
  }
  #resetRuntime(): void {
    this.#lastStep = null;
    this.#running = false;
    this.#runId++;
    this.#controlRevision++;
    this.#stateRevision++;
    this.#state = this.#initialState();
    this.#controls = immutable({ valves: this.#document.design.initialConditions.valves });
    this.#lastStepControls = this.#controls;
    this.#clock.clear();
    this.#compiled = null;
    this.#events = Object.freeze([]);
    this.#scheduled = Object.freeze([]);
    this.#controlSequence = 0;
    this.#eventsTruncated = false;
    this.#samplesDropped = 0;
    this.#timingDiagnostics = Object.freeze([]);
    this.#samples = Object.freeze([]);
    this.#truncated = false;
    this.#result = failure('RESULT_PENDING', '/result', '物理工况已改变，等待重新求值。');
    this.#invalidate();
  }
  #adopt(next: ProjectDocument): void {
    const physics = physicalContent(next) !== physicalContent(this.#document);
    const layout = canonical(next.layout) !== canonical(this.#document.layout);
    if (physics) this.#archive();
    this.#document = next;
    this.#documentRevision++;
    if (layout) this.#layoutRevision++;
    this.#drag = null;
    this.#diagnostics = Object.freeze([]);
    if (
      this.#selection &&
      !(this.#selection.kind === 'component' ? next.design.components : next.design.connections).some(
        (c) => c.id === this.#selection?.id,
      )
    )
      this.#selection = null;
    if (physics) {
      this.#physicsRevision++;
      this.#resetRuntime();
      this.refresh();
    }
  }
}
export {
  previewNetworkSizing,
  applyNetworkSizing,
  exportCalculationCsv,
  exportNetworkLearningCsv,
  capturedCalculationRecord,
} from './network-sizing.js';
export type { NetworkSizingPreview } from './network-sizing.js';
export { networkToolCatalogDefinition } from './network-tool-selection.js';
export { NetworkTools, networkToolBase } from './network-tools.js';
export { networkToolParameterRows, networkToolParameterChanges } from './network-tool-parameters.js';
export type {
  NetworkToolSource,
  NetworkToolDiagnosticSnapshot,
  NetworkToolProposal,
  NetworkToolPort,
} from './network-tools.js';
export { NetworkToolFiles, type NetworkToolExportItem } from './network-tool-files.js';
export { NetworkToolSettings, networkToolSettingDefinitions } from './network-tool-interface.js';
export type {
  NetworkToolSettingChange,
  NetworkToolSettingsSnapshot,
  NetworkToolSettingOutcome,
  NetworkToolSettingsOperation,
} from './network-tool-interface.js';
export type { NetworkToolFileOperation } from './network-tool-files.js';
export { networkToolCommandLimit } from './network-tool-commands.js';
export { parseNetworkToolRequest } from './network-tool-protocol.js';
export { networkToolCalculate, networkToolCalculationSchemas } from './network-tool-calculation.js';
export type { NetworkToolCalculationOperation, NetworkToolCalculationResult } from './network-tool-calculation.js';
export type {
  NetworkToolRequest,
  NetworkToolBase,
  NetworkToolCollection,
  NetworkToolFileAction,
} from './network-tool-protocol.js';
export { planNetworkToolCommands } from './network-tool-commands.js';
export type { NetworkToolCommand, NetworkToolEditPlan } from './network-tool-commands.js';
export { parseNetworkControlRecordPage } from './network-control-records.js';
export type { NetworkControlEvent, NetworkControlRecordPage } from './network-control-records.js';
export { previewNetworkDuty, applyNetworkDuty } from './network-duty.js';
export type { NetworkDutyPreview } from './network-duty.js';
export {
  planNetworkLayout,
  previewNetworkLayout,
  previewNetworkLayoutAsync,
  applyNetworkLayout,
} from './network-layout.js';
export type {
  NetworkLayoutRequest,
  NetworkLayoutPlan,
  NetworkLayoutPreview,
  NetworkLayoutPlanner,
} from './network-layout.js';
export {
  previewNetworkGoal,
  previewIndependentNetworkGoal,
  previewCombinedNetworkGoal,
  applyNetworkGoal,
  networkParameterRulesOnlyEdit,
  planNetworkParameterLock,
} from './network-goal.js';
export type { NetworkGoalPreview, NetworkGoalCandidatePreview } from './network-goal.js';
export {
  networkDrawingRoute,
  networkDrawingRoutes,
  networkDrawingObstacles,
  networkEndpointPosition,
  basicDrawingRoute,
  orthogonalDrawingPath,
  drawingSegmentClear,
} from './network-routing.js';
export type { DrawingPoint, DrawingObstacle, DrawingSegment } from './network-routing.js';
export { planNetworkRouteSimplification } from './network-route-simplification.js';
export { planNetworkFlowMeterInsertion } from './network-flow-meter.js';
export { planNetworkBranchConnection } from './network-branch-connection.js';
export { networkBranchConnectionGroups, networkDrawingJunctions } from './network-branch-geometry.js';
export { networkLayoutProfiles } from './network-layout-roles.js';
export type {
  NetworkConnectionAnchor,
  NetworkRouteAnchor,
  NetworkBranchConnectionPlan,
} from './network-branch-connection.js';
export type { NetworkRouteSimplificationPlan } from './network-route-simplification.js';
export type ApplicationState = ReturnType<Application['snapshot']>;
export type ApplicationStore = Application;
export function createApplication(
  input: unknown,
  session: string,
  saved = false,
  stepSeconds?: unknown,
): Result<ApplicationStore> {
  if (!session) return failure('SESSION_INVALID', '/session', '工程会话身份不能为空。');
  const config = simulationConfig(stepSeconds);
  if (!config.ok) return config;
  const parsed = parseDocument(input);
  return parsed.ok ? { ok: true, value: new Application(parsed.value, session, saved, config.value) } : parsed;
}

export * from './network-editing.js';
export * from './network-valve-library.js';
export {
  projectCurveSample,
  parseCurveRequest,
  reduceCurveSamples,
  planNetworkCurve,
  exportCurveSegment,
} from './network-curve-plan.js';
export { parseCurveCapture } from './network-curve-capture.js';
export type { CurveRequest, CurveSample, CurvePlan, ReductionSeries, Reduction } from './network-curve-plan.js';
export {
  drawingFields,
  changeFields,
  paperDimensions,
  parseDrawingSettings,
  parseCalculationBook,
  parseCalculationPdfSource,
  calculationBook,
  dutyGroupSections,
  dutyCombinedSections,
  dutyFlowSplitSection,
  dutyFlowSplitSections,
  dutyCoverageSections,
  parseNetworkArtifact,
} from './formal-export.js';
export { bookMathLatex, bookMathMl, calculationBookMarkup } from './calculation-book-presentation.js';
export type {
  PaperSize,
  DrawingSettings,
  BookSection,
  BookMath,
  CalculationBook,
  FormalArtifact,
  NetworkArtifact,
} from './formal-export.js';
export { drawingFrameFromBoxes } from './drawing-frame-boxes.js';
export {
  drawingFrameFile,
  frameBoxLimits,
  parseDrawingTemplate,
  parseDrawingTemplateLibrary,
  parseFrameFile,
} from './drawing-template.js';
export type { DrawingTemplate, DrawingTemplateField, DrawingTableCell } from './drawing-template.js';

export { parseOfflineCurve, prepareOfflineCurve } from './offline-curve.js';
export type { OfflineCurve } from './offline-curve.js';

export {
  parseCurveFile,
  curveFileText,
  fullCurveFromPlan,
  prepareCurveFile,
  storedCurveCsv,
  parseCurveFigureSettings,
} from './curve-file.js';
export type { CurveFile, CurveFigureSettings } from './curve-file.js';

export { planNetworkPilotLockPair } from './network-lock-pair.js';
export {
  previewNetworkCatalog,
  exportNetworkCatalog,
  prepareNetworkDutyCalculation,
  prepareIndependentDutyCalculation,
  prepareCombinedDutyCalculation,
} from './network-catalog.js';
export type { NetworkCatalogPreview } from './network-catalog.js';
export { NetworkSequenceRun, planNetworkSequence } from './network-sequence.js';
export { NetworkControllerFleet, type ControllerRunView } from './network-controllers.js';
export { planNetworkProbe, nextNetworkController, type NetworkProbeEdit } from './network-probes.js';
export { planNetworkDeleteSelection } from './network-editing.js';
export { planNetworkText, type NetworkTextEdit } from './network-texts.js';
export { parseNetworkOnlineControlBatch, networkFlowCorrection } from './network-flow-regulation.js';
export type { NetworkOnlineControl, NetworkFlowRegulatorView } from './network-flow-regulation.js';

export { NetworkToolCurves, type NetworkToolCurve } from './network-tool-curves.js';
