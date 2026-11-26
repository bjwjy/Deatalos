import path from 'node:path';
import { stat } from 'node:fs/promises';
import { readFolder, createFolder, writeFolder, archiveFolder } from './network-folder-store.cjs';
import { atomicWrite, boundedRead, codeOf, digest, fingerprint, targetPath, type AtomicHooks } from './atomic-file.cjs';
import { writeNewOutput } from './new-output.cjs';
import type { NetworkToolTarget } from './network-tool-target.cjs';
import type { NetworkSaveCapture, NetworkArtifact, NetworkFileOutcome } from '@hyd/application' with {
  'resolution-mode': 'import',
};
import type { MigrationContext, NetworkLoadedProject } from '@hyd/project-io' with { 'resolution-mode': 'import' };
import type { Diagnostic, Result } from '@hyd/domain' with { 'resolution-mode': 'import' };
export type NetworkSaveReply =
  | {
      readonly status: 'ok';
      readonly path: string;
      readonly sessionId: string;
      readonly requestId: string;
      readonly revision: number;
      readonly content: string;
    }
  | {
      readonly status: 'cancelled';
    }
  | {
      readonly status: 'error';
      readonly diagnostics: readonly Diagnostic[];
    };
export type NetworkExportReply =
  | {
      readonly status: 'ok';
      readonly path: string;
      readonly sessionId: string;
      readonly requestId: string;
      readonly snapshotId: string;
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly diagnostics: readonly Diagnostic[] };
const failure = (
  code: string,
  message: string,
): { readonly status: 'error'; readonly diagnostics: readonly Diagnostic[] } => ({
  status: 'error',
  diagnostics: [
    {
      code,
      message,
      field: '/files',
      severity: 'error',
      suggestion: '保留源文件和当前设计，重试或另存。',
    },
  ],
});
const rejected = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [
    { code, message, field: '/files', severity: 'error', suggestion: '保留当前文档和源文件，使用当前会话重试。' },
  ],
});
/** Construction-time I/O scheduling seam, like AtomicHooks; never exposed over IPC. */
export interface NetworkFileHooks extends AtomicHooks {
  afterRead?(source: string): Promise<void>;
  afterWrite?(target: string): Promise<void>;
}
/** Internal host foundation, NOT registered on renderer IPC or the current v2 workbench. */
export class NetworkProjectFiles {
  #binding: {
    sessionId: string;
    projectId: string;
    source: string | null;
    target: string | null;
    fingerprint: string | null;
  } | null = null;
  #busy = false;
  #generation = 0;
  #requests = new Set<string>();
  /** Read-only target for the opt-in client; never exposes a mutable binding. */
  toolTarget(): NetworkToolTarget | null {
    const binding = this.#binding;
    if (!binding?.target?.toLowerCase().endsWith('.hydproj')) return null;
    return {
      directory: path.dirname(binding.target),
      projectId: binding.projectId,
      documentSessionId: binding.sessionId,
    };
  }
  constructor(
    readonly selectSave: (
      defaultPath: string,
      format?: 'hydx' | 'hydproj' | NetworkArtifact['format'],
    ) => Promise<string | null>,
    readonly hooks: NetworkFileHooks = {},
    readonly folderDefault = false,
  ) {}
  async create(
    document: unknown,
    sessionId: string,
    naming: 'unique' | 'exact' = 'unique',
  ): Promise<NetworkFileOutcome> {
    if (this.#busy) return failure('FILE_BUSY', '文件操作中不能新建工程。');
    this.#busy = true;
    const generation = ++this.#generation;
    try {
      const { createNetworkDraftSession } = await import('@hyd/application');
      const { encodeNetworkProject } = await import('@hyd/project-io');
      const session = createNetworkDraftSession(document, sessionId);
      if (!session.ok) return { status: 'error', diagnostics: session.diagnostics };
      const capture = session.value.captureSave('create-folder');
      if (!capture.ok) return { status: 'error', diagnostics: capture.diagnostics };
      const encoded = encodeNetworkProject(capture.value.document);
      if (!encoded.ok) return { status: 'error', diagnostics: encoded.diagnostics };
      const selected = await this.selectSave('未命名.hydproj', 'hydproj');
      if (!selected) return { status: 'cancelled' };
      const proposed = await targetPath(selected);
      if (path.extname(proposed).toLowerCase() !== '.hydproj')
        return failure('PATH_INVALID', '请选择.hydproj工程名称。');
      const target = await createFolder(proposed, () => this.#generation === generation, naming);
      await writeFolder(target, capture.value, encoded.value, null, () => this.#generation === generation, this.hooks);
      const saved = await readFolder(target);
      this.#binding = {
        sessionId,
        projectId: capture.value.document.projectId,
        source: target,
        target,
        fingerprint: saved.fingerprint,
      };
      this.#requests.clear();
      return {
        status: 'ok',
        operation: 'open',
        document: capture.value.document,
        requiresSaveAs: false,
        migration: [],
        path: target,
      };
    } catch (cause) {
      return failure(codeOf(cause), '新建工程失败，当前工作台保留；同名目录不会覆盖。');
    } finally {
      this.#busy = false;
    }
  }
  async activateDraft(input: unknown, sessionId: string): Promise<Result<true>> {
    if (this.#busy) return rejected('FILE_BUSY', '保存中不能替换绑定。');
    // Reserve intent before the first await, including module loading.
    const generation = ++this.#generation;
    const { parseNetworkProject } = await import('@hyd/domain');
    if (generation !== this.#generation) return rejected('RESPONSE_STALE', '草稿激活已被后续文件操作替代。');
    const parsed = parseNetworkProject(input);
    if (!parsed.ok) return parsed;
    this.#binding = {
      sessionId,
      projectId: parsed.value.projectId,
      source: null,
      target: null,
      fingerprint: null,
    };
    this.#requests.clear();
    return {
      ok: true,
      value: true,
    };
  }
  async open(
    file: string,
    context: MigrationContext,
    sessionId: string,
    importCopy = false,
  ): Promise<Result<NetworkLoadedProject>> {
    if (this.#busy) return rejected('FILE_BUSY', '保存中不能替换文档绑定。');
    const generation = ++this.#generation;
    const stale = () => rejected('RESPONSE_STALE', '打开已被后续文件操作替代，未提交旧绑定。');
    try {
      const { parseNetworkFile } = await import('@hyd/project-io');
      if (generation !== this.#generation) return stale();
      const source = await targetPath(file),
        folder = path.extname(source).toLowerCase() === '.hydproj' ? await readFolder(source) : null,
        before = folder?.fingerprint ?? (await fingerprint(source)),
        bytes = folder?.bytes ?? (await boundedRead(source));
      await this.hooks.afterRead?.(source);
      if (generation !== this.#generation) return stale();
      const loaded = parseNetworkFile(bytes, context);
      if (!loaded.ok) return loaded;
      if (folder && folder.entry.projectId !== loaded.value.document.projectId)
        return rejected('FOLDER_INVALID', '入口与数据的工程身份不一致。');
      const requiresSaveAs = importCopy || loaded.value.requiresSaveAs || (this.folderDefault && !folder);
      const currentFingerprint = await fingerprint(source);
      if (folder) await readFolder(source);
      // Candidate commit: no await between this check and replacing the binding.
      if (generation !== this.#generation) return stale();
      if (before !== currentFingerprint || (!folder && !currentFingerprint?.endsWith(`:${digest(bytes)}`))) {
        return rejected('FILE_CONFLICT', '读取期间源文件变化，未替换绑定。');
      }
      this.#binding = {
        sessionId,
        projectId: loaded.value.document.projectId,
        source,
        target: requiresSaveAs ? null : source,
        fingerprint: requiresSaveAs ? null : currentFingerprint,
      };
      this.#requests.clear();
      return { ok: true, value: { ...loaded.value, requiresSaveAs } };
    } catch (cause) {
      return generation !== this.#generation
        ? stale()
        : rejected(codeOf(cause), '源文件无法读取；保留当前文档和源文件。');
    }
  }
  async save(capture: NetworkSaveCapture, saveAs = false): Promise<NetworkSaveReply> {
    if (this.#busy) return failure('SAVE_BUSY', '已有保存进行中。');
    const binding = this.#binding;
    if (!binding || capture.documentSessionId !== binding.sessionId || capture.document.projectId !== binding.projectId)
      return failure('RESPONSE_STALE', '保存属于其他文档会话。');
    if (this.#requests.has(capture.requestId)) return failure('FILE_REQUEST_DUPLICATE', '保存请求已消费。');
    this.#requests.add(capture.requestId);
    this.#busy = true;
    // Saving the accepted document cancels pending opens, even if saving later
    // fails or is cancelled. Busy transition requests do not change generation.
    ++this.#generation;
    try {
      const { encodeNetworkProject } = await import('@hyd/project-io');
      const { networkDocumentContent } = await import('@hyd/application');
      const encoded = encodeNetworkProject(capture.document);
      if (!encoded.ok)
        return {
          status: 'error',
          diagnostics: encoded.diagnostics,
        };
      if (
        !Number.isSafeInteger(capture.revision) ||
        capture.revision < 0 ||
        networkDocumentContent(capture.document) !== capture.content
      )
        return failure('FILE_REQUEST_INVALID', '保存内容与捕获身份不一致。');
      const selected =
        saveAs || !binding.target
          ? await this.selectSave(
              (this.folderDefault ? '工程副本.hydproj' : binding.target) ??
                (binding.source ? path.join(path.dirname(binding.source), '迁移副本.hydx') : '未命名.hydx'),
              this.folderDefault ? 'hydproj' : 'hydx',
            )
          : binding.target;
      if (selected === null)
        return {
          status: 'cancelled',
        };
      let target = await targetPath(selected);
      const folder = path.extname(target).toLowerCase() === '.hydproj';
      if (!folder && path.extname(target).toLowerCase() !== '.hydx')
        return failure('PATH_INVALID', '工程须保存为.hydx或.hydproj。');
      const newOutput = saveAs || !binding.target;
      if (folder && newOutput) target = await createFolder(target, () => this.#binding === binding);
      const expected = newOutput ? null : binding.fingerprint;
      if (folder)
        await writeFolder(target, capture, encoded.value, expected, () => this.#binding === binding, this.hooks);
      else if (newOutput)
        target = await writeNewOutput(target, encoded.value, () => this.#binding === binding, this.hooks);
      else await atomicWrite(target, encoded.value, expected, () => this.#binding === binding, this.hooks);
      await this.hooks.afterWrite?.(target);
      const finalFingerprint = await fingerprint(target);
      const written = folder ? (await readFolder(target)).bytes : await boundedRead(target);
      if (Buffer.compare(Buffer.from(encoded.value), written) !== 0)
        return failure('FILE_CONFLICT', '写后内容已变化，未确认保存。');
      binding.target = target;
      binding.fingerprint = finalFingerprint;
      return {
        status: 'ok',
        path: target,
        sessionId: capture.documentSessionId,
        requestId: capture.requestId,
        revision: capture.revision,
        content: capture.content,
      };
    } catch (cause) {
      return failure(codeOf(cause), '保存失败，当前设计和源文件保留。');
    } finally {
      this.#busy = false;
    }
  }
  async exportArtifact(
    sessionId: string,
    requestId: string,
    input: NetworkArtifact,
    category: 'drawings' | 'data' | 'curves' | 'calculations' | 'diagnostics' = input.format === 'svg' ||
    input.format === 'pdf' ||
    input.format === 'png' ||
    input.format === 'jpg'
      ? 'drawings'
      : input.format === 'html' || input.format === 'hydcurve'
        ? 'curves'
        : input.format === 'docx' || input.format === 'md'
          ? 'calculations'
          : 'data',
    destination: 'project' | 'external' = 'project',
    defaultDirectory?: string,
  ): Promise<NetworkExportReply> {
    if (this.#busy) return failure('FILE_BUSY', '文件操作尚未完成。');
    const binding = this.#binding;
    if (!binding || binding.sessionId !== sessionId)
      return {
        status: 'error',
        diagnostics: [
          {
            code: 'RESPONSE_STALE',
            message: '导出属于其他工程会话。',
            field: '/files',
            severity: 'error',
            suggestion: '重新捕获当前结果后重试。',
          },
        ],
      };
    if (!/^[-\w]{1,80}$/.test(requestId) || this.#requests.has(requestId))
      return {
        status: 'error',
        diagnostics: [
          {
            code: 'FILE_REQUEST_DUPLICATE',
            message: '导出请求编号无效或已消费。',
            field: '/files',
            severity: 'error',
            suggestion: '重新捕获当前结果后重试。',
          },
        ],
      };
    const { parseNetworkArtifact, exportLimits } = await import('@hyd/application');
    const parsed = parseNetworkArtifact(input);
    if (!parsed.ok) return { status: 'error', diagnostics: parsed.diagnostics };
    if (this.#busy || this.#binding !== binding) return failure('RESPONSE_STALE', '归档前工程绑定已改变或正在保存。');
    this.#requests.add(requestId);
    this.#busy = true;
    ++this.#generation;
    try {
      const { encodeNetworkArtifact } = await import('./formal-renderer.cjs');
      const bytes = await encodeNetworkArtifact(parsed.value, () => this.#binding === binding);
      if (destination === 'project' && binding.target?.toLowerCase().endsWith('.hydproj')) {
        const target = await archiveFolder(
          binding.target,
          parsed.value,
          category,
          binding.fingerprint,
          () => this.#binding === binding,
          this.hooks,
          bytes,
        );
        return { status: 'ok', path: target, sessionId, requestId, snapshotId: parsed.value.snapshotId };
      }
      const directory =
        defaultDirectory && path.isAbsolute(defaultDirectory) && !defaultDirectory.includes('\0')
          ? await stat(defaultDirectory).catch(() => null)
          : null;
      // A preference only seeds the chooser. The native selection still authorizes the actual output path.
      const suggestedPath =
        directory?.isDirectory() && defaultDirectory
          ? path.join(defaultDirectory, parsed.value.suggestedName)
          : parsed.value.suggestedName;
      if (this.#binding !== binding) return failure('RESPONSE_STALE', '选择导出位置前工程会话已改变。');
      const selected = await this.selectSave(suggestedPath, parsed.value.format);
      if (!selected) return { status: 'cancelled' };
      if (this.#binding !== binding)
        return {
          status: 'error',
          diagnostics: [
            {
              code: 'RESPONSE_STALE',
              message: '选择导出位置期间工程会话已改变。',
              field: '/files',
              severity: 'error',
              suggestion: '重新捕获当前结果后重试。',
            },
          ],
        };
      let target = await targetPath(selected);
      if (path.extname(target).toLowerCase() !== '.' + parsed.value.format)
        return failure('FILE_EXTENSION_INVALID', `目标扩展名须为.${parsed.value.format}，请按导出格式选择文件类型。`);
      target = await writeNewOutput(target, bytes, () => this.#binding === binding, this.hooks, exportLimits.bytes);
      const written = await boundedRead(target, exportLimits.bytes);
      if (Buffer.compare(bytes, written) !== 0) return failure('FILE_CONFLICT', '导出后文件发生变化，未确认成功。');
      return { status: 'ok', path: target, sessionId, requestId, snapshotId: parsed.value.snapshotId };
    } catch (cause) {
      return failure(codeOf(cause), '导出失败，当前工程保留。');
    } finally {
      this.#busy = false;
    }
  }
}
