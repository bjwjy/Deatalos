import {
  createNetworkDraftSession,
  type NetworkDraftSession,
  type NetworkFileOutcome,
  type NetworkFileRequest,
  type NetworkExportCapture,
  type NetworkSaveCapture,
  type ExportArtifact,
  type NetworkArtifact,
  networkDiagnosticArchive,
} from '@hyd/application';
import {
  diagnostic,
  diagnosticDisplayText,
  type DisplayDiagnostic,
  type NetworkProject,
  type NetworkIdentity,
  type Result,
} from '@hyd/domain';
import type { MigrationContext } from '@hyd/project-io';
import { element as $ } from './network-dom.mjs';
import { presentNetworkSave } from './network-v13-operation-feedback.mjs';
import type { PressureBands } from './network-pressure.mjs';
import { requestNetworkFile, parseExportReply } from './network-service-client.mjs';

interface FileHooks {
  editor(): NetworkDraftSession;
  pressureBands(): PressureBands;
  draft(): NetworkProject;
  uid(prefix: string): string;
  context(): MigrationContext;
  adopt(editor: NetworkDraftSession): void;
  operation(): number;
  clearDiagnostics(): void;
  diagnostics(items: readonly DisplayDiagnostic[], source?: string, document?: NetworkProject | null): void;
  objectForDiagnostic(item: DisplayDiagnostic): string;
  render(): void;
  renderFeedback(): void;
  toast(message: string): void;
  stateForCapture(): Promise<NetworkIdentity | null>;
  refreshRecords(): Promise<NetworkExportCapture | null>;
  checkpointCurve?(): Promise<void>;
  bindingChanged?(): void;
  archiveDiagnostics(): readonly DisplayDiagnostic[];
  exportDirectory?(): string | null;
}
/** Exact host operation identity; adoption acknowledgement is sent only after the existing owner accepted the session. */
export interface NetworkProjectTransition {
  beforeStart(sessionId: string, requestId: string): Promise<boolean>;
  adopted(sessionId: string, requestId: string): Promise<boolean>;
}
export function createNetworkFiles(
  hooks: FileHooks,
  request: (input: NetworkFileRequest, associatedId?: string) => Promise<NetworkFileOutcome> = requestNetworkFile,
) {
  let fileBusy = false,
    filePath = '',
    requiresFolderSave = false;
  const fileError = (result: NetworkFileOutcome | Result<unknown>) =>
    'diagnostics' in result
      ? result.diagnostics.map((item) => diagnosticDisplayText(item, hooks.objectForDiagnostic(item))).join('；')
      : '文件操作失败';
  async function activate(document: NetworkProject, sessionId: string, requestId?: string): Promise<void> {
    const result = await request({ action: 'activate', document, sessionId, ...(requestId ? { requestId } : {}) });
    if (result.status !== 'ok' || result.operation !== 'activate') throw new Error(fileError(result));
  }
  async function save(
    saveAs = false,
    observe?: (outcome: NetworkFileOutcome) => void,
    beforeWrite?: (capture: NetworkSaveCapture) => Promise<boolean>,
  ): Promise<boolean> {
    if (fileBusy) return false;
    hooks.clearDiagnostics();
    hooks.renderFeedback();
    const owner = hooks.editor(),
      captured = owner.captureSave(hooks.uid('save'));
    if (!captured.ok) {
      hooks.diagnostics(captured.diagnostics, '保存');
      return false;
    }
    const capture = captured.value,
      operation = hooks.operation();
    fileBusy = true;
    let confirmed = false;
    presentNetworkSave('working');
    $('saveProject').setAttribute('disabled', '');
    $('saveAs').setAttribute('disabled', '');
    try {
      if (beforeWrite && !(await beforeWrite(capture))) return false;
      const result = await request({ action: 'save', capture, saveAs });
      observe?.(result);
      if (hooks.editor() !== owner) {
        owner.confirmSave(capture, 'failed');
        return false;
      }
      const accepted = owner.acceptSaveReceipt(capture, result);
      if (accepted && result.status === 'ok' && result.operation === 'save') {
        confirmed = true;
        presentNetworkSave('confirmed');
        filePath = result.path;
        requiresFolderSave = false;
        hooks.bindingChanged?.();
        hooks.toast(owner.dirty ? '已保存捕获版本；当前工程仍有未保存修改。' : `已保存：${filePath}`);
        if (operation === hooks.operation()) hooks.clearDiagnostics();
        hooks.render();
        return !owner.dirty;
      }
      if (result.status === 'cancelled') hooks.toast('已取消保存；当前工程保留。');
      else if (operation === hooks.operation())
        hooks.diagnostics(
          'diagnostics' in result ? result.diagnostics : [diagnostic('SAVE_FAILED', '/files', fileError(result))],
          '保存',
        );
      return false;
    } finally {
      if (!confirmed) presentNetworkSave('idle');
      owner.confirmSave(capture, 'failed');
      fileBusy = false;
      $('saveProject').removeAttribute('disabled');
      $('saveAs').removeAttribute('disabled');
    }
  }
  async function open(
    mode: 'interactive' | 'startup' = 'interactive',
    transition?: NetworkProjectTransition,
    importCopy = false,
    associatedId?: string,
  ): Promise<boolean> {
    if (fileBusy) return false;
    hooks.clearDiagnostics();
    hooks.renderFeedback();
    const editor = hooks.editor();
    if (
      editor.dirty &&
      (mode === 'interactive' || editor.revision !== 0) &&
      !confirm('当前工程尚未保存。取消打开操作可保留当前内容；继续后再选择文件。')
    )
      return false;
    fileBusy = true;
    const main = documentElement();
    main.inert = true;
    try {
      await hooks.checkpointCurve?.();
      const nextSession = hooks.uid('session');
      const requestId = hooks.uid('open');
      if (transition && !(await transition.beforeStart(nextSession, requestId))) return false;
      const result = await request(
        {
          action: 'open',
          sessionId: nextSession,
          context: hooks.context(),
          ...(transition ? { requestId } : {}),
          ...(importCopy ? { importCopy: true } : {}),
        },
        associatedId,
      );
      if (result.status === 'cancelled') return false;
      if (result.status !== 'ok' || result.operation !== 'open') {
        hooks.diagnostics(
          'diagnostics' in result ? result.diagnostics : [diagnostic('OPEN_FAILED', '/files', fileError(result))],
          '打开文件',
          null,
        );
        return false;
      }
      const session = createNetworkDraftSession(result.document, nextSession, !result.requiresSaveAs);
      if (!session.ok) {
        hooks.diagnostics(session.diagnostics, '打开文件', null);
        return false;
      }
      filePath = importCopy ? '' : result.path;
      requiresFolderSave = !!result.requiresSaveAs;
      hooks.adopt(session.value);
      if (transition) await transition.adopted(nextSession, requestId);
      hooks.bindingChanged?.();
      if (result.migration.length)
        hooks.toast(`已载入迁移副本：${result.migration.map((item) => diagnosticDisplayText(item)).join('；')}`);
      return true;
    } finally {
      main.inert = false;
      fileBusy = false;
    }
  }
  async function fresh(transition?: NetworkProjectTransition): Promise<boolean> {
    if (fileBusy) return false;
    if (hooks.editor().dirty && !confirm('当前工程尚未保存。继续新建将保留当前工程文件但清空工作台。')) return false;
    const document = hooks.draft(),
      sessionId = hooks.uid('session');
    fileBusy = true;
    const main = documentElement();
    main.inert = true;
    try {
      await hooks.checkpointCurve?.();
      const requestId = hooks.uid('create');
      if (transition && !(await transition.beforeStart(sessionId, requestId))) return false;
      const result = await request({ action: 'create', document, sessionId, ...(transition ? { requestId } : {}) });
      if (result.status === 'cancelled') {
        hooks.toast('已取消新建；当前工程保留。');
        return false;
      }
      if (result.status !== 'ok' || result.operation !== 'open') {
        hooks.diagnostics(
          'diagnostics' in result ? result.diagnostics : [diagnostic('CREATE_FAILED', '/files', fileError(result))],
        );
        return false;
      }
      const session = createNetworkDraftSession(result.document, sessionId, true);
      if (!session.ok) {
        hooks.diagnostics(session.diagnostics);
        return false;
      }
      filePath = result.path;
      requiresFolderSave = false;
      hooks.adopt(session.value);
      if (transition) await transition.adopted(sessionId, requestId);
      hooks.bindingChanged?.();
      hooks.toast('已新建工程文件夹：' + filePath);
      return true;
    } finally {
      main.inert = false;
      fileBusy = false;
    }
  }
  async function restoreRecovery(document: unknown, transition?: NetworkProjectTransition): Promise<boolean> {
    if (fileBusy) return false;
    const nextSession = hooks.uid('session');
    const session = createNetworkDraftSession(document, nextSession, false);
    if (!session.ok) {
      hooks.toast('恢复副本无法读取，当前工程保留。');
      return false;
    }
    if (hooks.editor().dirty && !confirm('当前工程有未保存内容。确定打开所选恢复副本吗？')) return false;
    fileBusy = true;
    const main = documentElement();
    main.inert = true;
    try {
      await hooks.checkpointCurve?.();
      const requestId = hooks.uid('restore');
      if (transition && !(await transition.beforeStart(nextSession, requestId))) return false;
      await activate(session.value.document, nextSession, transition ? requestId : undefined);
      filePath = '';
      hooks.adopt(session.value);
      if (transition) await transition.adopted(nextSession, requestId);
      hooks.toast('已打开恢复副本，可另存为新工程。');
      return true;
    } catch {
      hooks.toast('打开恢复副本失败，当前工程保留。');
      return false;
    } finally {
      main.inert = false;
      fileBusy = false;
    }
  }
  async function writeArtifact(
    artifact: NetworkArtifact,
    category: 'drawings' | 'curves' | 'data' | 'calculations' | 'diagnostics' = 'calculations',
    destination: 'project' | 'external' = 'project',
    observe?: (outcome: NetworkFileOutcome) => void,
  ): Promise<boolean> {
    if (fileBusy) {
      hooks.toast('文件操作尚未完成，请稍后重试。');
      return false;
    }
    const owner = hooks.editor(),
      revision = owner.physicsRevision;
    const defaultDirectory = category === 'diagnostics' ? null : hooks.exportDirectory?.();
    fileBusy = true;
    try {
      const reply = await request({
        action: 'export',
        sessionId: owner.documentSessionId,
        requestId: hooks.uid('export'),
        artifact,
        category,
        destination,
        ...(defaultDirectory ? { defaultDirectory } : {}),
      });
      observe?.(reply);
      if (hooks.editor() !== owner || owner.physicsRevision !== revision) return false;
      if (reply.status === 'ok' && reply.operation === 'export') {
        hooks.toast('已导出：' + reply.path);
        return true;
      }
      if (reply.status === 'cancelled') hooks.toast('已取消导出；工程与结果保留。');
      else
        hooks.diagnostics(
          'diagnostics' in reply ? reply.diagnostics : [diagnostic('EXPORT_FAILED', '/export', fileError(reply))],
          '文件导出',
        );
      return false;
    } finally {
      fileBusy = false;
    }
  }
  async function makeExport(
    format: 'csv' | 'svg' | 'learning',
    destination: 'project' | 'external' = 'project',
  ): Promise<void> {
    if (fileBusy) return;
    fileBusy = true;
    try {
      await captureExport(format, destination);
    } finally {
      fileBusy = false;
    }
  }
  async function captureExport(format: 'csv' | 'svg' | 'learning', destination: 'project' | 'external'): Promise<void> {
    hooks.clearDiagnostics();
    hooks.renderFeedback();
    const operation = hooks.operation(),
      owner = hooks.editor(),
      revision = owner.physicsRevision,
      pressureBands = hooks.pressureBands();
    const current = () => hooks.editor() === owner && owner.physicsRevision === revision;
    $('exportStatus').textContent = '正在捕获并整理所选记录；当前计算继续。';
    if (!(await hooks.stateForCapture())) {
      $('exportStatus').textContent = '没有当前修订的有效结果，未导出。';
      return;
    }
    const capture = await hooks.refreshRecords();
    if (!current()) return;
    if (!capture) {
      $('exportStatus').textContent = '记录捕获未完成，未导出；请查看诊断后重试。';
      return;
    }
    const artifact = await formatExport(format, capture, pressureBands);
    if (!current()) return;
    if (!artifact.ok) {
      $('exportStatus').textContent = fileError(artifact);
      if (operation === hooks.operation()) hooks.diagnostics(artifact.diagnostics, '导出');
      return;
    }
    const defaultDirectory = hooks.exportDirectory?.();
    const reply = await request({
      action: 'export',
      sessionId: owner.documentSessionId,
      requestId: hooks.uid('export'),
      artifact: artifact.value,
      category: format === 'svg' ? 'drawings' : format === 'csv' ? 'data' : 'calculations',
      destination,
      ...(defaultDirectory ? { defaultDirectory } : {}),
    });
    if (!current()) return;
    if (reply.status === 'ok' && reply.operation === 'export') {
      if (operation === hooks.operation()) hooks.clearDiagnostics();
      hooks.renderFeedback();
      $('exportStatus').textContent = `已导出同源快照：${reply.path}`;
    } else if (reply.status === 'cancelled') $('exportStatus').textContent = '已取消导出；工程与结果保留。';
    else {
      $('exportStatus').textContent = fileError(reply);
      if (operation === hooks.operation())
        hooks.diagnostics(
          'diagnostics' in reply ? reply.diagnostics : [diagnostic('EXPORT_FAILED', '/files', fileError(reply))],
          '导出',
        );
    }
  }
  async function close(): Promise<void> {
    if (hooks.editor().dirty) {
      if (confirm('当前网络工程尚未保存。确定先保存再关闭软件吗？取消后可选择放弃修改。')) {
        if (!(await save(false))) return;
      } else if (!confirm('确定放弃未保存修改并关闭软件吗？取消则保留当前工作台。')) {
        hooks.toast('已取消关闭；当前工程与运行状态保留。');
        return;
      }
    }
    await hooks.checkpointCurve?.();
    const result = await request({ action: 'close', sessionId: hooks.editor().documentSessionId });
    if (result.status === 'error') hooks.diagnostics(result.diagnostics, '关闭');
  }
  return {
    activate,
    save,
    open,
    fresh,
    restoreRecovery,
    makeExport,
    writeArtifact,
    archiveDiagnostics: () =>
      writeArtifact(networkDiagnosticArchive(hooks.archiveDiagnostics(), hooks.uid('diagnostics')), 'diagnostics'),
    close,
    get canConnectMcp(): boolean {
      return !requiresFolderSave && filePath.toLowerCase().endsWith('.hydproj');
    },
    get currentPath(): string {
      return filePath;
    },
    get displayName(): string {
      if (!filePath) return hooks.editor().document.title;
      // Display the committed file binding, never an unaccepted chooser value or a second document title.
      const segments = filePath.split(/[\\/]/);
      const file = segments.at(-1);
      return (file?.toLowerCase().endsWith('.hydproj') ? segments.at(-2) : undefined) || hooks.editor().document.title;
    },
    get busy() {
      return fileBusy;
    },
  };
}
function documentElement(): HTMLElement {
  const main = document.querySelector('main');
  if (!(main instanceof HTMLElement)) throw new Error('Main workspace missing');
  return main;
}
async function formatExport(
  format: 'csv' | 'svg' | 'learning',
  capture: NetworkExportCapture,
  pressureBands: PressureBands,
): Promise<Result<ExportArtifact>> {
  const worker = new Worker('./network-export-worker.mjs', { type: 'module' });
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          resolve({
            ok: false,
            diagnostics: [diagnostic('EXPORT_TIMEOUT', '/export', '导出整理超时；当前计算继续，请稍后重新捕获。')],
          }),
        12000,
      );
      worker.onmessage = (event: MessageEvent<unknown>) => {
        clearTimeout(timer);
        resolve(parseExportReply(event.data));
      };
      worker.onerror = () => {
        clearTimeout(timer);
        resolve({
          ok: false,
          diagnostics: [diagnostic('EXPORT_FAILED', '/export', '导出整理失败；当前计算继续，可重新捕获。')],
        });
      };
      worker.postMessage({
        format,
        capture,
        pressureBands,
        labels: ($('svgLabels') as HTMLSelectElement).value === 'none' ? 'none' : 'all',
      });
    });
  } finally {
    worker.terminate();
  }
}
