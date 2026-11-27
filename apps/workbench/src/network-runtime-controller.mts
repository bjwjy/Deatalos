import {
  captureNetworkExport,
  type NetworkExportCapture,
  type KernelServiceCommand,
  type CylinderCondition,
  type NetworkRuntimeView,
  parseNetworkOnlineControlBatch,
} from '@hyd/application';
import {
  diagnostic,
  prepareNetworkStepRun,
  type NetworkProject,
  type NetworkIdentity,
  type DisplayDiagnostic,
  type Result,
  type NetworkSnapshot,
} from '@hyd/domain';
import { requestRuntime, requestRecords } from './network-service-client.mjs';
interface RuntimeHooks {
  document(): NetworkProject;
  allowAutoLowPressure?(): boolean;
  lowPressureChanged?(message: string | null): void;
  sessionId(): string;
  physicsRevision(): number;
  render(): void;
  renderFeedback(): void;
  clearDiagnostics(): void;
  diagnostics(items: readonly DisplayDiagnostic[], source?: string): void;
  toast(message: string): void;
  busyChanged(busy: boolean): void;
  recordSelection(): string;
  rememberCurve?(capture: NetworkExportCapture): void;
  interacting(): boolean;
  invalidateInteraction(): void;
  clearExportStatus(): void;
  beforeReset?(): Promise<void>;
  afterReset?(): void;
}
type ServiceArguments<C = KernelServiceCommand> = C extends { readonly action: infer A }
  ? keyof Omit<C, 'action'> extends never
    ? [action: A]
    : A extends 'control'
      ? [action: A, extra: Omit<C, 'action'>, refused: (failure: Extract<Result<never>, { ok: false }>) => void]
      : [action: A, extra: Omit<C, 'action'>]
  : never;
