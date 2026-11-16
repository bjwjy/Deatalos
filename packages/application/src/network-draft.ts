import {
  checkJson,
  diagnostic,
  immutable,
  parseNetworkProject,
  networkPhysicalDesign,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import { canonical } from './content.js';
export interface NetworkSaveCapture {
  readonly documentSessionId: string;
  readonly requestId: string;
  readonly revision: number;
  readonly content: string;
  readonly document: NetworkProject;
}
export function networkDocumentContent(document: NetworkProject): string {
  const { updatedAt: _timestamp, ...saved } = document;
  return canonical(saved);
}
const failure = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, '/document', message)],
});
export type NetworkHistoryViewport = 'preserve-current' | 'restore-snapshot';
type Edit = {
  readonly document: NetworkProject;
  readonly physical: boolean;
  readonly viewport: NetworkHistoryViewport;
};
export type NetworkEditKind = 'physical' | 'layout' | 'view';
/** Owns engineering state. UI owns only temporary selection/input/drag state. */
export class NetworkDraftSession {
  #document: NetworkProject;
  #revision = 0;
  #physicsRevision = 0;
  #content: string;
  #saved: string | null;
  #pending: NetworkSaveCapture | null = null;
  #undo: Edit[] = [];
  #redo: Edit[] = [];
  constructor(
    document: NetworkProject,
    readonly documentSessionId: string,
    saved: boolean,
  ) {
    this.#document = document;
    this.#content = networkDocumentContent(document);
    this.#saved = saved ? this.#content : null;
  }
  get document(): NetworkProject {
    return this.#document;
  }
  get revision(): number {
    return this.#revision;
  }
  get physicsRevision(): number {
    return this.#physicsRevision;
  }
  get dirty(): boolean {
    return this.#content !== this.#saved;
  }
  get undoCount(): number {
    return this.#undo.length;
  }
  get redoCount(): number {
    return this.#redo.length;
  }
  snapshot() {
    return Object.freeze({
      document: this.#document,
      documentSessionId: this.documentSessionId,
      revision: this.#revision,
      physicsRevision: this.#physicsRevision,
      dirty: this.dirty,
      saving: this.#pending !== null,
      undoCount: this.undoCount,
      redoCount: this.redoCount,
    });
  }
  addComponent(
    component: unknown,
    initial: unknown | null,
    position: { readonly x: number; readonly y: number },
    kind: NetworkEditKind = 'physical',
  ): Result<true> {
    const componentId = component && typeof component === 'object' && 'id' in component ? component.id : undefined;
    return this.commit(
      {
        ...this.#document,
        design: {
          ...this.#document.design,
          components: [...this.#document.design.components, component],
          initialConditions:
            initial === null
              ? this.#document.design.initialConditions
              : [...this.#document.design.initialConditions, initial],
        },
        layout: {
          ...this.#document.layout,
          components: [...this.#document.layout.components, { componentId, ...position }],
        },
      },
      this.#revision,
      kind,
    );
  }
  commit(
    candidate: unknown,
    expectedRevision = this.#revision,
    kind: NetworkEditKind = 'physical',
    viewport: NetworkHistoryViewport = 'preserve-current',
  ): Result<true> {
    if (expectedRevision !== this.#revision) return failure('RESPONSE_STALE', '编辑候选已过期。');
    const parsed = parseNetworkProject(candidate);
    if (!parsed.ok) return parsed;
    if (parsed.value.projectId !== this.#document.projectId || parsed.value.createdAt !== this.#document.createdAt)
      return failure('IDENTITY_INVALID', '编辑不能替换工程身份或创建时间。');
    if (
      kind !== 'physical' &&
      (canonical(networkPhysicalDesign(parsed.value)) !== canonical(networkPhysicalDesign(this.#document)) ||
        parsed.value.provenance.preferredSolverId !== this.#document.provenance.preferredSolverId)
    )
      return failure('EDIT_KIND_INVALID', '物理设计改变必须作为物理事务提交。');
    if (
      kind === 'view' &&
      (viewport !== 'preserve-current' ||
        canonical({ ...parsed.value, layout: this.#document.layout, updatedAt: this.#document.updatedAt }) !==
          canonical(this.#document) ||
        canonical({ ...parsed.value.layout, viewport: null }) !==
          canonical({ ...this.#document.layout, viewport: null }))
    )
      return failure('EDIT_KIND_INVALID', '视图事务只能更新缩放和平移。');
    const content = networkDocumentContent(parsed.value);
    if (content === this.#content) return { ok: true, value: true };
    if (kind !== 'view') {
      const bytes =
        2 *
        [...this.#undo.map((edit) => edit.document), this.#document, parsed.value].reduce(
          (n, document) => n + networkDocumentContent(document).length,
          0,
        );
      if (bytes > 32 * 1024 * 1024) return failure('HISTORY_LIMIT', '快照超出历史预算。');
      this.#undo.push({ document: this.#document, physical: kind === 'physical', viewport });
      if (this.#undo.length > 40) this.#undo.shift();
      this.#redo = [];
    }
    this.#document = parsed.value;
    this.#content = content;
    this.#revision++;
    if (kind === 'physical') this.#physicsRevision++;
    return { ok: true, value: true };
  }
  #travel(from: Edit[], to: Edit[]): boolean {
    const before = from.pop();
    if (!before) return false;
    to.push({ document: this.#document, physical: before.physical, viewport: before.viewport });
    // Ordinary navigation survives engineering history. An explicit viewport edit owns its own reversible camera change.
    const { viewport: _historicalViewport, ...layout } = before.document.layout;
    this.#document =
      before.viewport === 'restore-snapshot'
        ? before.document
        : immutable({
            ...before.document,
            layout: {
              ...layout,
              ...(this.#document.layout.viewport ? { viewport: this.#document.layout.viewport } : {}),
            },
          });
    this.#content = networkDocumentContent(this.#document);
    this.#revision++;
    if (before.physical) this.#physicsRevision++;
    return true;
  }
  undo(): boolean {
    return this.#travel(this.#undo, this.#redo);
  }
  redo(): boolean {
    return this.#travel(this.#redo, this.#undo);
  }
  /** Preview history through its owner; callers cannot inspect or replace undo stacks. */
  previewHistory(
    direction: 'undo' | 'redo',
  ): Result<{ readonly document: NetworkProject; readonly physical: boolean }> {
    const edit = (direction === 'undo' ? this.#undo : this.#redo).at(-1);
    if (!edit) return failure('HISTORY_UNAVAILABLE', '当前没有可撤销/重做的编辑。');
    const { viewport: _old, ...layout } = edit.document.layout;
    return {
      ok: true,
      value: immutable({
        document:
          edit.viewport === 'restore-snapshot'
            ? edit.document
            : {
                ...edit.document,
                layout: {
                  ...layout,
                  ...(this.#document.layout.viewport ? { viewport: this.#document.layout.viewport } : {}),
                },
              },
        physical: edit.physical,
      }),
    };
  }
  captureSave(requestId: string): Result<NetworkSaveCapture> {
    if (this.#pending) return failure('SAVE_BUSY', '已有保存等待完成。');
    if (!/^[-\w]{1,80}$/.test(requestId)) return failure('IDENTITY_INVALID', '保存请求编号无效。');
    this.#pending = Object.freeze({
      documentSessionId: this.documentSessionId,
      requestId,
      revision: this.#revision,
      content: this.#content,
      document: this.#document,
    });
    return { ok: true, value: this.#pending };
  }
  confirmSave(capture: NetworkSaveCapture, outcome: 'saved' | 'cancelled' | 'failed'): boolean {
    if (this.#pending !== capture || capture.documentSessionId !== this.documentSessionId) return false;
    this.#pending = null;
    if (outcome === 'saved') this.#saved = capture.content;
    return true;
  }
  acceptSaveReceipt(capture: NetworkSaveCapture, receipt: unknown): boolean {
    if (!checkJson(receipt).ok || !receipt || typeof receipt !== 'object' || !('status' in receipt)) {
      this.confirmSave(capture, 'failed');
      return false;
    }
    const matched =
      receipt.status === 'ok' &&
      'sessionId' in receipt &&
      receipt.sessionId === capture.documentSessionId &&
      'requestId' in receipt &&
      receipt.requestId === capture.requestId &&
      'revision' in receipt &&
      receipt.revision === capture.revision &&
      'content' in receipt &&
      receipt.content === capture.content;
    const accepted = this.confirmSave(
      capture,
      matched ? 'saved' : receipt.status === 'cancelled' ? 'cancelled' : 'failed',
    );
    return matched && accepted;
  }
}
export function createNetworkDraftSession(
  input: unknown,
  sessionId: string,
  saved = false,
): Result<NetworkDraftSession> {
  if (!/^[-\w]{1,40}$/.test(sessionId) || ['constructor', 'prototype', '__proto__'].includes(sessionId))
    return failure('IDENTITY_INVALID', '文档会话编号无效。');
  const parsed = parseNetworkProject(input);
  return parsed.ok ? { ok: true, value: new NetworkDraftSession(parsed.value, sessionId, saved) } : parsed;
}
