import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NetworkSaveCapture, NetworkToolBase, NetworkToolFileAction } from '@hyd/application' with {
  'resolution-mode': 'import',
};
import type { Result } from '@hyd/domain' with { 'resolution-mode': 'import' };
import type { NetworkSaveReply } from './network-project-files.cjs';

const fail = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [
    { code, field: '/receipts', severity: 'error', message, suggestion: '保留工程并查询实际文件，不要盲目重复操作。' },
  ],
});
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const ttlMs = 15 * 60 * 1000;
type ProjectAction = Extract<NetworkToolFileAction, { kind: 'project' }>;
type ProjectOutcome =
  | { readonly status: 'ok'; readonly projectId: string; readonly path: string; readonly requiresSaveAs: boolean }
  | Exclude<NetworkSaveReply, { status: 'ok' }>;
interface Entry {
  readonly operationId: string;
  readonly connectionId: string;
  readonly base: NetworkToolBase;
  readonly token: string;
  expiresAt: number;
  state: 'awaiting-confirmation' | 'writing' | 'awaiting-adoption' | 'completed' | 'cancelled' | 'stale' | 'failed';
  rendererAcknowledged: boolean;
  requestId?: string;
  outcome?: Omit<Extract<NetworkSaveReply, { status: 'ok' }>, 'content'> | Exclude<NetworkSaveReply, { status: 'ok' }>;
  project?: {
    readonly action: ProjectAction;
    targetSessionId?: string;
    claimed: boolean;
    adopted: boolean | null;
    outcome?: ProjectOutcome;
  };
}
/** Host-owned file receipts. Separate capabilities can only read one bounded outcome, never dispatch tools.
 * No credential or complete project is persisted or included in public status. */
