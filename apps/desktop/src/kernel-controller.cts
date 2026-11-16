import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import type { KernelServiceRequest } from '@hyd/application' with { 'resolution-mode': 'import' };

const fail = (code: string, message: string) => ({
  ok: false,
  diagnostics: [
    { code, field: '/kernel', severity: 'error', message, suggestion: '保留工程及显式历史，检查后重新初始化。' },
  ],
});
interface Waiter {
  resolve(value: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}
interface Slot {
  readonly child: UtilityProcess;
  readonly pending: Map<number, Waiter>;
  nativePid: number | undefined;
  exited: boolean;
  close: Promise<void> | null;
}
/** Main-process composition only. Renderer cannot select resources, commands or files. */
export class KernelController {
  #slot: Slot | null = null;
  readonly #candidates = new Set<Slot>();
  #candidateSequence = 0;
  #generation = 0;
  #clientSequence = 0;
  #messageSequence = 0;
  #latestMutation = 0;
  #closing = false;
  constructor(
    readonly moduleDirectory: string,
    readonly resourceRoot: string,
    readonly sessionsRoot: string,
  ) {}
  async request(input: unknown): Promise<unknown> {
    if (this.#closing) return fail('RUNTIME_CLOSED', '应用正在关闭。');
    const context = this.#generation;
    let length: number;
    try {
      length = Buffer.byteLength(JSON.stringify(input) ?? '');
    } catch {
      return fail('PROTOCOL_INVALID', '运行请求不是安全JSON。');
    }
    if (length > 2_100_000) return fail('PAYLOAD_LIMIT', '运行请求超过2.1MB。');
    const { parseKernelServiceRequest } = await import('@hyd/application');
    const parsed = parseKernelServiceRequest(input);
    if (!parsed.ok) return parsed;
    if (context !== this.#generation || this.#closing) return fail('RESPONSE_STALE', '请求所属上下文已退役。');
    const request: KernelServiceRequest = parsed.value;
    if (request.clientSequence <= this.#clientSequence) return fail('RESPONSE_STALE', '重复或逆序请求未执行。');
    this.#clientSequence = request.clientSequence;
    const readOnly =
      request.action === 'state' ||
      request.action === 'records' ||
      request.action === 'capture' ||
      request.action === 'control-records';
    if (!readOnly) this.#latestMutation = request.clientSequence;
    if (request.action === 'initialize') {
      return this.#initialize(request);
    }
    // An explicit operation on the accepted runtime supersedes pending replacement intent.
    if (!readOnly) this.#cancelCandidates();
    const slot = this.#slot,
      generation = this.#generation;
    if (!slot) return fail('RUNTIME_NOT_READY', '尚未初始化或运行已销毁。');
    const result = await this.#send(slot, { request });
    if (generation !== this.#generation || this.#closing || request.clientSequence < this.#latestMutation)
      return fail('RESPONSE_STALE', '旧工程或旧控制响应失效，未作为当前结果返回。');
    return result;
  }
  async #initialize(request: KernelServiceRequest): Promise<unknown> {
    this.#cancelCandidates();
    const candidateSequence = this.#candidateSequence,
      generation = this.#generation;
    this.suspend();
    const candidate = this.#spawn();
    this.#candidates.add(candidate);
    let committed = false;
    try {
      const result = await this.#send(candidate, { request });
      if (generation !== this.#generation || candidateSequence !== this.#candidateSequence || this.#closing)
        return fail('RESPONSE_STALE', '初始化候选已取消或所属工程已退役。');
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) return result;
      // The accepted slot remains readable until the isolated candidate has a real valid point.
      const old = this.#slot;
      this.#slot = candidate;
      committed = true;
      this.#candidates.delete(candidate);
      const acceptedGeneration = ++this.#generation;
      if (old) await this.#stop(old);
      if (
        acceptedGeneration !== this.#generation ||
        candidateSequence !== this.#candidateSequence ||
        this.#closing ||
        request.clientSequence < this.#latestMutation
      )
        return fail('RESPONSE_STALE', '候选提交后的响应已被新操作取代。');
      return result;
    } finally {
      if (!committed) await this.#stop(candidate);
      this.#candidates.delete(candidate);
    }
  }
  #cancelCandidates(): void {
    this.#candidateSequence++;
    for (const candidate of this.#candidates) void this.#stop(candidate);
  }
  #spawn(): Slot {
    const child = utilityProcess.fork(
      path.join(this.moduleDirectory, 'kernel-worker.cjs'),
      [this.resourceRoot, this.sessionsRoot],
      {
        serviceName: '液压内核运行服务',
        stdio: 'pipe',
        env: {
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          WINDIR: process.env.WINDIR ?? 'C:\\Windows',
          PATH: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
        },
      },
    );
    const slot: Slot = { child, pending: new Map(), nativePid: undefined, exited: false, close: null };
    child.stdout?.on('data', () => {
      /* No application protocol is read from stdout. */
    });
    child.stderr?.on('data', (bytes) => console.error('Kernel worker:', String(bytes).slice(0, 1000)));
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      if (
        'event' in message &&
        'pid' in message &&
        typeof message.pid === 'number' &&
        Number.isSafeInteger(message.pid)
      ) {
        if (message.event === 'native-started') slot.nativePid = message.pid;
        if (message.event === 'native-exited' && slot.nativePid === message.pid) slot.nativePid = undefined;
      }
      if ('id' in message && typeof message.id === 'number') {
        const pending = slot.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          slot.pending.delete(message.id);
          pending.resolve('result' in message ? message.result : message);
        }
      }
    });
    child.once('exit', () => {
      slot.exited = true;
      this.#killNative(slot);
      for (const pending of slot.pending.values()) {
        clearTimeout(pending.timer);
        pending.resolve(fail('BACKEND_EXITED', '运行服务意外退出，当前结果失效。'));
      }
      slot.pending.clear();
    });
    return slot;
  }
  #send(slot: Slot, payload: Record<string, unknown>): Promise<unknown> {
    if (slot.exited) return Promise.resolve(fail('BACKEND_EXITED', '运行服务已退出。'));
    const id = ++this.#messageSequence;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        slot.pending.delete(id);
        this.#killNative(slot);
        slot.child.kill();
        resolve(fail('BACKEND_TIMEOUT', '运行服务超时，已终止并使结果失效，不自动重试。'));
      }, 12000);
      slot.pending.set(id, { resolve, timer });
      slot.child.postMessage({ id, ...payload });
    });
  }
  suspend(): void {
    this.#slot?.child.postMessage({ id: ++this.#messageSequence, pauseScheduling: true });
  }
  #killNative(slot: Slot): void {
    const pid = slot.nativePid;
    slot.nativePid = undefined;
    if (pid !== undefined) {
      try {
        process.kill(pid);
      } catch (cause: unknown) {
        if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ESRCH'))
          console.error('Native cleanup failed:', cause);
      }
    }
  }
  #stop(slot: Slot): Promise<void> {
    if (slot.close) return slot.close;
    slot.close = (async () => {
      if (!slot.exited) await this.#send(slot, { shutdown: true });
      // The worker waits for native close before acknowledging shutdown.
      this.#killNative(slot);
      if (!slot.exited) slot.child.kill();
    })();
    return slot.close;
  }
  async invalidate(): Promise<void> {
    this.#generation++;
    this.#candidateSequence++;
    const slots = [...this.#candidates];
    if (this.#slot) slots.push(this.#slot);
    this.#slot = null;
    await Promise.all(slots.map((slot) => this.#stop(slot)));
  }
  async close(): Promise<void> {
    this.#closing = true;
    await this.invalidate();
  }
}
