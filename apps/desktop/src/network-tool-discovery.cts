import { unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { atomicWrite, codeOf, fingerprint, digest, FileFailure } from './atomic-file.cjs';
import type { NetworkToolTarget } from './network-tool-target.cjs';
import type { NetworkToolServer, ToolServerCredentials } from './network-tool-server.cjs';
import type { Result } from '@hyd/domain' with { 'resolution-mode': 'import' };

export interface DiscoveredToolConnection extends ToolServerCredentials {
  readonly discoveryPath: string;
}
const fail = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [
    {
      code,
      field: '/tools',
      severity: 'error',
      message,
      suggestion: '接口保持关闭；检查配套Windows客户端、当前账户及连接目录后重试，不修改全局脚本策略。',
    },
  ],
});
/** DPAPI defaults to the current Windows user. Token is stdin only, never a shell argument. */
export function protectToolToken(token: string): Promise<string> {
  if (process.platform !== 'win32' || !/^[a-f0-9]{64}$/.test(token))
    return Promise.reject(new Error('TOOL_PROTECTION_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    // Packaged executables must be outside ASAR; source builds keep the same relative path.
    const nativeDirectory = __dirname.replace(
      `${path.sep}app.asar${path.sep}`,
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
    const child = spawn(path.join(nativeDirectory, 'agent/HydraulicTool.exe'), ['--protect'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      settled = false;
    const finish = (value: string | null, code = 'TOOL_TOKEN_PROTECTION_FAILED') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value === null) reject(new FileFailure(code, '本机凭证保护未完成。'));
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null, 'TOOL_CLIENT_TIMEOUT');
    }, 8000);
    child.stdout.on('data', (bytes) => {
      output += bytes;
      if (output.length > 8192) {
        child.kill();
        finish(null);
      }
    });
    child.stderr.resume();
    child.once('error', (cause: unknown) =>
      finish(null, codeOf(cause) === 'ENOENT' ? 'TOOL_CLIENT_MISSING' : 'TOOL_CLIENT_START_FAILED'),
    );
    child.stdin.on('error', () => finish(null));
    child.once('close', (code) =>
      finish(code === 0 && /^[a-f0-9]{100,8192}$/i.test(output.trim()) ? output.trim() : null),
    );
    child.stdin.end(token);
  });
}

/** Owns discovery publication and retirement; server still owns authentication/transport. */
export class NetworkToolDiscovery {
  readonly file: string;
  readonly registryFile: string | null;
  #generation = 0;
  #active: DiscoveredToolConnection | null = null;
  #pending: Promise<Result<DiscoveredToolConnection>> | null = null;
  #stopping: Promise<Result<true>> | null = null;
  constructor(
    readonly server: Pick<NetworkToolServer, 'start' | 'stop'>,
    directory: string,
    readonly protect: (token: string) => Promise<string> = protectToolToken,
    readonly options?: { readonly registryDirectory: string; readonly target: () => NetworkToolTarget | null },
  ) {
    this.file = path.join(directory, 'ai-connection.json');
    this.registryFile = options
      ? path.join(options.registryDirectory, digest(path.resolve(directory).toLowerCase()).slice(0, 32) + '.json')
      : null;
  }
  async #remove(): Promise<void> {
    await unlink(this.file).catch((cause: unknown) => {
      if (codeOf(cause) !== 'ENOENT') throw cause;
    });
    if (this.registryFile)
      await unlink(this.registryFile).catch((cause: unknown) => {
        if (codeOf(cause) !== 'ENOENT') throw cause;
      });
  }
  async initialize(): Promise<Result<true>> {
    try {
      await this.#remove();
      return { ok: true, value: true };
    } catch {
      return fail('TOOL_DISCOVERY_CLEANUP_FAILED', '残留发现信息未能清理；接口保持关闭。');
    }
  }
  async start(): Promise<Result<DiscoveredToolConnection>> {
    if (this.#stopping || this.#pending) return fail('TOOL_BUSY', 'AI接口正在切换，请稍后重试。');
    if (this.#active) return { ok: true, value: this.#active };
    const generation = ++this.#generation;
    const pending = this.#enable(generation);
    this.#pending = pending;
    try {
      return await pending;
    } finally {
      if (this.#pending === pending) this.#pending = null;
    }
  }
  async #enable(generation: number): Promise<Result<DiscoveredToolConnection>> {
    try {
      await this.#remove();
      if (generation !== this.#generation) return fail('TOOL_RETIRED', '启用已取消。');
      const credentials = await this.server.start();
      if (!credentials.ok) return credentials;
      const protectedToken = await this.protect(credentials.value.token);
      if (!/^[a-f0-9]{100,8192}$/i.test(protectedToken)) throw new Error('TOOL_PROTECTION_INVALID');
      const record = {
        format: 'HydraulicToolsConnection',
        version: 1,
        protection: 'windows-dpapi-current-user',
        endpoint: credentials.value.endpoint,
        connectionId: credentials.value.connectionId,
        protectedToken,
      };
      await atomicWrite(this.file, Buffer.from(JSON.stringify(record)), null, () => generation === this.#generation);
      const target = this.options?.target();
      if (this.registryFile && target) {
        await atomicWrite(
          this.registryFile,
          Buffer.from(
            JSON.stringify({
              format: 'HydraulicToolsTarget',
              version: 1,
              ...target,
              connectionId: credentials.value.connectionId,
              discoveryPath: this.file,
            }),
          ),
          await fingerprint(this.registryFile),
          () => generation === this.#generation && JSON.stringify(this.options?.target()) === JSON.stringify(target),
        );
      }
      if (generation !== this.#generation) return fail('TOOL_RETIRED', '启用已取消。');
      this.#active = { ...credentials.value, discoveryPath: this.file };
      return { ok: true, value: this.#active };
    } catch (cause) {
      await this.server.stop();
      try {
        await this.#remove();
      } catch {
        return fail('TOOL_DISCOVERY_CLEANUP_FAILED', 'AI接口已关闭，但发现记录未能清理；可重试关闭。');
      }
      return cause instanceof FileFailure
        ? fail(cause.code, 'AI连接未建立：' + cause.message + '接口保持关闭。')
        : fail('TOOL_DISCOVERY_FAILED', 'AI自动接入未能建立，接口保持关闭。');
    }
  }
  async stop(): Promise<Result<true>> {
    if (this.#stopping) return this.#stopping;
    ++this.#generation;
    this.#active = null;
    const pending = this.#pending;
    const stopping = (async (): Promise<Result<true>> => {
      await this.server.stop();
      await pending;
      await this.server.stop();
      try {
        await this.#remove();
        return { ok: true, value: true };
      } catch {
        return fail('TOOL_DISCOVERY_CLEANUP_FAILED', 'AI接口已关闭，但发现记录未能清理；可重试关闭。');
      }
    })();
    this.#stopping = stopping;
    try {
      return await stopping;
    } finally {
      if (this.#stopping === stopping) this.#stopping = null;
    }
  }
}
