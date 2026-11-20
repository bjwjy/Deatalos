import { randomUUID } from 'node:crypto';
import type { NetworkSimulation as Simulation } from '@hyd/application' with { 'resolution-mode': 'import' };
import type { CylinderCondition, KernelServiceRequest } from '@hyd/application' with { 'resolution-mode': 'import' };
import { HopsanBackend } from './kernel-backend.cjs';
import { NativeChannel } from './native-channel.cjs';
import { KernelRunScheduler } from './kernel-run-scheduler.cjs';

const parent = process.parentPort;
if (!parent) throw new Error('Kernel worker requires a utility-process parent');
const send = (value: unknown) => parent.postMessage(value);
const resources = process.argv[2],
  sessions = process.argv[3];
if (!resources || !sessions) throw new Error('Missing trusted resource roots');
let runtime: Simulation | null = null;
let backend: HopsanBackend | null = null;
let retiring = false;
let queue: Promise<void> = Promise.resolve();
let scheduler: KernelRunScheduler | undefined;
let speed = 1,
  sequence = 0;
let boundedTarget: { readonly simulationSessionId: string; readonly tick: number } | undefined;
const failed = (code: string, message: string) => ({
  ok: false,
  diagnostics: [{ code, field: '/kernel', severity: 'error', message, suggestion: '保留工程，检查后重新初始化。' }],
});
const stopTimer = () => {
  scheduler?.stop();
  runtime?.pause();
};
function configureLimit(ticks: number | undefined, condition?: CylinderCondition) {
  if (ticks === undefined) {
    boundedTarget = undefined;
    return runtime?.configureCondition(undefined) ?? failed('RUNTIME_NOT_READY', '尚未初始化。');
  }
  const identity = runtime?.identity;
  if (!identity || !Number.isSafeInteger(identity.tick + ticks))
    return failed('CLOCK_INVALID', '有限运行目标步号不可表示，未启动。');
  boundedTarget = { simulationSessionId: identity.simulationSessionId, tick: identity.tick + ticks };
  return runtime?.configureCondition(condition, ticks) ?? failed('RUNTIME_NOT_READY', '尚未初始化。');
}
function startTimer(): void {
  if (!runtime) return;
  const target = runtime;
  scheduler = new KernelRunScheduler(target, (cause) => {
    stopTimer();
    if (cause !== undefined) void target.dispose();
  });
  const limit = boundedTarget;
  scheduler.start(
    speed,
    limit
      ? {
          targetTick: limit.tick,
          tick: () => {
            const identity = target.identity;
            return identity?.simulationSessionId === limit.simulationSessionId ? identity.tick : null;
          },
        }
      : undefined,
  );
}
function openBackend(
  project: unknown,
  mapping: Parameters<typeof HopsanBackend.create>[1],
  expectedResourceDigest?: string,
  onInitializationProgress?: (percent: number, stage: string) => void,
) {
  return HopsanBackend.create(
    project,
    mapping,
    {
      resourceRoot: resources ?? '',
      sessionsRoot: sessions ?? '',
      timeoutMs: 5000,
      ...(onInitializationProgress ? { onInitializationProgress } : {}),
      ...(expectedResourceDigest === undefined ? {} : { expectedResourceDigest }),
    },
    async (launch) => {
      const channel = await NativeChannel.open(launch);
      send({ event: 'native-started', pid: channel.pid });
      channel.child.once('exit', () => send({ event: 'native-exited', pid: channel.pid }));
      return channel;
    },
  );
}
async function handle(input: unknown): Promise<unknown> {
  const { parseKernelServiceRequest, NetworkSimulation, networkRuntimeReference } = await import('@hyd/application');
  const checked = parseKernelServiceRequest(input);
  if (!checked.ok) return checked;
  const request: KernelServiceRequest = checked.value;
  if (request.clientSequence <= sequence) return failed('RESPONSE_STALE', '重复或逆序客户端请求，未重发控制。');
  sequence = request.clientSequence;
  if (retiring) return failed('RESPONSE_STALE', '运行上下文已退役。');
  if (request.action === 'initialize') {
    stopTimer();
    if (!request.mapping || !request.documentSessionId || request.physicsRevision === undefined)
      return failed('PROTOCOL_INVALID', '初始化数据缺失。');
    let candidate: Simulation | null = null;
    let candidateBackend: HopsanBackend | null = null;
    let committed = false;
    try {
      const created = await openBackend(request.project, request.mapping, undefined, (percent, stage) => {
        send({ event: 'initialization-progress', percent, stage });
      });
      if (!created.ok) return created;
      candidateBackend = created.value;
      const store = NetworkSimulation.create(
        request.project,
        request.documentSessionId,
        randomUUID(),
        request.physicsRevision,
        candidateBackend,
        request.mapping.nativeStepS,
      );
      if (!store.ok) return store;
      candidate = store.value;
      const initialized = await candidate.initialize();
      if (!initialized.ok) return initialized;
      if (retiring) return failed('RESPONSE_STALE', '候选初始化期间上下文已退役。');
      await runtime?.dispose();
      if (retiring) return failed('RESPONSE_STALE', '候选提交期间上下文已退役。');
      runtime = candidate;
      backend = candidateBackend;
      committed = true;
      return {
        ok: true,
        value: serviceSnapshot(runtime, request.version),
        approximations: candidateBackend.plan.approximations,
      };
    } catch (cause: unknown) {
      return failed('BACKEND_FAILED', '候选初始化失败：' + String(cause).slice(0, 200));
    } finally {
      if (!committed) {
        if (candidate) await candidate.dispose();
        else await candidateBackend?.close();
      }
    }
  }
  if (!runtime) return failed('RUNTIME_NOT_READY', '尚未初始化运行。');
  // Records validate their own exact frozen anchor, which can predate live ticks.
  if (request.action === 'records' && request.selection && request.expected)
    return runtime.records(request.expected, request.selection);
  if (request.action === 'control-records' && request.selection && request.expected)
    return runtime.controlRecords(request.expected, request.selection);
  const expected = request.expected;
  const { identity: current, sequence: sequenceView, flowRegulators } = runtime.snapshot(false);
  const mayObserveAdvancedControl =
    (request.action === 'control' && flowRegulators.length > 0) ||
    ['state', 'capture', 'pause', 'pause-bounded', 'sequence-start'].includes(request.action) ||
    ((request.action === 'sequence-resume' || request.action === 'sequence-stop' || request.action === 'control') &&
      request.sequenceRunId === sequenceView?.runId);
  if (
    !expected ||
    !current ||
    expected.documentSessionId !== current.documentSessionId ||
    expected.physicsRevision !== current.physicsRevision ||
    expected.simulationSessionId !== current.simulationSessionId ||
    (mayObserveAdvancedControl
      ? expected.controlSequence > current.controlSequence
      : expected.controlSequence !== current.controlSequence) ||
    expected.tick > current.tick ||
    expected.requestSequence > current.requestSequence ||
    (request.action === 'recover' &&
      (expected.requestSequence !== current.requestSequence ||
        expected.tick !== current.tick ||
        expected.timeS !== current.timeS))
  )
    return failed('RESPONSE_STALE', '操作目标会话/物理修订/控制序号已过期。');
  if (request.action === 'capture') {
    const captured = runtime.captureRecords();
    if (!captured.ok) return captured;
  }
  if (request.action === 'pause') {
    stopTimer();
    boundedTarget = undefined;
  }
  if (request.action === 'pause-bounded' && boundedTarget) {
    stopTimer();
    boundedTarget = undefined;
  }
  let outcome: unknown = { ok: true, value: true };
  if (request.action === 'recover') {
    const original = backend;
    if (!original) return failed('RECOVERY_UNAVAILABLE', '原生运行配置已失效。');
    stopTimer();
    const deadline = performance.now() + 5500;
    outcome = await runtime.recover(
      () => openBackend(original.project, original.plan.options, original.resourceDigest),
      () => !retiring && performance.now() < deadline,
    );
  }
  if (request.action === 'sequence-start') {
    stopTimer();
    const configured = configureLimit(request.ticks, 'condition' in request ? request.condition : undefined);
    if (!configured.ok) return configured;
    if ('value' in configured && configured.value)
      return { ok: true, value: serviceSnapshot(runtime, request.version) };
    outcome = await runtime.startSequence(request.project, randomUUID());
    speed = 1;
    if (runtime.running) startTimer();
  }
  if (request.action === 'sequence-resume') {
    stopTimer();
    const configured = configureLimit(request.ticks, 'condition' in request ? request.condition : undefined);
    if (!configured.ok) return configured;
    if ('value' in configured && configured.value)
      return { ok: true, value: serviceSnapshot(runtime, request.version) };
    outcome = runtime.resumeSequence(request.sequenceRunId);
    if (runtime.running) startTimer();
  }
  if (request.action === 'sequence-stop') {
    stopTimer();
    outcome = runtime.stopSequence(request.sequenceRunId);
  }
  if (request.action === 'start') {
    stopTimer();
    const configured = configureLimit(
      'ticks' in request ? request.ticks : undefined,
      'condition' in request ? request.condition : undefined,
    );
    if (!configured.ok) return configured;
    if ('value' in configured && configured.value)
      return { ok: true, value: serviceSnapshot(runtime, request.version) };
    speed = request.speed;
    const started = runtime.start();
    outcome = started;
    if (started.ok) startTimer();
  }
  if (request.action === 'step') {
    stopTimer();
    outcome = await runtime.singleStep();
  }
  if (request.action === 'control') {
    if (request.version === 1) {
      const { parseNetworkControlBatch } = await import('@hyd/domain');
      const legacy = parseNetworkControlBatch(runtime.document, request.controls);
      if (!legacy.ok) return legacy;
      outcome = await runtime.control(legacy.value);
    } else outcome = await runtime.control(request.controls);
  }
  if (request.action === 'reset') {
    stopTimer();
    outcome = await runtime.reset(randomUUID());
  }
  if (request.action === 'release') {
    stopTimer();
    outcome = await runtime.dispose();
  }
  if (outcome && typeof outcome === 'object' && 'ok' in outcome && outcome.ok === false) {
    if ('condition' in request && request.condition) runtime.pause();
    return outcome;
  }
  const snapshot = serviceSnapshot(runtime, request.version);
  return {
    ok: true,
    value: request.action === 'state' && 'view' in request ? networkRuntimeReference(snapshot) : snapshot,
  };
}
function serviceSnapshot(simulation: Simulation, version: 1 | 2) {
  const state = simulation.snapshot(version === 1);
  if (version === 2) return state;
  const { flowRegulators: _regulators, ...legacy } = state;
  return legacy;
}
parent.on('message', (event) => {
  const message: unknown = event.data;
  if (!message || typeof message !== 'object' || !('id' in message)) return;
  const id = message.id;
  if ('pauseScheduling' in message) {
    stopTimer();
    return;
  }
  if ('shutdown' in message) {
    retiring = true;
    stopTimer();
    queue = queue.then(async () => {
      await scheduler?.drain();
      await runtime?.dispose();
      send({ id, ok: true, shutdown: true });
      process.exit(0);
    });
    return;
  }
  if (!('request' in message)) return;
  // Stop automatic scheduling when a pause/reset/step is received, before queued work drains.
  const r: unknown = message.request;
  if (
    r &&
    typeof r === 'object' &&
    'action' in r &&
    ['pause', 'reset', 'release', 'step', 'sequence-stop', 'sequence-resume', 'sequence-start'].includes(
      String(r.action),
    )
  )
    stopTimer();
  queue = queue.then(async () => {
    // Hold dispatch without pausing controller state. A control request and a
    // timer pulse must not race across the asynchronous protocol boundary.
    const holdDispatch = !!r && typeof r === 'object' && 'action' in r && r.action === 'control';
    if (holdDispatch) scheduler?.stop();
    try {
      // One native operation at a time; automatic pulses drain before explicit commands.
      await scheduler?.drain();
      while (runtime?.busy) await new Promise((resolve) => setTimeout(resolve, 1));
      send({ id, result: await handle(r) });
    } catch (cause) {
      stopTimer();
      await runtime?.dispose();
      send({ id, result: failed('BACKEND_FAILED', String(cause).slice(0, 200)) });
    } finally {
      if (holdDispatch && runtime?.running && !retiring) startTimer();
    }
  });
});
send({ event: 'ready' });
