import { immutable, type Result } from '@hyd/domain';
import { canonical } from './content.js';
import { toolFailure, type NetworkToolBase, type NetworkToolFileAction } from './network-tool-protocol.js';
import type { NetworkFileOutcome } from './network-services.js';
import type { NetworkToolImportedSource } from './network-tool-curves.js';
export type NetworkToolExportItem = {
  readonly kind: 'drawing' | 'curve' | 'book';
} & (
  | { readonly status: 'ok'; readonly path: string; readonly requestId: string; readonly snapshotId: string }
  | { readonly status: 'failed' | 'skipped'; readonly diagnostics: Exclude<Result<never>, { ok: true }>['diagnostics'] }
);
export interface NetworkToolFileOperation {
  readonly operationId: string;
  readonly operationKey: string;
  readonly base: NetworkToolBase;
  readonly action: NetworkToolFileAction;
  readonly state:
    'awaiting-confirmation' | 'writing' | 'reading' | 'completed' | 'partial' | 'cancelled' | 'stale' | 'failed';
  readonly outcome?:
    | { readonly status: 'ok'; readonly operation: 'curve-import'; readonly source: NetworkToolImportedSource }
    | {
        readonly status: 'ok' | 'partial' | 'error';
        readonly operation: 'export-batch';
        readonly items: readonly NetworkToolExportItem[];
      }
    | Exclude<NetworkFileOutcome, { status: 'ok' }>
    | {
        readonly status: 'ok';
        readonly operation: 'save' | 'export';
        readonly path: string;
        readonly sessionId: string;
        readonly requestId: string;
        readonly revision?: number;
        readonly snapshotId?: string;
      };
}
function sameDocument(a: NetworkToolBase, b: NetworkToolBase): boolean {
  return (
    a.documentSessionId === b.documentSessionId && a.revision === b.revision && a.physicsRevision === b.physicsRevision
  );
}
/** Bounded request/outcome ownership. Only the workbench may confirm; no filesystem or UI effects. */
export class NetworkToolFiles {
  #operations = new Map<string, NetworkToolFileOperation>();
  replay(
    base: NetworkToolBase,
    operationKey: string,
    action: NetworkToolFileAction,
  ): Result<NetworkToolFileOperation> | null {
    const prior = [...this.#operations.values()].find((item) => item.operationKey === operationKey);
    if (!prior) return null;
    return canonical({ base: prior.base, action: prior.action }) === canonical({ base, action })
      ? { ok: true, value: prior }
      : toolFailure('OPERATION_KEY_CONFLICT', '同一操作编号不能用于不同请求。');
  }
  prepare(
    base: NetworkToolBase,
    current: NetworkToolBase,
    operationKey: string,
    action: NetworkToolFileAction,
    operationId: string,
  ): Result<NetworkToolFileOperation> {
    const prior = this.replay(base, operationKey, action);
    if (prior) return prior;
    if (!sameDocument(base, current)) return toolFailure('RESPONSE_STALE', '工程已改变，请重新捕获。');
    if (
      [...this.#operations.values()].some(
        (item) => item.state === 'awaiting-confirmation' || item.state === 'writing' || item.state === 'reading',
      )
    )
      return toolFailure('FILE_BUSY', '已有文件操作等待确认或正在写入。');
    if (this.#operations.size >= 16)
      return toolFailure('FILE_OPERATION_LIMIT', '本次连接已达到16项文件操作上限；请重新连接后继续。');
    if (this.#operations.has(operationId)) return toolFailure('IDENTITY_INVALID', '文件操作编号重复。');
    const value: NetworkToolFileOperation = immutable({
      operationId,
      operationKey,
      base,
      action,
      state: 'awaiting-confirmation',
    });
    this.#operations.set(operationId, value);
    return { ok: true, value };
  }
  status(id: string): Result<NetworkToolFileOperation> {
    const value = this.#operations.get(id);
    return value ? { ok: true, value } : toolFailure('FILE_OPERATION_NOT_FOUND', '文件操作不存在或连接已退役。');
  }
  confirm(id: string, current: NetworkToolBase): Result<NetworkToolFileOperation> {
    const found = this.status(id);
    if (!found.ok) return found;
    if (found.value.state !== 'awaiting-confirmation')
      return toolFailure('FILE_OPERATION_RETIRED', '此操作已确认或退役。');
    if (!sameDocument(found.value.base, current)) {
      this.#replace(found.value, 'stale');
      return toolFailure('RESPONSE_STALE', '确认前工程已改变，未写入。');
    }
    return {
      ok: true,
      value: this.#replace(found.value, found.value.action.kind === 'curve-import' ? 'reading' : 'writing'),
    };
  }
  complete(id: string, outcome: NetworkFileOutcome): void {
    const item = this.#operations.get(id);
    if (!item || (item.state !== 'writing' && item.state !== 'reading')) return;
    if (outcome.status === 'ok') {
      if (
        (outcome.operation !== 'save' && outcome.operation !== 'export') ||
        outcome.sessionId !== item.base.documentSessionId
      ) {
        this.#replace(item, 'failed');
        return;
      }
      const receipt = {
        status: outcome.status,
        operation: outcome.operation,
        path: outcome.path,
        sessionId: outcome.sessionId,
        requestId: outcome.requestId,
        ...(outcome.operation === 'save' ? { revision: outcome.revision } : { snapshotId: outcome.snapshotId }),
      };
      this.#operations.set(id, immutable({ ...item, state: 'completed', outcome: receipt }));
      return;
    }
    this.#operations.set(
      id,
      immutable({ ...item, state: outcome.status === 'cancelled' ? 'cancelled' : 'failed', outcome }),
    );
  }
  completeImport(id: string, source: NetworkToolImportedSource): void {
    const item = this.#operations.get(id);
    if (!item || item.state !== 'reading' || item.action.kind !== 'curve-import') return;
    this.#operations.set(
      id,
      immutable({ ...item, state: 'completed', outcome: { status: 'ok', operation: 'curve-import', source } }),
    );
  }
  #retryKeys = new Map<string, string>();
  retryBatch(
    id: string,
    key: string,
    current: NetworkToolBase,
    ready: () => Result<true>,
  ): Result<{ started: boolean; operation: NetworkToolFileOperation }> {
    const found = this.status(id);
    if (!found.ok) return found;
    const row = found.value;
    if (row.action.kind !== 'export-batch') return toolFailure('FILE_OPERATION_INVALID', '仅可补写三文件归档。');
    const prior = this.#retryKeys.get(key);
    if (prior && prior !== id) return toolFailure('OPERATION_KEY_CONFLICT', '补写编号已用于另一批导出。');
    if (prior || row.state === 'completed') return { ok: true, value: { started: false, operation: row } };
    if (!sameDocument(row.base, current)) return toolFailure('RESPONSE_STALE', '工程已改变，请重新计算并导出。');
    if (row.state !== 'partial' && row.state !== 'failed')
      return toolFailure('FILE_BUSY', '请先查询原操作的最终回执。');
    if (
      [...this.#operations.values()].some((item) =>
        ['awaiting-confirmation', 'writing', 'reading'].includes(item.state),
      )
    )
      return toolFailure('FILE_BUSY', '请先完成当前文件操作。');
    if (this.#retryKeys.size >= 64) return toolFailure('FILE_OPERATION_LIMIT', '本连接的补写记录已满。');
    const available = ready();
    if (!available.ok) return available;
    this.#retryKeys.set(key, id);
    return { ok: true, value: { started: true, operation: this.#replace(row, 'writing') } };
  }
  completeBatch(id: string, items: readonly NetworkToolExportItem[]): void {
    const item = this.#operations.get(id);
    if (!item || item.state !== 'writing' || item.action.kind !== 'export-batch') return;
    const successes = items.filter((entry) => entry.status === 'ok').length;
    const state = successes === 3 ? 'completed' : successes === 0 ? 'failed' : 'partial';
    const status = state === 'completed' ? 'ok' : state === 'failed' ? 'error' : 'partial';
    this.#operations.set(id, immutable({ ...item, state, outcome: { status, operation: 'export-batch', items } }));
  }
  cancel(id: string): Result<NetworkToolFileOperation> {
    const found = this.status(id);
    if (!found.ok) return found;
    if (found.value.state === 'writing')
      return toolFailure('FILE_BUSY', '写入已开始，不能宣称取消成功；请查询实际回执。');
    return {
      ok: true,
      value:
        found.value.state === 'awaiting-confirmation' || found.value.state === 'reading'
          ? this.#replace(found.value, 'cancelled')
          : found.value,
    };
  }
  invalidate(current: NetworkToolBase | null): void {
    for (const item of this.#operations.values())
      if (item.state === 'awaiting-confirmation' && (!current || !sameDocument(item.base, current)))
        this.#replace(item, 'stale');
  }
  #replace(item: NetworkToolFileOperation, state: NetworkToolFileOperation['state']): NetworkToolFileOperation {
    const value = immutable({ ...item, state });
    this.#operations.set(item.operationId, value);
    return value;
  }
}
