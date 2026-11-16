import { parseExportArtifact, type ExportArtifact } from './export-artifact.js';
import { immutable, type Diagnostic, type ProjectDocument, type Result } from '@hyd/domain';
import { content } from './content.js';

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
interface FileApplication {
  snapshot(): {
    readonly document: ProjectDocument;
    readonly documentSessionId: string;
    readonly documentRevision: number;
    readonly dirty: boolean;
  };
  captureSave(id: string): Result<SaveCapture>;
  confirmSave(capture: SaveCapture, outcome: 'saved' | 'cancelled' | 'failed'): boolean;
  captureTransition(id: string): TransitionCapture;
  lockTransition(capture: TransitionCapture): Result<true>;
  unlockTransition(capture: TransitionCapture): void;
  openDocument(input: unknown, session: string, saved: boolean, token: TransitionCapture): Result<true>;
  suspend(reason: 'blur' | 'hidden'): void;
}

export type FileRequest = { readonly sessionId: string; readonly requestId: string } & (
  | { readonly action: 'activate'; readonly document: ProjectDocument; readonly sourceToken?: string }
  | {
      readonly action: 'save';
      readonly document: ProjectDocument;
      readonly content: string;
      readonly revision: number;
      readonly saveAs: boolean;
    }
  | { readonly action: 'export'; readonly artifact: ExportArtifact }
  | { readonly action: 'open'; readonly reference?: string }
  | {
      readonly action: 'checkpoint';
      readonly document: ProjectDocument;
      readonly revision: number;
      readonly dirty: boolean;
    }
  | { readonly action: 'catalog' | 'close' }
  | { readonly action: 'question'; readonly purpose: 'transition' | 'recovery' }
  | { readonly action: 'remove-recovery'; readonly reference: string }
);
export interface FileReference {
  readonly reference: string;
  readonly title: string;
  readonly path: string | null;
  readonly diagnostics: readonly Diagnostic[];
}
export type FileReply =
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly diagnostics: readonly Diagnostic[] }
  | {
      readonly status: 'ok';
      readonly path?: string | null;
      readonly sourceToken?: string;
      readonly document?: ProjectDocument;
      readonly requiresSaveAs?: boolean;
      readonly migration?: readonly Diagnostic[];
      readonly decision?: 'save' | 'discard' | 'cancel' | 'recover' | 'later';
      readonly recent?: readonly FileReference[];
      readonly recoveries?: readonly FileReference[];
      readonly sessionId?: string;
      readonly requestId?: string;
      readonly revision?: number;
      readonly content?: string;
      readonly deferred?: boolean;
      readonly retryAfterMs?: number;
      readonly warnings?: readonly Diagnostic[];
      readonly snapshotId?: string;
    };
export interface FilePort {
  request(input: FileRequest): Promise<FileReply>;
}
const error = (code: string, message: string): FileReply => ({
  status: 'error',
  diagnostics: [{ code, message, field: '/files', severity: 'error', suggestion: '保留当前工程并重试或另存。' }],
});