export class NetworkProjectReceipts {
  #entries = new Map<string, Entry>();
  #server: Server | null = null;
  #port = 0;
  #opening: Promise<void> | null = null;
  #generation = 0;
  #expiry: ReturnType<typeof setInterval> | undefined;
  constructor(readonly now: () => number = Date.now) {}
  #prune(): void {
    for (const [id, row] of this.#entries) if (row.expiresAt <= this.now()) this.#entries.delete(id);
  }
  get size(): number {
    this.#prune();
    return this.#entries.size;
  }
  async register(
    connectionId: string,
    base: NetworkToolBase,
    reply: Result<unknown>,
    action?: ProjectAction,
  ): Promise<Result<unknown>> {
    if (!reply.ok || !object(reply.value) || typeof reply.value.operationId !== 'string') return reply;
    const operationId = reply.value.operationId;
    if (!/^[-\w]{1,100}$/.test(operationId)) return fail('RECEIPT_INVALID', '文件操作编号无效。');
    this.#prune();
    let row = this.#entries.get(operationId);
    if (
      row &&
      (row.connectionId !== connectionId ||
        JSON.stringify(row.base) !== JSON.stringify(base) ||
        JSON.stringify(row.project?.action) !== JSON.stringify(action))
    )
      return fail('RECEIPT_CONFLICT', '文件回执身份冲突。');
    if (!row) {
      if (this.#entries.size >= 16) return fail('RECEIPT_LIMIT', '本机尚保留16份操作回执，请稍后继续。');
      row = {
        operationId,
        connectionId,
        base,
        token: randomBytes(32).toString('hex'),
        expiresAt: this.now() + ttlMs,
        state: 'awaiting-confirmation',
        rendererAcknowledged: false,
        ...(action ? { project: { action, claimed: false, adopted: false } } : {}),
      };
      this.#entries.set(operationId, row);
    }
    try {
      await this.#listen();
    } catch {
      this.#entries.delete(operationId);
      return fail('RECEIPT_UNAVAILABLE', '回执查询未建立，另存为未获准执行。');
    }
    if (this.#entries.get(operationId) !== row) return fail('RECEIPT_RETIRED', '回执已随接口关闭退役。');
    return {
      ok: true,
      value: { ...reply.value, receipt: { version: 1, port: this.#port, operationId, token: row.token } },
    };
  }
  phase(input: unknown, activeConnectionId: string | null): boolean {
    if (
      !object(input) ||
      Object.keys(input).sort().join(',') !==
        (input.phase === 'transition' || input.phase === 'adopted'
          ? 'operationId,phase,requestId,targetSessionId'
          : input.phase === 'writing'
            ? 'operationId,phase,requestId'
            : 'operationId,phase') ||
      typeof input.operationId !== 'string'
    )
      return false;
    this.#prune();
    const row = this.#entries.get(input.operationId);
    if (!row) return false;
    if (input.phase === 'recovery-unavailable') {
      if (row.state !== 'awaiting-confirmation' || row.project?.action.mode !== 'restore') return false;
      row.project.outcome = {
        status: 'error',
        diagnostics: [
          {
            code: 'RECOVERY_UNAVAILABLE',
            field: '/recovery',
            severity: 'error',
            message: '执行前所选恢复副本已删除或不可读取；当前工程保留。',
            suggestion: '重新读取本机恢复列表后选择现有副本。',
          },
        ],
      };
      row.state = 'failed';
      row.rendererAcknowledged = true;
      return true;
    }
    if (input.phase === 'transition' || input.phase === 'adopted') {
      if (
        !row.project ||
        typeof input.requestId !== 'string' ||
        !/^[-\w]{1,40}$/.test(input.requestId) ||
        typeof input.targetSessionId !== 'string' ||
        !/^[-\w]{1,40}$/.test(input.targetSessionId) ||
        input.targetSessionId === row.base.documentSessionId
      )
        return false;
      if (input.phase === 'transition') {
        if (
          row.connectionId !== activeConnectionId ||
          row.state !== 'awaiting-confirmation' ||
          [...this.#entries.values()].some((r) => r.state === 'writing' || r.state === 'awaiting-adoption')
        )
          return false;
        row.requestId = input.requestId;
        row.project.targetSessionId = input.targetSessionId;
        row.state = 'writing';
        return true;
      }
      // The old control channel is already retired. Only this exact observed adoption may settle the receipt.
      if (
        row.state !== 'awaiting-adoption' ||
        row.requestId !== input.requestId ||
        row.project.targetSessionId !== input.targetSessionId ||
        row.project.outcome?.status !== 'ok'
      )
        return false;
      row.project.adopted = true;
      row.rendererAcknowledged = true;
      row.state = 'completed';
      return true;
    }
    if (input.phase === 'writing') {
      if (row.project) return false;
      if (typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 200) return false;
      if (
        row.connectionId !== activeConnectionId ||
        row.state !== 'awaiting-confirmation' ||
        [...this.#entries.values()].some((r) => r.state === 'writing')
      )
        return false;
      row.requestId = input.requestId;
      row.state = 'writing';
      return true;
    }
    if (input.phase === 'settled') {
      if (row.project) {
        if (row.state !== 'cancelled' && row.state !== 'failed') return false;
        row.rendererAcknowledged = true;
        return true;
      }
      if (row.state !== 'writing' && row.state !== 'completed' && row.state !== 'cancelled' && row.state !== 'failed')
        return false;
      row.rendererAcknowledged = true;
      if (!row.outcome) row.state = 'failed';

      return true;
    }
    if (input.phase === 'cancelled' || input.phase === 'stale') {
      if (row.state !== 'awaiting-confirmation') return false;
      row.state = input.phase;
      return true;
    }
    return false;
  }
  observe(capture: NetworkSaveCapture, outcome: NetworkSaveReply): boolean {
    const row = [...this.#entries.values()].find(
      (item) =>
        item.state === 'writing' &&
        !item.project &&
        item.requestId === capture.requestId &&
        item.base.documentSessionId === capture.documentSessionId &&
        item.base.revision === capture.revision,
    );
    if (!row) return false;
    if (outcome.status === 'ok') {
      if (
        outcome.sessionId !== capture.documentSessionId ||
        outcome.requestId !== capture.requestId ||
        outcome.revision !== capture.revision ||
        outcome.content !== capture.content
      )
        return false;
      const { content: _content, ...receipt } = outcome;
      row.outcome = receipt;
      row.state = 'completed';
    } else {
      row.outcome = outcome;
      row.state = outcome.status === 'cancelled' ? 'cancelled' : 'failed';
    }

    return true;
  }
  claimProject(
    requestId: string,
    sessionId: string,
    action: 'open' | 'create' | 'activate',
    importCopy = false,
  ): boolean {
    this.#prune();
    const row = [...this.#entries.values()].find(
      (entry) =>
        entry.state === 'writing' && entry.requestId === requestId && entry.project?.targetSessionId === sessionId,
    );
    if (!row?.project || row.project.claimed) return false;
    const mode = row.project.action.mode;
    if (!(
      (mode === 'new' && action === 'create') ||
      (mode === 'restore' && action === 'activate') ||
      (mode === 'open' && action === 'open' && !importCopy) ||
      (mode === 'import' && action === 'open' && importCopy)
    ))
      return false;
    row.project.claimed = true;
    return true;
  }
  observeProject(requestId: string, sessionId: string, outcome: ProjectOutcome): boolean {
    this.#prune();
    const row = [...this.#entries.values()].find(
      (entry) =>
        entry.state === 'writing' && entry.requestId === requestId && entry.project?.targetSessionId === sessionId,
    );
    if (!row?.project?.claimed) return false;
    row.project.outcome = outcome;
    row.project.adopted = outcome.status === 'ok' ? null : false;
    row.state = outcome.status === 'ok' ? 'awaiting-adoption' : outcome.status === 'cancelled' ? 'cancelled' : 'failed';
    return true;
  }
  retirePending(): void {
    for (const row of this.#entries.values())
      if (row.state === 'awaiting-confirmation') {
        row.state = 'stale';
      }
  }
  read(operationId: string, token: string): Result<unknown> {
    this.#prune();
    const row = this.#entries.get(operationId);
    if (
      !row ||
      !/^[a-f0-9]{64}$/.test(token) ||
      token.length !== row.token.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(row.token))
    )
      return fail('RECEIPT_UNAUTHORIZED', '回执不存在、已过期或凭证不匹配。');
    return {
      ok: true,
      value: {
        operationId: row.operationId,
        action: row.project?.action ?? { kind: 'save', mode: 'as' },
        base: row.base,
        state: row.state,
        persisted: row.project
          ? row.project.action.mode === 'new'
            ? row.project.outcome?.status === 'ok'
              ? true
              : row.state === 'writing' || row.state === 'failed'
                ? null
                : false
            : false
          : row.outcome?.status === 'ok'
            ? true
            : row.outcome?.status === 'error' || row.state === 'writing' || row.state === 'failed'
              ? null
              : false,
        rendererAcknowledged: row.rendererAcknowledged,
        ...(row.project
          ? {
              adopted: row.project.adopted,
              targetSessionId: row.project.targetSessionId ?? null,
              ...(row.project.outcome ? { outcome: row.project.outcome } : {}),
            }
          : row.outcome
            ? { outcome: row.outcome }
            : {}),
      },
    };
  }
  async #listen(): Promise<void> {
    if (this.#server && this.#port) return;
    if (this.#opening) return this.#opening;
    const generation = this.#generation;
    const server = createServer({ maxHeaderSize: 2048 }, (request, response) => {
      const send = (status: number, value: unknown) => {
        response.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'close',
        });
        response.end(JSON.stringify(value));
      };
      if (
        request.socket.remoteAddress !== '127.0.0.1' ||
        request.headers.host !== `127.0.0.1:${this.#port}` ||
        request.headers.origin !== undefined ||
        request.method !== 'POST' ||
        request.url !== '/receipt' ||
        request.headers['content-type'] !== 'application/json'
      ) {
        send(403, fail('RECEIPT_METHOD_DENIED', '仅提供本机单操作回执查询。'));
        return;
      }
      const authorization = request.headers.authorization;
      if (typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(authorization)) {
        send(401, fail('RECEIPT_UNAUTHORIZED', '回执凭证无效。'));
        return;
      }
      void (async () => {
        try {
          const parts: Buffer[] = [];
          let size = 0;
          for await (const chunk of request) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > 512) {
              send(413, fail('RECEIPT_LIMIT', '回执请求过大。'));
              return;
            }
            parts.push(bytes);
          }
          const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
          if (
            !object(input) ||
            Object.keys(input).join(',') !== 'operationId' ||
            typeof input.operationId !== 'string'
          ) {
            send(400, fail('RECEIPT_INVALID', '仅接受操作编号。'));
            return;
          }
          const result = this.read(input.operationId, authorization.slice(7));
          send(result.ok ? 200 : 401, result);
        } catch {
          send(400, fail('RECEIPT_INVALID', '回执请求格式无效。'));
        }
      })();
    });
    server.maxConnections = 16;
    server.requestTimeout = 3000;
    server.headersTimeout = 3000;
    server.keepAliveTimeout = 1;
    this.#server = server;
    this.#opening = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (generation !== this.#generation || !address || typeof address === 'string') {
          server.close();
          reject(new Error('Retired'));
          return;
        }
        server.removeListener('error', reject);
        server.on('error', () => {
          void this.stop();
        });
        this.#port = address.port;
        this.#expiry = setInterval(() => {
          this.#prune();
          if (!this.#entries.size) void this.stop();
        }, 1000);
        this.#expiry.unref();
        resolve();
      });
    }).finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }
  async stop(): Promise<void> {
    this.#generation++;
    this.#entries.clear();
    this.#port = 0;
    clearInterval(this.#expiry);
    this.#expiry = undefined;
    const server = this.#server;
    this.#server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
