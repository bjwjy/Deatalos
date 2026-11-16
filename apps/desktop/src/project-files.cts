import { mkdir, readdir, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { writeNewOutput } from './new-output.cjs';
import { randomUUID } from 'node:crypto';
import {
  atomicWrite,
  boundedRead,
  codeOf,
  digest,
  FileFailure,
  fingerprint,
  targetPath,
  type AtomicHooks,
} from './atomic-file.cjs';
import type { FileReply, FileReference } from '@hyd/application' with { 'resolution-mode': 'import' };
import type { ProjectDocument, Diagnostic } from '@hyd/domain' with { 'resolution-mode': 'import' };

export interface FileDialogs {
  open(): Promise<string | null>;
  save(defaultPath: string, format?: 'hydx' | 'svg' | 'csv'): Promise<string | null>;
  question(purpose: 'transition' | 'recovery'): Promise<'save' | 'discard' | 'cancel' | 'recover' | 'later'>;
}
interface Binding {
  sessionId: string;
  path: string | null;
  fingerprint: string | null;
  sourcePath: string | null;
  recoveryId: string;
  checkpointAt: number;
  checkpointHash: string | null;
  checkpointRevision: number;
  recoverySource: string | null;
}
interface Candidate {
  document: ProjectDocument;
  path: string | null;
  fingerprint: string | null;
  sourcePath: string | null;
  parentSession: string;
  requiresSaveAs: boolean;
  recoverySource: string | null;
}
const note = (code: string, message: string): Diagnostic => ({
  code,
  message,
  field: '/files',
  severity: 'error',
  suggestion: '保留当前工程，检查文件或另存。',
});
const failure = (code: string, message: string): FileReply => ({ status: 'error', diagnostics: [note(code, message)] });
function object(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object' && !Array.isArray(input);
}
const id = (input: unknown): input is string => typeof input === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(input);

/** Desktop-owned paths and references. No arbitrary renderer path is accepted. */
export class ProjectFiles {
  #active: Binding | null = null;
  #generation = 0;
  #usedSessions = new Set<string>();
  #lastSequence = 0;
  #saving = false;
  #opening = false;
  #recovering = false;
  #candidates = new Map<string, Candidate>();
  #recent = new Map<string, string>();
  #recovery = new Map<string, string>();
  #initialized = false;
  #startupWarnings: Diagnostic[] = [];
  readonly recoveryDirectory: string;
  constructor(
    readonly dataDirectory: string,
    readonly dialogs: FileDialogs,
    readonly hooks: AtomicHooks = {},
    readonly now: () => number = Date.now,
    readonly recoveryHooks: AtomicHooks = {},
  ) {
    this.recoveryDirectory = path.join(dataDirectory, 'recovery-f06');
  }
  async #core() {
    const [io, domain, application] = await Promise.all([
      import('@hyd/project-io'),
      import('@hyd/domain'),
      import('@hyd/application'),
    ]);
    return {
      ...io,
      ...domain,
      documentContent: application.documentContent,
      parseExportArtifact: application.parseExportArtifact,
      exportLimits: application.exportLimits,
    };
  }
  async #initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.recoveryDirectory, { recursive: true });
    // Electron enforces a single owner of this profile. Clean only our reserved transient names.
    const transient = await readdir(this.recoveryDirectory);
    if (transient.length > 512)
      throw new FileFailure('RECOVERY_DIRECTORY_LIMIT', '恢复目录条目超过预算，请先检查目录。');
    for (const name of transient) {
      if (
        /^[a-f0-9-]{36}\.hyd-recovery\.json\.hyd-lock$/.test(name) ||
        /^\.[a-f0-9-]{36}\.hyd-recovery\.json\.[a-f0-9-]{36}\.hyd-tmp$/.test(name)
      )
        await unlink(path.join(this.recoveryDirectory, name));
    }
    await this.#recoveryFiles(true);
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        await boundedRead(path.join(this.dataDirectory, 'recent-f06.json'), 65536),
      );
      const input: unknown = JSON.parse(text);
      if (
        !Array.isArray(input) ||
        input.length > 8 ||
        !input.every((v) => typeof v === 'string' && v.length < 32768 && path.isAbsolute(v))
      )
        throw new FileFailure('RECENT_INVALID', '最近文件索引损坏，已保留原索引。');
      for (const file of input) this.#recent.set(randomUUID(), file);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT')
        this.#startupWarnings.push(note('RECENT_INVALID', '最近文件索引不可读取或损坏。'));
    }
    this.#initialized = true;
  }
  async request(input: unknown): Promise<FileReply> {
    try {
      const core = await this.#core(),
        checked = core.checkJson(input);
      if (!checked.ok) return { status: 'error', diagnostics: checked.diagnostics };
      if (
        Buffer.byteLength(JSON.stringify(input), 'utf8') >
        (object(input) && input.action === 'export' ? core.exportLimits.ipcBytes : 4_100_000)
      )
        return failure('FILE_SIZE_LIMIT', 'IPC请求超过字节预算。');
      if (
        !object(input) ||
        !id(input.sessionId) ||
        typeof input.requestId !== 'string' ||
        !/^file-[1-9]\d{0,12}$/.test(input.requestId)
      )
        return failure('FILE_REQUEST_INVALID', '文件请求身份无效。');
      const fields: Record<string, readonly string[]> = {
        activate: ['document', 'sourceToken'],
        save: ['document', 'content', 'revision', 'saveAs'],
        open: ['reference'],
        checkpoint: ['document', 'revision', 'dirty'],
        catalog: [],
        close: [],
        question: ['purpose'],
        'remove-recovery': ['reference'],
        export: ['artifact'],
      };
      if (
        typeof input.action !== 'string' ||
        !Object.hasOwn(fields, input.action) ||
        Object.keys(input).some(
          (k) => !['action', 'sessionId', 'requestId', ...(fields[input.action as string] ?? [])].includes(k),
        )
      )
        return failure('FILE_REQUEST_INVALID', '文件请求字段不在白名单。');
      const sessionId = input.sessionId,
        requestId = input.requestId,
        sequence = Number(requestId.slice(5));
      if (input.action !== 'activate') {
        if (this.#active?.sessionId !== sessionId) return failure('RESPONSE_STALE', '文件请求属于旧工程会话。');
        if (sequence <= this.#lastSequence) return failure('FILE_REQUEST_DUPLICATE', '重复或逆序文件请求未执行。');
        this.#lastSequence = sequence;
      }
      await this.#initialize();
      const active = this.#active;
      const current = () => this.#active === active && this.#active?.sessionId === sessionId;
      switch (input.action) {
        case 'activate': {
          if (this.#usedSessions.has(sessionId) || (input.sourceToken !== undefined && !id(input.sourceToken)))
            return failure('SESSION_INVALID', '会话身份不可复用，或打开令牌无效。');
          const generation = ++this.#generation;
          const parsed = core.parseDocument(input.document);
          if (!parsed.ok) return { status: 'error', diagnostics: parsed.diagnostics };
          const encodedDocument = core.encodeProject(parsed.value);
          if (!encodedDocument.ok) return { status: 'error', diagnostics: encodedDocument.diagnostics };
          const candidate = typeof input.sourceToken === 'string' ? this.#candidates.get(input.sourceToken) : undefined;
          if (
            input.sourceToken &&
            (!candidate ||
              candidate.parentSession !== active?.sessionId ||
              core.documentContent(candidate.document) !== core.documentContent(parsed.value))
          )
            return failure('RESPONSE_STALE', '打开候选已失效。');
          if (generation !== this.#generation) return failure('RESPONSE_STALE', '新工程已替代此请求。');
          this.#usedSessions.add(sessionId);
          this.#lastSequence = sequence;
          this.#active = {
            sessionId,
            path: candidate?.path ?? null,
            fingerprint: candidate?.fingerprint ?? null,
            sourcePath: candidate?.sourcePath ?? null,
            recoveryId: randomUUID(),
            checkpointAt: -Infinity,
            checkpointHash: null,
            checkpointRevision: -1,
            recoverySource: candidate?.recoverySource ?? null,
          };
          this.#candidates.clear();
          if (active) await this.#removeOwnedRecovery(active);
          const warnings = this.#active.path ? await this.#remember(this.#active.path) : [];
          return { status: 'ok', path: this.#active.path, sessionId, warnings };
        }
        case 'save': {
          if (this.#saving) return failure('SAVE_BUSY', '当前保存尚未完成。');
          if (
            !Number.isSafeInteger(input.revision) ||
            typeof input.revision !== 'number' ||
            input.revision < 0 ||
            typeof input.content !== 'string' ||
            typeof input.saveAs !== 'boolean'
          )
            return failure('FILE_REQUEST_INVALID', '保存请求形状无效。');
          const parsed = core.parseDocument(input.document);
          if (!parsed.ok) return { status: 'error', diagnostics: parsed.diagnostics };
          if (core.documentContent(parsed.value) !== input.content)
            return failure('CONTENT_MISMATCH', '保存内容与捕获身份不一致。');
          if (!active || !current()) return failure('RESPONSE_STALE', '保存请求已过期。');
          this.#saving = true;
          const generation = this.#generation,
            owned = () => current() && generation === this.#generation;
          try {
            let selected = active.path;
            if (input.saveAs || !selected)
              selected = await this.dialogs.save(`${parsed.value.title.replace(/[\\/:*?"<>|]/g, '_')}.hydx`);
            if (!selected) return { status: 'cancelled' };
            if (!owned()) return failure('RESPONSE_STALE', '选择目标期间工程已改变。');
            let file = await targetPath(selected);
            if (!file.toLowerCase().endsWith('.hydx'))
              return failure('FILE_EXTENSION_INVALID', '正式工程使用.hydx扩展名，请重新另存。');
            const newOutput = input.saveAs || !active.path;
            const document = { ...parsed.value, updatedAt: new Date(this.now()).toISOString() };
            const encoded = core.encodeProject(document);
            if (!encoded.ok) return { status: 'error', diagnostics: encoded.diagnostics };
            if (newOutput) file = await writeNewOutput(file, encoded.value, owned, this.hooks);
            else await atomicWrite(file, encoded.value, active.fingerprint, owned, this.hooks);
            if (!owned()) return failure('RESPONSE_STALE', '文件完成后会话已改变，未更新新工程路径。');
            const savedFingerprint = await fingerprint(file);
            if (!owned()) return failure('RESPONSE_STALE', '保存完成身份已改变，未修改新工程路径。');
            if (!savedFingerprint?.endsWith(digest(encoded.value)))
              return failure('FILE_CONFLICT', '替换后文件又发生修改，未确认保存。');
            active.path = file;
            active.sourcePath = file;
            active.fingerprint = savedFingerprint;
            const warnings = await this.#remember(file);
            return {
              status: 'ok',
              path: file,
              sessionId,
              requestId,
              revision: input.revision,
              content: input.content,
              warnings,
            };
          } finally {
            this.#saving = false;
          }
        }
        case 'export': {
          if (this.#saving) return failure('SAVE_BUSY', '当前写入尚未完成。');
          const parsed = core.parseExportArtifact(input.artifact);
          if (!parsed.ok) return { status: 'error', diagnostics: parsed.diagnostics };
          const artifact = parsed.value;
          this.#saving = true;
          try {
            const selected = await this.dialogs.save(artifact.suggestedName, artifact.format);
            if (!selected) return { status: 'cancelled' };
            if (!current()) return failure('RESPONSE_STALE', '选择导出目标期间工程会话已改变。');
            let file = await targetPath(selected);
            if (!file.toLowerCase().endsWith('.' + artifact.format))
              return failure('FILE_EXTENSION_INVALID', '目标扩展名与导出格式不一致。');
            const bytes = Buffer.from(artifact.text, 'utf8');
            file = await writeNewOutput(file, bytes, current, this.hooks, core.exportLimits.bytes);
            const actual = await fingerprint(file, core.exportLimits.bytes);
            if (!current()) return failure('RESPONSE_STALE', '导出结束时会话已改变。');
            if (!actual?.endsWith(digest(bytes))) return failure('FILE_CONFLICT', '导出后目标又被修改，未确认成功。');
            // No project binding, saved baseline, recent files or recovery changes.
            return { status: 'ok', path: file, sessionId, requestId, snapshotId: artifact.snapshotId };
          } finally {
            this.#saving = false;
          }
        }
        case 'open': {
          if (this.#opening) return failure('OPEN_BUSY', '已有文件读取正在进行。');
          if (input.reference !== undefined && !id(input.reference))
            return failure('FILE_REQUEST_INVALID', '文件引用无效。');
          this.#opening = true;
          try {
            const reference = typeof input.reference === 'string' ? input.reference : undefined;
            const recoveryFile = reference ? this.#recovery.get(reference) : undefined;
            const selected = reference ? (recoveryFile ?? this.#recent.get(reference)) : await this.dialogs.open();
            if (reference && !selected) return failure('FILE_REFERENCE_INVALID', '文件引用已失效，请刷新列表。');
            if (!selected) return { status: 'cancelled' };
            const sourceFingerprint = recoveryFile ? null : await fingerprint(selected);
            const bytes = await boundedRead(selected, recoveryFile ? 2_100_000 : 2_000_000);
            if (
              !recoveryFile &&
              ((await fingerprint(selected)) !== sourceFingerprint || !sourceFingerprint?.endsWith(digest(bytes)))
            )
              return failure('FILE_CONFLICT', '读取期间源文件发生修改，未载入。');
            const loaded = recoveryFile
              ? await this.#parseRecovery(bytes)
              : core.parseProject(bytes, {
                  projectId: `m-${randomUUID().replaceAll('-', '')}`,
                  timestamp: new Date(this.now()).toISOString(),
                  appVersion: '0.6.0',
                });
            if (!loaded.ok) return { status: 'error', diagnostics: loaded.diagnostics };
            if (!current()) return failure('RESPONSE_STALE', '读取期间工程会话已改变。');
            const token = randomUUID();
            this.#candidates.clear();
            this.#candidates.set(token, {
              document: loaded.value.document,
              parentSession: sessionId,
              path: loaded.value.requiresSaveAs ? null : selected,
              sourcePath: recoveryFile ? null : selected,
              fingerprint: sourceFingerprint,
              requiresSaveAs: loaded.value.requiresSaveAs,
              recoverySource: recoveryFile ?? null,
            });
            return {
              status: 'ok',
              sourceToken: token,
              path: recoveryFile ? null : selected,
              document: loaded.value.document,
              requiresSaveAs: loaded.value.requiresSaveAs,
              migration:
                loaded.value.migration?.changes.map((change) => ({
                  ...change,
                  severity: 'info' as const,
                  suggestion: '迁移结果请另存为v2工程。',
                })) ?? [],
            };
          } finally {
            this.#opening = false;
          }
        }
        case 'question': {
          if (input.purpose !== 'transition' && input.purpose !== 'recovery')
            return failure('FILE_REQUEST_INVALID', '询问类型无效。');
          const decision = await this.dialogs.question(input.purpose);
          return current() ? { status: 'ok', decision } : failure('RESPONSE_STALE', '询问已过期。');
        }
        case 'checkpoint': {
          if (
            typeof input.dirty !== 'boolean' ||
            typeof input.revision !== 'number' ||
            !Number.isSafeInteger(input.revision) ||
            input.revision < 0
          )
            return failure('FILE_REQUEST_INVALID', '恢复请求形状无效。');
          if (!active || !current()) return failure('RESPONSE_STALE', '恢复会话已失效。');
          if (this.#recovering || this.#saving) return { status: 'ok', deferred: true, retryAfterMs: 1000 };
          const parsed = core.parseDocument(input.document);
          if (!parsed.ok) return { status: 'error', diagnostics: parsed.diagnostics };
          const encodedDocument = core.encodeProject(parsed.value);
          if (!encodedDocument.ok) return { status: 'error', diagnostics: encodedDocument.diagnostics };
          const hash = digest(core.documentContent(parsed.value));
          if (input.revision < active.checkpointRevision) return failure('RESPONSE_STALE', '恢复修订已过期。');
          if (!input.dirty) {
            await this.#removeOwnedRecovery(active);
            active.checkpointHash = null;
            return { status: 'ok' };
          }
          if (hash === active.checkpointHash) return { status: 'ok' };
          if (this.now() - active.checkpointAt < 10000)
            return {
              status: 'ok',
              deferred: true,
              retryAfterMs: Math.max(1, 10000 - (this.now() - active.checkpointAt)),
            };
          this.#recovering = true;
          try {
            const file = path.join(this.recoveryDirectory, `${active.recoveryId}.hyd-recovery.json`);
            const bytes = Buffer.from(
              JSON.stringify({
                format: 'HydraulicWorkbenchRecovery',
                version: 1,
                sessionId,
                recordId: active.recoveryId,
                documentRevision: input.revision,
                contentHash: hash,
                createdAt: new Date(this.now()).toISOString(),
                sourcePath: active.sourcePath,
                document: parsed.value,
              }),
            );
            if (bytes.length > 2_100_000) return failure('RECOVERY_SIZE_LIMIT', '恢复副本超出预算。');
            await atomicWrite(file, bytes, await fingerprint(file, 2_100_000), current, this.recoveryHooks, 2_100_000);
            if (!current()) return failure('RESPONSE_STALE', '旧会话恢复写入已停止。');
            active.checkpointAt = this.now();
            active.checkpointHash = hash;
            active.checkpointRevision = input.revision;
            await this.#recoveryFiles(true);
            return { status: 'ok' };
          } finally {
            this.#recovering = false;
          }
        }
        case 'catalog': {
          const recent = [...this.#recent].map(([reference, file]) => ({
            reference,
            title: path.basename(file),
            path: file,
            diagnostics: [],
          }));
          const recoveries: FileReference[] = [];
          this.#recovery.clear();
          for (const file of await this.#recoveryFiles(false)) {
            const reference = randomUUID();
            this.#recovery.set(reference, file);
            try {
              const result = await this.#parseRecovery(await boundedRead(file, 2_100_000));
              recoveries.push({
                reference,
                title: result.ok ? result.value.document.title : path.basename(file),
                path: null,
                diagnostics: result.ok ? [] : result.diagnostics,
              });
            } catch (error) {
              recoveries.push({
                reference,
                title: path.basename(file),
                path: null,
                diagnostics: [note(codeOf(error), '恢复副本读取失败，未载入。')],
              });
            }
          }
          return { status: 'ok', recent, recoveries, warnings: this.#startupWarnings };
        }
        case 'remove-recovery': {
          if (!id(input.reference)) return failure('FILE_REQUEST_INVALID', '恢复引用无效。');
          const file = this.#recovery.get(input.reference);
          if (!file) return failure('FILE_REFERENCE_INVALID', '恢复引用已过期。');
          await unlink(file);
          this.#recovery.delete(input.reference);
          return { status: 'ok' };
        }
        case 'close': {
          if (this.#saving || this.#recovering) return failure('FILE_BUSY', '保存/恢复写入尚未完成，请再次关闭。');
          if (active) await this.#removeOwnedRecovery(active);
          return { status: 'ok' };
        }
        default:
          return failure('FILE_REQUEST_INVALID', '不支持的文件操作。');
      }
    } catch (error) {
      const code = codeOf(error);
      return failure(
        code,
        error instanceof FileFailure ? error.message : '文件操作失败，当前工程保留。请检查文件占用、权限、空间或另存。',
      );
    }
  }
  async #remember(file: string): Promise<readonly Diagnostic[]> {
    const values = [file, ...this.#recent.values()]
      .filter((v, i, all) => all.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i)
      .slice(0, 8);
    const target = path.join(this.dataDirectory, 'recent-f06.json');
    try {
      await atomicWrite(
        target,
        Buffer.from(JSON.stringify(values)),
        await fingerprint(target, 65536),
        () => true,
        {},
        65536,
      );
      this.#recent.clear();
      for (const value of values) this.#recent.set(randomUUID(), value);
      return [];
    } catch (error) {
      return [note('RECENT_WRITE_FAILED', `工程已落盘；最近文件索引未更新（${codeOf(error)}）。`)];
    }
  }
  async #removeOwnedRecovery(binding: Binding): Promise<void> {
    for (const file of [
      path.join(this.recoveryDirectory, `${binding.recoveryId}.hyd-recovery.json`),
      binding.recoverySource,
    ]) {
      if (file)
        await unlink(file).catch((error) => {
          if (codeOf(error) !== 'ENOENT')
            this.#startupWarnings.push(
              note('RECOVERY_CLEANUP_FAILED', '旧恢复副本未清理，可能再次提示；正式工程不受影响。'),
            );
        });
    }
  }
  async #recoveryFiles(prune: boolean): Promise<string[]> {
    const names = await readdir(this.recoveryDirectory);
    if (names.length > 512) throw new FileFailure('RECOVERY_DIRECTORY_LIMIT', '恢复目录条目超预算，未自动载入。');
    const rows = [];
    for (const name of names.filter((n) => /^[a-f0-9-]{36}\.hyd-recovery\.json$/.test(n))) {
      const file = path.join(this.recoveryDirectory, name),
        stat = await lstat(file);
      rows.push({ file, modified: stat.mtimeMs, size: stat.size });
    }
    rows.sort((a, b) => b.modified - a.modified);
    let total = 0;
    const retained = [];
    for (const row of rows) {
      if (retained.length < 5 && total + row.size <= 10_500_000) {
        retained.push(row.file);
        total += row.size;
      } else if (prune) await unlink(row.file);
    }
    return retained;
  }
  async #parseRecovery(bytes: Uint8Array) {
    const core = await this.#core();
    try {
      const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (
        !object(envelope) ||
        Object.keys(envelope).some(
          (k) =>
            ![
              'format',
              'version',
              'sessionId',
              'recordId',
              'documentRevision',
              'contentHash',
              'createdAt',
              'sourcePath',
              'document',
            ].includes(k),
        ) ||
        envelope.format !== 'HydraulicWorkbenchRecovery' ||
        envelope.version !== 1
      )
        return {
          ok: false as const,
          diagnostics: [note('RECOVERY_VERSION_INVALID', '恢复副本损坏或来自不支持的版本。')],
        };
      const parsed = core.parseDocument(envelope.document);
      if (!parsed.ok) return parsed;
      if (
        !id(envelope.sessionId) ||
        !id(envelope.recordId) ||
        typeof envelope.documentRevision !== 'number' ||
        !Number.isSafeInteger(envelope.documentRevision) ||
        envelope.documentRevision < 0 ||
        typeof envelope.createdAt !== 'string' ||
        new Date(envelope.createdAt).toISOString() !== envelope.createdAt ||
        (envelope.sourcePath !== null &&
          (typeof envelope.sourcePath !== 'string' || !path.isAbsolute(envelope.sourcePath))) ||
        digest(core.documentContent(parsed.value)) !== envelope.contentHash
      )
        return { ok: false as const, diagnostics: [note('RECOVERY_INVALID', '恢复副本内容身份或元数据不一致。')] };
      return { ok: true as const, value: { document: parsed.value, requiresSaveAs: true, migration: null } };
    } catch {
      return { ok: false as const, diagnostics: [note('RECOVERY_INVALID', '恢复副本JSON或UTF-8损坏，未载入。')] };
    }
  }
}