export function createNetworkRuntime(hooks: RuntimeHooks, transport = { requestRuntime, requestRecords }) {
  let runtime: NetworkRuntimeView | null = null;
  let manualRecoverySession: string | null = null;
  let notifiedRun: string | null = null;
  let runtimeError = '',
    physicsInvalidated = false;
  let requestSequence = 0,
    snapshotId = 0,
    acceptedServiceSequence = 0,
    pollTimer = 0;
  let operations: Promise<void> = Promise.resolve();
  let pendingOperations = 0,
    readOnlyOperations = 0;
  let pollInFlight = false,
    firstCurvePending = false;
  let recordCapture: NetworkExportCapture | null = null;
  let pendingInitialization: {
    readonly sessionId: string;
    readonly physicsRevision: number;
    readonly sequence: number;
    percent: number;
    stage: string;
  } | null = null;
  function initializing(): boolean {
    return (
      pendingInitialization?.sessionId === hooks.sessionId() &&
      pendingInitialization.physicsRevision === hooks.physicsRevision()
    );
  }
  function enqueue(task: () => Promise<unknown>, mode: 'mutation' | 'capture' = 'mutation'): Promise<void> {
    const documentSession = hooks.sessionId(),
      physicsRevision = hooks.physicsRevision();
    let reading = false;
    pendingOperations++;
    hooks.busyChanged(true);
    const next = operations
      .then(async () => {
        if (hooks.sessionId() !== documentSession || hooks.physicsRevision() !== physicsRevision) return;
        reading = mode === 'capture';
        if (reading) readOnlyOperations++;
        await task();
      })
      .catch((cause) => {
        if (hooks.sessionId() !== documentSession || hooks.physicsRevision() !== physicsRevision) return;
        window.clearTimeout(pollTimer);
        runtime = null;
        recordCapture = null;
        runtimeError = '运行通信失败，当前运行已隔离。请检查技术详情后重新初始化。';
        hooks.render();
        hooks.diagnostics(
          [{ code: 'RUNTIME_COMMUNICATION_FAILED', message: String(cause).slice(0, 1000) }],
          '运行通信',
        );
      })
      .finally(() => {
        if (reading) readOnlyOperations--;
        pendingOperations--;
        hooks.busyChanged(pendingOperations > 0);
      });
    operations = next;
    return next;
  }
  function expected(): NetworkIdentity | null {
    return runtime?.identity ?? null;
  }
  async function service(
    ...[action, extra, refused]: ServiceArguments
  ): Promise<Extract<Result<NetworkRuntimeView>, { ok: true }> | null> {
    const documentSession = hooks.sessionId(),
      physicsRevision = hooks.physicsRevision();
    const clientSequence = ++requestSequence;
    // This is a wire envelope: the transport parses it before crossing IPC.
    const request = {
      version: 2,
      clientSequence,
      action,
      expected: action === 'initialize' ? null : expected(),
      ...extra,
    };
    let result: Result<NetworkRuntimeView>;
    try {
      result = await transport.requestRuntime(request);
    } catch (cause) {
      if (
        documentSession !== hooks.sessionId() ||
        physicsRevision !== hooks.physicsRevision() ||
        clientSequence < acceptedServiceSequence
      )
        return null;
      result = {
        ok: false,
        diagnostics: [diagnostic('RUNTIME_COMMUNICATION_FAILED', '/kernel', String(cause).slice(0, 1000))],
      };
    }
    if (
      documentSession !== hooks.sessionId() ||
      physicsRevision !== hooks.physicsRevision() ||
      clientSequence < acceptedServiceSequence
    )
      return null;
    if (!result?.ok) {
      if (result) refused?.(result);
      const items: readonly DisplayDiagnostic[] = result?.diagnostics ?? [
        { code: 'RUNTIME_INVALID', message: '运行服务返回无效响应。' },
      ];
      // A refused read/control is not evidence that the accepted physical state failed.
      if (
        items.length &&
        items.every((d) =>
          [
            'RESPONSE_STALE',
            'RUNTIME_BUSY',
            'SEQUENCE_ACTIVE',
            'SEQUENCE_STALE',
            'CONTROLLER_CONFLICT',
            'PRESSURE_CONTROL_BLOCKED',
            'SEQUENCE_INVALID',
            'SEQUENCE_REFERENCE_INVALID',
          ].includes(d.code),
        )
      ) {
        hooks.diagnostics(items, '运行请求');
        return null;
      }
      if (action === 'capture' && !items.some((d) => /BACKEND|NATIVE|COMMUNICATION/.test(d.code))) {
        hooks.diagnostics(items, '记录捕获');
        return null;
      }
      if (action === 'recover') {
        acceptedServiceSequence = clientSequence;
        hooks.diagnostics(items, '恢复到最后有效点');
        return null;
      }
      if (runtime?.identity && (action === 'step' || action === 'control')) {
        acceptedServiceSequence = clientSequence;
        await service('state');
        if (documentSession === hooks.sessionId() && physicsRevision === hooks.physicsRevision())
          hooks.diagnostics(items, '运行请求');
        return null;
      }
      acceptedServiceSequence = clientSequence;
      window.clearTimeout(pollTimer);
      runtime = null;
      recordCapture = null;
      runtimeError = action === 'initialize' ? '' : '运行已隔离；没有当前有效结果。检查诊断后明确重新初始化。';
      const source =
        action === 'initialize'
          ? '初始化'
          : ['start', 'state', 'sequence-start', 'sequence-resume'].includes(action)
            ? '运行报错'
            : '运行请求';
      hooks.diagnostics(items, source);
      hooks.render();
      return null;
    }
    if (result.ok) {
      const incoming = result.value;
      if (
        incoming.documentSessionId !== hooks.sessionId() ||
        incoming.physicsRevision !== hooks.physicsRevision() ||
        incoming.identity?.documentSessionId !== hooks.sessionId() ||
        incoming.identity?.physicsRevision !== hooks.physicsRevision()
      )
        return null;
      if (runtime?.identity) {
        const sameRun = incoming.identity.simulationSessionId === runtime.identity.simulationSessionId;
        if (
          (!sameRun && !['initialize', 'reset'].includes(action)) ||
          (sameRun && incoming.identity.requestSequence < runtime.identity.requestSequence)
        )
          return null;
      }
      const activation = incoming.diagnostics.find((item) => item.code === 'AUTO_LOW_PRESSURE_ACTIVE');
      if (activation && notifiedRun !== incoming.identity.simulationSessionId) {
        notifiedRun = incoming.identity.simulationSessionId;
        hooks.lowPressureChanged?.(activation.message);
      } else if (!activation && notifiedRun !== null && notifiedRun !== incoming.identity.simulationSessionId) {
        notifiedRun = null;
        hooks.lowPressureChanged?.(null);
      }
      runtime = incoming;
      if (runtime?.status !== 'ready') recordCapture = null;
    }
    acceptedServiceSequence = clientSequence;
    runtimeError = '';
    hooks.render();
    return result;
  }
  async function initialize() {
    const prepared = prepareNetworkStepRun(hooks.document());
    if (!prepared.ok) {
      hooks.diagnostics(prepared.diagnostics, '初始化');
      return null;
    }
    const owner = {
      sessionId: hooks.sessionId(),
      physicsRevision: hooks.physicsRevision(),
      sequence: requestSequence + 1,
      percent: 0,
      stage: '准备仿真模型',
    };
    pendingInitialization = owner;
    hooks.renderFeedback();
    try {
      const initialized = await service('initialize', {
        project: prepared.value.document,
        documentSessionId: owner.sessionId,
        physicsRevision: owner.physicsRevision,
        autoLowPressure: hooks.allowAutoLowPressure?.() === true,
        mapping: {
          nativeStepS: prepared.value.nativeStepS,
          junctionPolicy: 'tlm-limit',
          initialPressurePa: 100000,
          volumeScale: 1,
          constraintPressureTolerancePa: 0.02,
        },
      });
      if (initialized) {
        physicsInvalidated = false;
        if (pendingInitialization === owner && initializing()) {
          owner.percent = 100;
          owner.stage = '初始化完成';
          hooks.renderFeedback();
        }
      }
      return initialized;
    } finally {
      if (pendingInitialization === owner) {
        pendingInitialization = null;
        if (owner.sessionId === hooks.sessionId() && owner.physicsRevision === hooks.physicsRevision())
          hooks.renderFeedback();
      }
    }
  }
  const runtimeFailure = (
    code: string,
    message: string,
    field = '/simulation',
  ): Extract<Result<never>, { ok: false }> => ({
    ok: false,
    diagnostics: [diagnostic(code, field, message)],
  });
  function readyRuntime() {
    return runtime?.status === 'ready' &&
      runtime.identity?.documentSessionId === hooks.sessionId() &&
      runtime.identity.physicsRevision === hooks.physicsRevision()
      ? runtime
      : null;
  }
  async function run(current: () => boolean, ticks?: number, condition?: CylinderCondition) {
    hooks.clearDiagnostics();
    if (!hooks.document().design.components.length) {
      const failure = runtimeFailure('GRAPH_INCOMPLETE', '空白工程没有可运行的物理图。', '/design/components');
      hooks.diagnostics(failure.diagnostics, '初始化');
      return failure;
    }
    if (canRecover()) {
      return recover();
    }
    if (!readyRuntime()) {
      const result = await initialize();
      if (!result) return;
    }
    if (!current()) return;
    let result: Awaited<ReturnType<typeof service>>;
    const limit = ticks === undefined ? {} : { ticks, ...(condition ? { condition } : {}) };
    if (
      runtime?.identity?.simulationSessionId !== manualRecoverySession &&
      hooks.document().design.components.some((c) => c.typeId === 'dynamic-controller')
    ) {
      if (runtime?.sequence?.status === 'paused')
        result = await service('sequence-resume', { sequenceRunId: runtime.sequence.runId, ...limit });
      else if (runtime?.sequence?.status !== 'running')
        result = await service('sequence-start', { project: hooks.document(), ...limit });
      else result = { ok: true, value: runtime };
    } else result = await service('start', { speed: 1, ...limit });
    startPolling();
    return result;
  }
  async function operateLimited(
    ticks: number,
    current: () => boolean,
    condition?: CylinderCondition,
  ): Promise<Result<NetworkRuntimeView>> {
    if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 10000)
      return runtimeFailure('CLOCK_INVALID', '有限运行需要1至10000个固定步。');
    if (!current()) return runtimeFailure('TOOL_RETIRED', '本次仿真授权已退役。');
    if (runtime?.running) return runtimeFailure('RUN_ALREADY_RUNNING', '当前已运行，请暂停并重新捕获后发起有限运行。');
    if (canRecover())
      return runtimeFailure('RECOVERY_REQUIRED', '先用运行命令恢复最后有效点并暂停，再重新捕获后发起有限运行。');
    return (
      (await run(current, ticks, condition)) ?? runtimeFailure('SIMULATION_ACTION_FAILED', '有限运行未返回有效回执。')
    );
  }
  async function pauseLimited(): Promise<void> {
    if (!readyRuntime()) return;
    await service('pause-bounded');
  }
  function canRecover(): boolean {
    return (
      !physicsInvalidated &&
      runtime?.status === 'failed' &&
      !!runtime.lastSuccessfulHistorical &&
      runtime.identity?.documentSessionId === hooks.sessionId() &&
      runtime.identity.physicsRevision === hooks.physicsRevision()
    );
  }
  async function recover() {
    if (!canRecover()) return;
    stopPolling();
    hooks.clearDiagnostics();
    const reply = await service('recover');
    if (!reply?.value.point) return;
    manualRecoverySession = reply.value.point.identity.simulationSessionId;
    await refreshRecords();
    hooks.toast('已恢复到最后有效点并暂停。可调整控制，再点击运行。');
    return reply;
  }
  /** Called inside the shared runtime queue by both the workbench and the AI bridge. */
  async function operateSimulation(
    action: 'run' | 'pause' | 'step' | 'reset' | 'sequence-stop',
    current: () => boolean = () => true,
  ): Promise<Result<NetworkRuntimeView>> {
    const retired = () => runtimeFailure('TOOL_RETIRED', '仿真控制已退役，未继续派发。');
    const failed = () => runtimeFailure('SIMULATION_ACTION_FAILED', '仿真未返回有效回执，请查看当前诊断。');
    if (!current()) return retired();
    if (action === 'run') return (await run(current)) ?? (current() ? failed() : retired());
    hooks.clearDiagnostics();
    if (action === 'sequence-stop') {
      const ready = readyRuntime();
      if (!ready?.sequence)
        return runtimeFailure('SEQUENCE_NOT_ACTIVE', '当前没有可停止的自动控制序列，未初始化或重置仿真。');
      const result = await service(action, { sequenceRunId: ready.sequence.runId });
      if (!result) return failed();
      stopPolling();
      await refreshRecords();
      return result;
    }
    if (action === 'pause') {
      if (!readyRuntime()) {
        const failure = runtimeFailure('RUNTIME_NOT_READY', '当前没有可暂停的有效运行；未向内核派发暂停。');
        hooks.diagnostics(failure.diagnostics, '暂停');
        return failure;
      }
      stopPolling();
      const result = await service('pause');
      if (!result) return failed();
      await refreshRecords();
      return result;
    }
    if (action === 'step' && canRecover()) {
      const message = '请先恢复到最后有效点，再单步运行。';
      hooks.toast(message);
      return runtimeFailure('RUNTIME_RECOVERY_REQUIRED', message);
    }
    if (!readyRuntime() && !(await initialize())) return failed();
    if (action === 'reset') await hooks.beforeReset?.();
    if (!current()) return retired();
    const result = await service(action);
    if (!result) return failed();
    if (action === 'reset') hooks.afterReset?.();
    await refreshRecords();
    return result;
  }
  function startPolling() {
    window.clearTimeout(pollTimer);
    firstCurvePending = !recordCapture;
    if (
      runtime?.running &&
      runtime.status === 'ready' &&
      runtime.identity?.physicsRevision === hooks.physicsRevision()
    ) {
      hooks.clearDiagnostics();
      hooks.renderFeedback();
    }
    const pollIfReady = () => {
      if (!runtime?.running) return;
      pollTimer = window.setTimeout(pollIfReady, 100);
      if (pollInFlight || hooks.interacting() || (pendingOperations && !readOnlyOperations)) return;
      const poll = async () => {
        pollInFlight = true;
        try {
          await service('state');
          if (firstCurvePending && runtime?.point && runtime.identity && runtime.identity.tick > 0) {
            firstCurvePending = false;
            await refreshRecords();
          } else if (!runtime?.running && !readOnlyOperations) await refreshRecords();
        } finally {
          pollInFlight = false;
        }
      };
      // Frozen record pages are immutable reads; they need not starve live state.
      if (readOnlyOperations) void poll();
      else void enqueue(poll);
    };
    // Request the first live frame promptly after native dispatch, then keep the
    // established 100ms cadence. Physics time/step and native pacing are unchanged.
    pollTimer = window.setTimeout(pollIfReady, 16);
  }
  async function sendControl(changes: unknown[]) {
    const target = runtime?.identity;
    if (!target) {
      hooks.diagnostics([{ code: 'RUNTIME_NOT_READY', message: '请先运行初始化，再操作当前运行。' }]);
      return;
    }
    const result = await applyControl(changes, target);
    if (result.ok && !runtime?.running) await enqueue(() => refreshRecords(), 'capture');
  }
  async function applyControl(changes: unknown, target: NetworkIdentity): Promise<Result<NetworkSnapshot>> {
    let outcome: Result<NetworkSnapshot> = runtimeFailure('RESPONSE_STALE', '控制未确认，运行可能已切换。');
    await enqueue(async () => {
      outcome = await dispatchControl(changes, target);
    });
    return outcome;
  }
  /** Called only by tasks already holding the runtime queue. */
  async function dispatchControl(changes: unknown, target: NetworkIdentity): Promise<Result<NetworkSnapshot>> {
    hooks.clearDiagnostics();
    const active = readyRuntime();
    if (
      !active?.identity ||
      active.identity.documentSessionId !== target.documentSessionId ||
      active.identity.physicsRevision !== target.physicsRevision ||
      active.identity.simulationSessionId !== target.simulationSessionId
    ) {
      const failure = runtimeFailure(
        'RUNTIME_NOT_READY',
        '当前仿真未初始化或已失效。请检查诊断后明确点击运行重新初始化，再操作阀位；不会自动恢复旧仿真。',
        '/control',
      );
      hooks.diagnostics(failure.diagnostics);
      return failure;
    }
    const parsed = parseNetworkOnlineControlBatch(hooks.document(), changes);
    if (!parsed.ok) {
      hooks.diagnostics(parsed.diagnostics);
      return parsed;
    }
    let outcome: Result<NetworkSnapshot> = runtimeFailure('RESPONSE_STALE', '控制未确认，运行可能已切换。');
    const reply = await service(
      'control',
      { controls: parsed.value, ...(active.sequence ? { sequenceRunId: active.sequence.runId } : {}) },
      (failure) => {
        outcome = failure;
      },
    );
    // The receipt already contains the accepted point. Pause/capture owns record refresh.
    return reply?.value.point ? { ok: true, value: reply.value.point } : outcome;
  }
  async function refreshRecords(source?: 'current'): Promise<NetworkExportCapture | null> {
    if (
      !runtime ||
      runtime.status !== 'ready' ||
      runtime.identity?.documentSessionId !== hooks.sessionId() ||
      runtime.identity.physicsRevision !== hooks.physicsRevision()
    )
      return null;
    const pinned = await service('capture');
    if (!pinned) return null;
    const identity = pinned.value.identity;
    if (!identity) return null;
    const documentSession = hooks.sessionId(),
      physicsRevision = hooks.physicsRevision();
    const selection = source ?? hooks.recordSelection();
    const livePreview = selection === 'current' && runtime?.running && !source;
    let lastPaint = performance.now();
    const captured = await captureNetworkExport(
      {
        records: async (expectedIdentity, range) => {
          // A pinned window is independent of ongoing advances. Let Chromium paint
          // between live pages when replies have already consumed a frame budget.
          if (
            livePreview &&
            range.offset > 0 &&
            document.visibilityState === 'visible' &&
            performance.now() - lastPaint >= 6
          ) {
            await new Promise<void>((resolve) => {
              const timer = window.setTimeout(() => {
                cancelAnimationFrame(frame);
                resolve();
              }, 32);
              const frame = requestAnimationFrame(() => {
                window.clearTimeout(timer);
                resolve();
              });
            });
            lastPaint = performance.now();
          }
          return transport.requestRecords({
            version: 2,
            clientSequence: ++requestSequence,
            action: 'records',
            expected: expectedIdentity,
            selection: range,
          });
        },
      },
      identity,
      selection === 'current' ? null : selection,
      {
        snapshotId: `e06-${++snapshotId}-${crypto.randomUUID().slice(0, 8)}`,
        capturedAt: new Date().toISOString(),
        appVersion: '0.9.0-e06',
      },
      livePreview ? (recordCapture?.samples ?? []) : undefined,
    );
    if (documentSession !== hooks.sessionId() || physicsRevision !== hooks.physicsRevision()) return null;
    if (!captured.ok) {
      if (!source) recordCapture = null;
      hooks.render();
      hooks.diagnostics(captured.diagnostics);
      return null;
    }
    // A layout transaction does not recompile the runtime document. Capture the
    // current validated layout explicitly so SVG and saved engineering layout agree.
    const result: NetworkExportCapture = {
      ...captured.value,
      view: { ...captured.value.view, document: { ...captured.value.view.document, layout: hooks.document().layout } },
    };
    if (!runtime?.running) hooks.rememberCurve?.(result);
    if (source) return result;
    recordCapture = result;
    hooks.render();
    return recordCapture;
  }
  async function stateForCapture() {
    if (!runtime || runtime.status !== 'ready' || runtime.identity?.physicsRevision !== hooks.physicsRevision()) {
      hooks.toast('没有当前修订的有效结果');
      return null;
    }
    const reply = await service('state');
    return reply?.value?.identity ?? null;
  }
  function retirePhysics() {
    hooks.invalidateInteraction();
    const wasRunning = runtime?.running;
    // Dispatch has stopped for the retired revision. Its accepted point keeps its
    // original identity and can never become the new revision's current result.
    if (runtime) runtime = { ...runtime, running: false };
    physicsInvalidated = runtime !== null || physicsInvalidated;
    runtimeError = '';
    hooks.clearExportStatus();
    recordCapture = null;
    window.clearTimeout(pollTimer);
    if (wasRunning)
      void enqueue(async () => {
        await service('pause');
        hooks.render();
      });
  }
  function stopPolling(): void {
    window.clearTimeout(pollTimer);
  }
  async function startControllers(): Promise<void> {
    await enqueue(async () => {
      hooks.clearDiagnostics();
      if (canRecover()) {
        hooks.toast('请先恢复到最后有效点，再选择启动自动控制。');
        return;
      }
      if (!runtime || runtime.status !== 'ready' || runtime.identity?.physicsRevision !== hooks.physicsRevision()) {
        if (!(await initialize())) return;
      }
      await service('sequence-start', { project: hooks.document() });
      startPolling();
    });
  }
  async function controllerAction(action: 'pause' | 'sequence-resume' | 'sequence-stop'): Promise<void> {
    await enqueue(async () => {
      if (!runtime?.sequence) return;
      if (action === 'pause') await service(action);
      else await service(action, { sequenceRunId: runtime.sequence.runId });
      if (runtime?.running) startPolling();
      else {
        stopPolling();
        await refreshRecords();
      }
    });
  }
  async function captureTools(): Promise<Result<NetworkRuntimeView | null>> {
    if (
      !runtime ||
      runtime.status !== 'ready' ||
      runtime.documentSessionId !== hooks.sessionId() ||
      runtime.physicsRevision !== hooks.physicsRevision()
    )
      return { ok: true, value: null };
    const reply = await service('capture');
    return (
      reply ?? { ok: false, diagnostics: [diagnostic('CAPTURE_RETIRED', '/tools', '运行捕获未完成，请重新读取。')] }
    );
  }
  function toolRecords(
    expected: NetworkIdentity,
    selection: { simulationSessionId: string | null; offset: number; limit: number },
    kind: 'samples' | 'controls',
  ): Promise<Result<unknown>> {
    return transport.requestRecords({
      version: 2,
      clientSequence: ++requestSequence,
      action: kind === 'samples' ? 'records' : 'control-records',
      expected,
      selection,
    });
  }
  function reset(): void {
    stopPolling();
    runtime = null;
    manualRecoverySession = null;
    notifiedRun = null;
    hooks.lowPressureChanged?.(null);
    runtimeError = '';
    physicsInvalidated = false;
    recordCapture = null;
    firstCurvePending = false;
    pendingInitialization = null;
  }
  return {
    get initializationProgress() {
      return initializing() ? pendingInitialization : null;
    },
    reportInitialization(sequence: number, percent: number, stage: string) {
      const pending = pendingInitialization;
      if (
        !pending ||
        !initializing() ||
        sequence !== pending.sequence ||
        !Number.isInteger(percent) ||
        percent < pending.percent ||
        percent >= 100
      )
        return;
      pending.percent = percent;
      pending.stage = stage;
      hooks.renderFeedback();
    },
    get initializing(): boolean {
      return initializing();
    },
    enqueue,
    service,
    initialize,
    operateSimulation,
    operateLimited,
    pauseLimited,
    recover,
    canRecover,
    sendControl,
    applyControl,
    dispatchControl,
    refreshRecords,
    stateForCapture,
    retirePhysics,
    reset,
    stopPolling,
    startControllers,
    controllerAction,
    captureTools,
    toolRecords,
    get runtime() {
      return runtime;
    },
    get error() {
      return runtimeError;
    },
    get invalidated() {
      return physicsInvalidated;
    },
    get capture() {
      return recordCapture;
    },
    get pendingOperations() {
      return pendingOperations;
    },
  };
}

export type NetworkRuntime = ReturnType<typeof createNetworkRuntime>;
