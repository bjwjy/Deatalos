import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export class NativeFault extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** Proof from the transport owner: failed acquisition has completed native shutdown and logging. */
export class NativeAcquisitionFailure extends NativeFault {
  readonly resourcesReleased = true;
}
export class NativeRejection extends NativeFault {
  constructor(
    readonly reason: string,
    readonly details: readonly string[],
  ) {
    super('BACKEND_REJECTED', '原生操作被拒绝：' + reason);
  }
}
export interface NativeTransport {
  readonly pid: number | undefined;
  command(command: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
export interface NativeLaunch {
  readonly executable: string;
  readonly library: string;
  readonly runtime: string;
  readonly directory: string;
  readonly timeoutMs: number;
  readonly extraLibraries?: readonly string[];
}
/** Private trusted transport. Only compiler-generated commands may reach it. */
export class NativeChannel implements NativeTransport {
  readonly child: ChildProcessWithoutNullStreams;
  #pending: { resolve(value: unknown): void; reject(error: Error): void } | null = null;
  #lines: unknown[] = [];
  #failure: NativeFault | null = null;
  #closing: Promise<void> | null = null;
  #exited: Promise<void>;
  #bytes = 0;
  #truncated = false;
  #logWrite: Promise<void> = Promise.resolve();
  #logFile: FileHandle | null = null;
  private constructor(readonly launch: NativeLaunch) {
    this.child = spawn(launch.executable, [launch.library, ...(launch.extraLibraries ?? [])], {
      cwd: launch.directory,
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        WINDIR: process.env.WINDIR ?? 'C:\\Windows',
        PATH:
          path.join(launch.runtime, 'bin') +
          path.delimiter +
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
        TEMP: launch.directory,
        TMP: launch.directory,
      },
    });
    const reader = createInterface({ input: this.child.stdout });
    reader.on('line', (line) => {
      if (line.length > 65536) {
        this.#fail(new NativeFault('BACKEND_PROTOCOL', '原生响应超出预算。'));
        return;
      }
      try {
        const value: unknown = JSON.parse(line),
          pending = this.#pending;
        if (pending) {
          this.#pending = null;
          pending.resolve(value);
        } else if (this.#lines.length < 2) this.#lines.push(value);
        else this.#fail(new NativeFault('BACKEND_PROTOCOL', '原生返回未请求的数据。'));
      } catch {
        this.#fail(new NativeFault('BACKEND_PROTOCOL', '原生响应不是合法JSON。'));
      }
    });
    this.child.stdin.on('error', () => this.#fail(new NativeFault('BACKEND_EXITED', '原生输入通道已关闭。')));
    this.child.on('error', (cause) => this.#fail(new NativeFault('BACKEND_LOAD_FAILED', String(cause).slice(0, 200))));
    this.#exited = new Promise((resolve) =>
      this.child.once('close', (code) => {
        reader.close();
        this.#fail(new NativeFault('BACKEND_EXITED', '原生进程已退出：' + code));
        resolve();
      }),
    );
    this.child.stderr.on('data', (bytes) => {
      void this.#log({ stderr: String(bytes).slice(0, 4000) }).catch(() =>
        this.#fail(new NativeFault('SESSION_LOG_FAILED', '会话日志写入失败。')),
      );
    });
  }
  get pid(): number | undefined {
    return this.child.pid;
  }
  static async open(launch: NativeLaunch): Promise<NativeChannel> {
    const channel = new NativeChannel(launch);
    try {
      const ready = await channel.#receive();
      await channel.#log({ ready, pid: channel.pid });
      if (
        !ready ||
        typeof ready !== 'object' ||
        !('ready' in ready) ||
        ready.ready !== true ||
        !('core' in ready) ||
        ready.core !== '2.24.4.20260918.1254' ||
        !('is64bit' in ready) ||
        ready.is64bit !== true
      )
        throw new NativeFault('BACKEND_VERSION', '原生版本/位数/启动应答不符合固定资源。');
      return channel;
    } catch (cause) {
      try {
        await channel.close();
      } catch {
        throw new NativeFault('BACKEND_CLEANUP_FAILED', '原生启动失败，退出或释放证据未能确认；历史目录必须保留。');
      }
      const code = cause instanceof NativeFault && cause.code !== 'BACKEND_EXITED' ? cause.code : 'BACKEND_LOAD_FAILED';
      throw new NativeAcquisitionFailure(
        code,
        cause instanceof NativeFault ? cause.message : '原生启动未完成，资源已释放。',
      );
    }
  }
  async #log(value: unknown): Promise<void> {
    const line = JSON.stringify(value) + '\n';
    this.#bytes += Buffer.byteLength(line);
    let content = this.#bytes <= 10 * 1024 * 1024 ? line : '';
    if (!content && !this.#truncated) {
      this.#truncated = true;
      content = '{"truncated":true}\n';
    }
    // Release evidence is last: wait for already queued stderr/command records before confirming close.
    if (content)
      this.#logWrite = this.#logWrite.then(async () => {
        this.#logFile ??= await open(path.join(this.launch.directory, 'native.jsonl'), 'a');
        await this.#logFile.appendFile(content);
      });
    await this.#logWrite;
  }
  #fail(error: NativeFault): void {
    this.#failure ??= error;
    const pending = this.#pending;
    this.#pending = null;
    pending?.reject(this.#failure);
  }
  async #receive(): Promise<unknown> {
    if (this.#failure) throw this.#failure;
    if (this.#lines.length) return this.#lines.shift();
    if (this.#pending) throw new NativeFault('BACKEND_BUSY', '禁止并发读取同一原生通道。');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.#pending = { resolve, reject };
        timer = setTimeout(
          () => this.#fail(new NativeFault('BACKEND_TIMEOUT', '原生操作超时，结果失效，不自动重试。')),
          this.launch.timeoutMs,
        );
      });
    } finally {
      clearTimeout(timer);
    }
  }
  async command(command: string): Promise<Record<string, unknown>> {
    if (this.#closing || this.#failure) throw this.#failure ?? new NativeFault('BACKEND_CLOSED', '原生通道已释放。');
    // No renderer text enters this interface; still reject line injection and oversized generated commands.
    if (/[\r\n]/.test(command) || command.length > 2000) throw new NativeFault('BACKEND_PROTOCOL', '内部命令无效。');
    await this.#log({ dispatch: command });
    const response = this.#receive();
    this.child.stdin.write(command + '\n');
    const value = await response;
    await this.#log({ command, response: value });
    if (
      value &&
      typeof value === 'object' &&
      'ok' in value &&
      value.ok === false &&
      'error' in value &&
      typeof value.error === 'string' &&
      value.error.length > 0 &&
      value.error.length <= 120
    ) {
      const details: unknown = 'details' in value ? value.details : [];
      if (
        !Array.isArray(details) ||
        details.length > 8 ||
        !details.every((detail: unknown): detail is string => typeof detail === 'string' && detail.length <= 512)
      )
        throw new NativeFault('BACKEND_PROTOCOL', '内核返回的故障详情格式无效。');
      throw new NativeRejection(value.error, details);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('ok' in value) || value.ok !== true)
      throw new NativeFault('BACKEND_REJECTED', '原生操作被拒绝：' + JSON.stringify(value).slice(0, 200));
    // Shape is refined here; numeric payload members are checked by their consumers.
    return value as Record<string, unknown>;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      this.#fail(new NativeFault('BACKEND_CANCELLED', '原生运行已取消/释放。'));
      this.child.stdin.end('quit\n');
      const timer = setTimeout(() => this.child.kill(), Math.min(1000, this.launch.timeoutMs));
      await this.#exited;
      clearTimeout(timer);
      try {
        await this.#log({ released: true, pid: this.pid });
      } finally {
        // Child close means stdout/stderr have drained. Release evidence stays
        // last; the owned handle closes even when a queued append failed.
        const log = this.#logFile;
        this.#logFile = null;
        if (log) await log.close();
      }
    })();
    return this.#closing;
  }
}