/** Owns the actual capture objects; DTO copies are never passed to confirmSave/openDocument. */
export class FileController {
  #sequence = 0;
  #busy = false;
  #path: string | null = null;
  #locked = false;
  #recoveryStatus: 'idle' | 'saved' | 'deferred' | 'error' = 'idle';
  #catalog: { readonly recent: readonly FileReference[]; readonly recoveries: readonly FileReference[] } = immutable({
    recent: [],
    recoveries: [],
  });
  constructor(
    readonly app: FileApplication,
    readonly port: FilePort,
    readonly newSession: () => string,
    readonly lockEditor: (locked: boolean) => void,
    readonly reviewCandidate: (candidate: Extract<FileReply, { status: 'ok' }>) => Promise<boolean> = async () => true,
    readonly beforeLeave: () => Promise<boolean> = async () => true,
  ) {}
  snapshot() {
    return Object.freeze({
      busy: this.#busy,
      locked: this.#locked,
      path: this.#path,
      recoveryStatus: this.#recoveryStatus,
      ...this.#catalog,
    });
  }
  #base() {
    return { sessionId: this.app.snapshot().documentSessionId, requestId: `file-${++this.#sequence}` };
  }
  async #request(input: FileRequest): Promise<FileReply> {
    try {
      return await this.port.request(input);
    } catch {
      return error('FILE_PORT_FAILED', '桌面文件服务未响应；当前工程保留。');
    }
  }
  async initialize(): Promise<FileReply> {
    const reply = await this.#request({ ...this.#base(), action: 'activate', document: this.app.snapshot().document });
    return reply.status === 'ok' ? this.catalog() : reply;
  }
  async catalog(): Promise<FileReply> {
    const base = this.#base();
    const reply = await this.#request({ ...base, action: 'catalog' });
    if (reply.status === 'ok' && base.sessionId === this.app.snapshot().documentSessionId)
      this.#catalog = immutable({ recent: reply.recent ?? [], recoveries: reply.recoveries ?? [] });
    return reply;
  }
  async #exclusive(run: () => Promise<FileReply>): Promise<FileReply> {
    if (this.#busy) return error('FILE_BUSY', '文件操作尚未结束，请稍后重试。');
    this.#busy = true;
    try {
      return await run();
    } finally {
      this.#busy = false;
    }
  }
  async save(saveAs = false): Promise<FileReply> {
    return this.#exclusive(() => this.#save(saveAs));
  }
  async #save(saveAs: boolean): Promise<FileReply> {
    const base = this.#base(),
      captured = this.app.captureSave(base.requestId);
    if (!captured.ok) return { status: 'error', diagnostics: captured.diagnostics };
    this.app.suspend('blur');
    const capture = captured.value;
    const reply = await this.#request({
      ...base,
      action: 'save',
      document: capture.document,
      revision: capture.documentRevision,
      content: capture.content,
      saveAs,
    });
    const matched =
      reply.status === 'ok' &&
      reply.sessionId === capture.documentSessionId &&
      reply.requestId === capture.requestId &&
      reply.revision === capture.documentRevision &&
      reply.content === capture.content;
    const accepted = this.app.confirmSave(
      capture,
      matched ? 'saved' : reply.status === 'cancelled' ? 'cancelled' : 'failed',
    );
    if (matched && accepted && reply.status === 'ok') {
      this.#path = reply.path ?? null;
      return reply;
    }
    return reply.status === 'ok' ? error('RESPONSE_STALE', '保存完成身份已过期，未更改当前工程保存状态。') : reply;
  }
  async exportArtifact(artifact: ExportArtifact): Promise<FileReply> {
    return this.#exclusive(async () => {
      const parsed = parseExportArtifact(artifact);
      if (!parsed.ok) return { status: 'error', diagnostics: parsed.diagnostics };
      // Capture already happened. Dialog focus pauses without resetting state or samples.
      this.app.suspend('blur');
      const base = this.#base();
      const reply = await this.#request({ ...base, action: 'export', artifact: parsed.value });
      if (
        reply.status === 'ok' &&
        (reply.sessionId !== base.sessionId ||
          reply.requestId !== base.requestId ||
          reply.snapshotId !== artifact.snapshotId ||
          base.sessionId !== this.app.snapshot().documentSessionId)
      )
        return error('RESPONSE_STALE', '导出完成身份已过期；未改变当前工程。');
      return reply;
    });
  }
  async #guard(): Promise<FileReply> {
    if (!this.app.snapshot().dirty) return { status: 'ok' };
    this.app.suspend('blur');
    const before = this.app.snapshot(),
      base = this.#base();
    const reply = await this.#request({ ...base, action: 'question', purpose: 'transition' });
    if (reply.status !== 'ok') return reply;
    if (
      before.documentSessionId !== this.app.snapshot().documentSessionId ||
      before.documentRevision !== this.app.snapshot().documentRevision
    )
      return error('RESPONSE_STALE', '询问期间工程又有修改，已保留当前工程。');
    if (reply.decision === 'cancel') return { status: 'cancelled' };
    if (reply.decision === 'discard') return { status: 'ok' };
    if (reply.decision !== 'save') return error('FILE_REPLY_INVALID', '保存询问没有有效选择。');
    const saved = await this.#save(false);
    return saved.status === 'ok' && this.app.snapshot().dirty
      ? error('UNSAVED_CHANGES', '保存期间又有修改，已保留当前工程，请再次保存。')
      : saved;
  }
  async open(reference?: string): Promise<FileReply> {
    return this.#exclusive(async () => {
      const guard = await this.#guard();
      if (guard.status !== 'ok') return guard;
      const token = this.app.captureTransition(this.#base().requestId),
        base = this.#base();
      this.app.suspend('blur');
      const reply = await this.#request({ ...base, action: 'open', ...(reference ? { reference } : {}) });
      if (reply.status !== 'ok' || !reply.document || !reply.sourceToken) return reply;
      if (!(await this.reviewCandidate(reply))) return { status: 'cancelled' };
      return this.#adopt(reply.document, token, reply);
    });
  }
  async replace(document: ProjectDocument): Promise<FileReply> {
    return this.#exclusive(async () => {
      const guard = await this.#guard();
      if (guard.status !== 'ok') return guard;
      const token = this.app.captureTransition(this.#base().requestId);
      return this.#adopt(document, token, { status: 'ok', requiresSaveAs: true });
    });
  }
  async #adopt(
    document: ProjectDocument,
    token: TransitionCapture,
    source: Extract<FileReply, { status: 'ok' }>,
  ): Promise<FileReply> {
    if (!(await this.beforeLeave())) return { status: 'cancelled' };
    const current = this.app.snapshot();
    if (current.documentSessionId !== token.documentSessionId || current.documentRevision !== token.documentRevision)
      return error('RESPONSE_STALE', '读取期间工程已改变，没有替换当前内容。');
    const locked = this.app.lockTransition(token);
    if (!locked.ok) return { status: 'error', diagnostics: locked.diagnostics };
    this.#locked = true;
    this.lockEditor(true);
    try {
      const sessionId = this.newSession();
      const bound = await this.#request({
        sessionId,
        requestId: this.#base().requestId,
        action: 'activate',
        document,
        ...(source.sourceToken ? { sourceToken: source.sourceToken } : {}),
      });
      if (bound.status !== 'ok') return bound;
      if (bound.sessionId !== sessionId) return error('RESPONSE_STALE', '文件绑定会话不匹配。');
      const opened = this.app.openDocument(document, sessionId, !source.requiresSaveAs, token);
      if (!opened.ok) return { status: 'error', diagnostics: opened.diagnostics };
      this.#path = bound.path ?? null;
      return source;
    } finally {
      this.app.unlockTransition(token);
      this.#locked = false;
      this.lockEditor(false);
    }
  }
  async close(): Promise<FileReply> {
    return this.#exclusive(async () => {
      const guard = await this.#guard();
      if (guard.status !== 'ok') return guard;
      const before = this.app.snapshot();
      if (!(await this.beforeLeave())) return { status: 'cancelled' };
      if (
        before.documentSessionId !== this.app.snapshot().documentSessionId ||
        before.documentRevision !== this.app.snapshot().documentRevision
      )
        return error('UNSAVED_CHANGES', '确认期间又应用了输入，请再次保存后退出。');
      const token = this.app.captureTransition(this.#base().requestId),
        lock = this.app.lockTransition(token);
      if (!lock.ok) return { status: 'error', diagnostics: lock.diagnostics };
      this.#locked = true;
      this.lockEditor(true);
      const reply = await this.#request({ ...this.#base(), action: 'close' });
      if (reply.status !== 'ok') {
        this.app.unlockTransition(token);
        this.#locked = false;
        this.lockEditor(false);
      }
      return reply;
    });
  }
  async checkpoint(): Promise<FileReply> {
    if (this.#locked || this.#busy) return { status: 'ok', deferred: true };
    const s = this.app.snapshot();
    const reply = await this.#request({
      ...this.#base(),
      action: 'checkpoint',
      document: s.document,
      revision: s.documentRevision,
      dirty: s.dirty,
    });
    if (s.documentSessionId === this.app.snapshot().documentSessionId)
      this.#recoveryStatus =
        reply.status === 'error' ? 'error' : reply.status === 'ok' && reply.deferred ? 'deferred' : 'saved';
    return reply;
  }
  async offerRecovery(): Promise<FileReply> {
    const catalog = await this.catalog();
    if (catalog.status !== 'ok' || !this.#catalog.recoveries.length) return catalog;
    this.app.suspend('blur');
    const before = this.app.snapshot();
    const answer = await this.#request({ ...this.#base(), action: 'question', purpose: 'recovery' });
    if (answer.status !== 'ok' || answer.decision !== 'recover') return { status: 'cancelled' };
    if (
      before.documentRevision !== this.app.snapshot().documentRevision ||
      before.documentSessionId !== this.app.snapshot().documentSessionId
    )
      return error('RESPONSE_STALE', '恢复选择期间工程已修改，请从恢复列表再次选择。');
    return this.open(this.#catalog.recoveries[0]?.reference);
  }
  async removeRecovery(reference: string): Promise<FileReply> {
    const reply = await this.#request({ ...this.#base(), action: 'remove-recovery', reference });
    if (reply.status === 'ok') await this.catalog();
    return reply;
  }
}
export { content as documentContent };
