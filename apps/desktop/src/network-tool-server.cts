import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { matchesToolTarget, type NetworkToolTarget } from './network-tool-target.cjs';
import type { Result } from '@hyd/domain' with { 'resolution-mode': 'import' };
import type { NetworkToolRequest } from '@hyd/application' with { 'resolution-mode': 'import' };

const failure = (code: string, message: string) => ({
  ok: false as const,
  diagnostics: [
    {
      code,
      field: '/tools',
      severity: 'error' as const,
      message,
      suggestion: '保留工程，检查接口状态或重新读取后预览。',
    },
  ],
});
export interface ToolServerCredentials {
  readonly endpoint: string;
  readonly token: string;
  readonly connectionId: string;
}
type Dispatch = (request: NetworkToolRequest, connectionId: string, signal: AbortSignal) => Promise<Result<unknown>>;
/** Opt-in loopback adapter. No upstream client, filesystem credential store, URL-selected resources or scripts. */
export class NetworkToolServer {
  #server: Server | null = null;
  #credentials: ToolServerCredentials | null = null;
  #generation = 0;
  #inflight = 0;
  #starting = false;
  readonly #sockets = new Set<Socket>();
  readonly #requests = new Set<AbortController>();
  constructor(
    readonly dispatch: Dispatch,
    readonly onFailure: () => void = () => {},
    readonly target: () => NetworkToolTarget | null = () => null,
  ) {}
  async start(): Promise<Result<ToolServerCredentials>> {
    if (this.#credentials) return { ok: true, value: this.#credentials };
    if (this.#starting) return failure('TOOL_BUSY', '接口正在启用。');
    this.#starting = true;
    const generation = ++this.#generation,
      token = randomBytes(32).toString('hex'),
      connectionId = 'tools_' + randomUUID().replaceAll('-', '').slice(0, 30);
    const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      void this.#handle(request, response, generation);
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 5000;
    server.keepAliveTimeout = 1000;
    server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    });
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      if (generation !== this.#generation) {
        server.closeAllConnections();
        server.close();
        return failure('TOOL_RETIRED', '启用过程已取消。');
      }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Loopback address unavailable');
      this.#credentials = Object.freeze({ endpoint: `http://127.0.0.1:${address.port}/tools`, token, connectionId });
      server.on('error', () => {
        void this.stop().then(() => this.onFailure());
      });
      return { ok: true, value: this.#credentials };
    } catch {
      if (this.#server === server) this.#server = null;
      server.closeAllConnections();
      server.close();
      return failure('TOOL_START_FAILED', '本机工具监听失败，接口保持关闭。');
    } finally {
      this.#starting = false;
    }
  }
  async stop(): Promise<void> {
    ++this.#generation;
    this.#credentials = null;
    for (const request of this.#requests) request.abort();
    this.#requests.clear();
    const server = this.#server;
    this.#server = null;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  async #handle(request: IncomingMessage, response: ServerResponse, generation: number): Promise<void> {
    let verifiedTarget: NetworkToolTarget | null = null;
    const send = (status: number, value: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      let text: string;
      try {
        text = JSON.stringify(value);
      } catch {
        text = JSON.stringify(failure('PROTOCOL_INVALID', '响应不能序列化。'));
        status = 500;
      }
      if (Buffer.byteLength(text) > 4194304) {
        text = JSON.stringify(failure('PAYLOAD_LIMIT', '响应超过4 MB，请缩小读取范围。'));
        status = 413;
      }
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        connection: 'close',
        ...(verifiedTarget && this.#credentials ? { 'x-hydraulic-connection': this.#credentials.connectionId } : {}),
      });
      response.end(text);
    };
    const credentials = this.#credentials;
    if (!credentials || generation !== this.#generation) {
      send(503, failure('TOOL_DISABLED', '接口已关闭。'));
      return;
    }
    const expectedHost = new URL(credentials.endpoint).host;
    if (
      request.socket.remoteAddress !== '127.0.0.1' ||
      request.headers.host !== expectedHost ||
      request.headers.origin !== undefined
    ) {
      send(403, failure('TOOL_ORIGIN_DENIED', '仅接受带明确授权的本机工具程序。'));
      return;
    }
    const authorization = request.headers.authorization,
      expected = 'Bearer ' + credentials.token;
    if (
      typeof authorization !== 'string' ||
      Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
    ) {
      send(401, failure('TOOL_UNAUTHORIZED', '需要本次启用后显示的会话令牌。'));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/tools') {
      send(404, failure('TOOL_METHOD_INVALID', '只提供 POST /tools，不提供URL路径能力。'));
      return;
    }
    const targetHeader = request.headers['x-hydraulic-target'];
    if (targetHeader !== undefined) {
      let input: unknown;
      try {
        if (typeof targetHeader !== 'string' || targetHeader.length > 6000 || !/^[A-Za-z0-9+/]+=*$/.test(targetHeader))
          throw new Error('Target header invalid');
        input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(targetHeader, 'base64')));
      } catch {
        send(400, failure('TARGET_INVALID', '目标工程身份无效，未处理请求。'));
        return;
      }
      const target = this.target();
      if (!matchesToolTarget(input, target, credentials.connectionId)) {
        send(409, failure('TARGET_MISMATCH', '连接不属于所选工程，请在目标窗口重新开启AI；未向其他实例重发。'));
        return;
      }
      verifiedTarget = target;
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
      send(415, failure('PROTOCOL_INVALID', '请求须为UTF-8 application/json。'));
      return;
    }
    if (this.#inflight >= 4) {
      send(429, failure('TOOL_BUSY', '最多四个待处理工具请求。'));
      return;
    }
    this.#inflight++;
    const abort = new AbortController();
    this.#requests.add(abort);
    const disconnected = () => {
      if (!response.writableEnded) abort.abort();
    };
    response.once('close', disconnected);
    const timer = setTimeout(() => {
      abort.abort();
      send(408, failure('TOOL_TIMEOUT', '工具请求超时，迟到返回已退役。'));
    }, 10000);
    try {
      let size = 0;
      const parts: Buffer[] = [];
      for await (const part of request) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
        size += bytes.length;
        if (size > 1048576) {
          abort.abort();
          send(413, failure('PAYLOAD_LIMIT', '工具请求超过1 MB。'));
          return;
        }
        parts.push(bytes);
      }
      if (abort.signal.aborted || generation !== this.#generation) return;
      if (verifiedTarget && JSON.stringify(this.target()) !== JSON.stringify(verifiedTarget)) {
        send(409, failure('TARGET_RETIRED', '工程文件会话已改变，旧请求未提交。'));
        return;
      }
      let input: unknown;
      try {
        input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
      } catch {
        send(400, failure('PROTOCOL_INVALID', '请求不是有效UTF-8 JSON。'));
        return;
      }
      const { parseNetworkToolRequest, parseServiceResult } = await import('@hyd/application');
      const parsed = parseNetworkToolRequest(input);
      if (!parsed.ok) {
        send(400, parsed);
        return;
      }
      if ((parsed.value.method === 'simulate' || parsed.value.method === 'export_batch_prepare') && !verifiedTarget) {
        send(403, failure('TARGET_REQUIRED', '此操作需要核验已保存的目标工程。'));
        return;
      }
      let onAbort: () => void = () => {};
      const cancelled = new Promise<Result<unknown>>((resolve) => {
        onAbort = () => resolve(failure('TOOL_RETIRED', '请求已失联或退役。'));
        if (abort.signal.aborted) onAbort();
        else abort.signal.addEventListener('abort', onAbort, { once: true });
      });
      let reply: Result<unknown>;
      try {
        reply = await Promise.race([this.dispatch(parsed.value, credentials.connectionId, abort.signal), cancelled]);
      } finally {
        abort.signal.removeEventListener('abort', onAbort);
      }
      if (abort.signal.aborted || generation !== this.#generation) return;
      if (verifiedTarget && JSON.stringify(this.target()) !== JSON.stringify(verifiedTarget)) {
        send(409, failure('TARGET_RETIRED', '工程文件会话已改变，请重新捕获。'));
        return;
      }
      const checked = parseServiceResult(reply);
      const envelope = { protocol: 'HydraulicTools', version: 1, requestId: parsed.value.requestId, ...checked };
      if (Buffer.byteLength(JSON.stringify(envelope)) > 4194304) {
        abort.abort();
        send(413, failure('PAYLOAD_LIMIT', '响应超过4 MB，请缩小读取范围。'));
        return;
      }
      send(200, envelope);
    } catch {
      if (!abort.signal.aborted)
        send(500, failure('TOOL_TRANSPORT_FAILED', '本机请求失联或处理失败；未绕过确认修改工程。'));
      abort.abort();
    } finally {
      clearTimeout(timer);
      response.removeListener('close', disconnected);
      this.#requests.delete(abort);
      this.#inflight--;
    }
  }
}
