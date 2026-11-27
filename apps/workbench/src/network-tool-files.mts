import {
  NetworkToolFiles,
  type NetworkCatalogPreview,
  type NetworkDraftSession,
  type NetworkArtifact,
  type NetworkFileOutcome,
  type NetworkToolBase,
  type NetworkToolRequest,
  type NetworkToolFileAction,
  type NetworkToolExportItem,
  type NetworkToolCurves,
} from '@hyd/application';
import { diagnostic, type Result } from '@hyd/domain';
import type { CalculationRecord } from '@hyd/engineering';
import type { createNetworkFiles, NetworkProjectTransition } from './network-file-controller.mjs';
import type { createNetworkFormalExport } from './network-formal-export.mjs';
import type { createNetworkRecovery } from './network-recovery.mjs';
interface Hooks {
  importCurve(input: unknown, base: NetworkToolBase): ReturnType<NetworkToolCurves['importFile']>;
  recovery: ReturnType<typeof createNetworkRecovery>;
  enqueue(action: () => Promise<void>): Promise<void>;
  editor(): NetworkDraftSession;
  catalog(
    action: Extract<Extract<NetworkToolRequest, { method: 'file_prepare' }>['params']['action'], { kind: 'catalog' }>,
  ): Result<NetworkCatalogPreview>;
  calculation(
    action: Extract<Extract<NetworkToolRequest, { method: 'file_prepare' }>['params']['action'], { kind: 'book' }>,
  ): Result<CalculationRecord>;
  curve(
    action: Extract<Extract<NetworkToolRequest, { method: 'file_prepare' }>['params']['action'], { kind: 'curve' }>,
  ): Result<{ readonly artifact: NetworkArtifact; readonly summary: string }>;
  base(): NetworkToolBase;
  uid(prefix: string): string;
  files: ReturnType<typeof createNetworkFiles>;
  formalExport: ReturnType<typeof createNetworkFormalExport>;
}
/** Presents one explicit confirmation. Pending operation semantics belong to application. */
export function createToolFileDialogs(hooks: Hooks) {
  let operations = new NetworkToolFiles();
  let displayed = '';
  let batchArtifacts: readonly {
    readonly kind: NetworkToolExportItem['kind'];
    readonly category: 'drawings' | 'data' | 'calculations';
    readonly artifact: NetworkArtifact;
  }[] = [];
  let cancelImport: (() => void) | undefined;
  function chooseCurveFile(): Promise<File | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.hydcurve,.json';
      input.hidden = true;
      const finish = (file: File | null) => {
        input.onchange = null;
        input.oncancel = null;
        input.remove();
        if (cancelImport === cancelled) cancelImport = undefined;
        resolve(file);
      };
      const cancelled = () => finish(null);
      cancelImport = cancelled;
      input.onchange = () => finish(input.files?.[0] ?? null);
      input.oncancel = cancelled;
      document.body.append(input);
      input.click();
    });
  }
  const dialog = document.createElement('dialog');
  dialog.id = 'toolFileConfirmation';
  dialog.className = 'v13-dialog';
  dialog.setAttribute('aria-labelledby', 'toolFileHeading');
  const heading = document.createElement('h2');
  heading.id = 'toolFileHeading';
  heading.textContent = 'AI 请求保存工程';
  const summary = document.createElement('p');
  summary.id = 'toolFileSummary';
  summary.style.whiteSpace = 'pre-wrap';
  summary.style.overflowWrap = 'anywhere';
  const accept = document.createElement('button');
  accept.id = 'confirmToolFile';
  accept.textContent = '确认保存';
  const reject = document.createElement('button');
  reject.id = 'cancelToolFile';
  reject.textContent = '取消';
  accept.className = 'dialog-button dialog-primary';
  reject.className = 'dialog-button';
  const header = document.createElement('header');
  header.className = 'v13-dialog-header';
  header.append(heading);
  const body = document.createElement('div');
  body.className = 'v13-dialog-body';
  body.append(summary);
  const footer = document.createElement('footer');
  footer.className = 'v13-dialog-footer';
  footer.append(reject, accept);
  dialog.append(header, body, footer);
  document.body.append(dialog);
  const failure = (): NetworkFileOutcome => ({
    status: 'error',
    diagnostics: [diagnostic('FILE_OPERATION_FAILED', '/files', '未取得真实文件回执；请查看工作台诊断。')],
  });
  const hasReceipt = (action: NetworkToolFileAction) =>
    action.kind === 'project' || (action.kind === 'save' && action.mode === 'as');
  function dismiss() {
    cancelImport?.();
    dialog.close();
    hooks.formalExport.cancelToolDrawing();
    displayed = '';
    batchArtifacts = [];
  }
  function cancel() {
    const found = displayed ? operations.status(displayed) : null;
    if (found?.ok && hasReceipt(found.value.action))
      void window.networkTools.lifecycle({ operationId: displayed, phase: 'cancelled' });
    if (displayed && !operations.cancel(displayed).ok) return;
    dismiss();
  }
  reject.addEventListener('click', cancel);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancel();
  });
  accept.addEventListener('click', () => {
    void confirm();
  });
  let pendingBatch: { id: string; artifacts: typeof batchArtifacts; path: string | null | undefined } | undefined;
  async function writeBatch(
    owner: NetworkToolFiles,
    id: string,
    base: NetworkToolBase,
    artifacts: typeof batchArtifacts,
    prior: readonly NetworkToolExportItem[],
  ) {
    const originalPath = hooks.files.currentPath;
    const items: NetworkToolExportItem[] = [];
    accept.disabled = true;
    reject.disabled = true;
    summary.textContent += '\n正在归档三份文件…';
    try {
      for (const { kind, category, artifact } of artifacts) {
        const successful = prior.find((item) => item.kind === kind && item.status === 'ok');
        if (successful) {
          items.push(successful);
          continue;
        }
        const current = hooks.base();
        if (
          operations !== owner ||
          originalPath !== hooks.files.currentPath ||
          current.documentSessionId !== base.documentSessionId ||
          current.revision !== base.revision ||
          current.physicsRevision !== base.physicsRevision
        ) {
          items.push({
            kind,
            status: 'skipped',
            diagnostics: [diagnostic('RESPONSE_STALE', '/files', '连接或工程已变化，未继续写入此文件。')],
          });
          continue;
        }
        let receipt: NetworkFileOutcome = failure();
        try {
          await hooks.files.writeArtifact(artifact, category, 'project', (outcome) => {
            receipt = outcome;
          });
        } catch {
          receipt = failure();
        }
        if (
          receipt.status === 'ok' &&
          receipt.operation === 'export' &&
          receipt.sessionId === base.documentSessionId &&
          receipt.snapshotId === artifact.snapshotId
        ) {
          items.push({
            kind,
            status: 'ok',
            path: receipt.path,
            requestId: receipt.requestId,
            snapshotId: receipt.snapshotId,
          });
        } else {
          items.push({
            kind,
            status: 'failed',
            diagnostics:
              receipt.status === 'error'
                ? receipt.diagnostics
                : [diagnostic('EXPORT_RECEIPT_MISSING', '/files', '未取得匹配的归档回执。')],
          });
        }
      }
    } finally {
      owner.completeBatch(id, items);
      if (operations === owner) {
        if (items.some((item) => item.status !== 'ok')) pendingBatch = { id, artifacts, path: originalPath };
        else if (pendingBatch?.id === id) pendingBatch = undefined;
        accept.disabled = false;
        reject.disabled = false;
        if (displayed === id) dismiss();
      }
    }
  }
  function retryBatch(id: string, key: string) {
    const owner = operations,
      cached = pendingBatch;
    const previous = owner.status(id);
    if (!previous.ok) return previous;
    const { action, outcome } = previous.value;
    const items = outcome && 'items' in outcome ? outcome.items : [];
    const result = owner.retryBatch(id, key, hooks.base(), () => {
      if (
        !cached ||
        cached.id !== id ||
        cached.path !== hooks.files.currentPath ||
        !items.length ||
        action.kind !== 'export-batch'
      )
        return {
          ok: false,
          diagnostics: [diagnostic('EXPORT_SOURCE_EXPIRED', '/files', '原归档来源已失效，请重新取得曲线和计算结果。')],
        };
      if (hooks.files.busy) return { ok: false, diagnostics: [diagnostic('FILE_BUSY', '/files', '文件正在写入。')] };
      if (items.some((item) => item.kind === 'book' && item.status !== 'ok')) {
        const book = hooks.calculation({
          kind: 'book',
          calculationId: action.calculationId,
          recordSelection: { kind: 'current' },
          format: 'docx',
          destination: 'project',
        });
        if (!book.ok)
          return {
            ok: false,
            diagnostics: [diagnostic('EXPORT_SOURCE_EXPIRED', '/files', '原计算结果已失效，请重新计算。')],
          };
      }
      return { ok: true, value: true };
    });
    if (!result.ok) return result;
    if (result.value.started && cached) void writeBatch(owner, id, previous.value.base, cached.artifacts, items);
    return owner.status(id);
  }
  async function confirm() {
    const id = displayed,
      owner = operations;
    const found = owner.status(id);
    const saveAs = found.ok && found.value.action.kind === 'save' && found.value.action.mode === 'as';
    const result = owner.confirm(id, hooks.base());
    if (result.ok && result.value.action.kind === 'export-batch') {
      await writeBatch(owner, id, result.value.base, batchArtifacts, []);
      return;
    }
    if (result.ok && result.value.action.kind === 'curve-import') {
      accept.disabled = true;
      // Selection and read may be cancelled; the result cannot be installed after retirement.
      try {
        const file = await chooseCurveFile();
        const reading = () => {
          const row = owner.status(id);
          return operations === owner && row.ok && row.value.state === 'reading';
        };
        if (!reading()) return;
        if (!file) {
          owner.complete(id, { status: 'cancelled' });
          return;
        }
        if (file.size > 4_000_000) {
          owner.complete(id, {
            status: 'error',
            diagnostics: [
              diagnostic('RESOURCE_LIMIT', '/curveFile', '曲线文件超过4,000,000字节；当前工程与记录保留。'),
            ],
          });
          return;
        }
        const text = await file.text();
        if (!reading()) return;
        if (new TextEncoder().encode(text).byteLength > 4_000_000) {
          owner.complete(id, {
            status: 'error',
            diagnostics: [diagnostic('RESOURCE_LIMIT', '/curveFile', '实际读取超过4,000,000字节。')],
          });
          return;
        }
        const raw: unknown = JSON.parse(text);
        const imported = hooks.importCurve(raw, result.value.base);
        if (imported.ok) owner.completeImport(id, imported.value);
        else owner.complete(id, { status: 'error', diagnostics: imported.diagnostics });
      } catch {
        owner.complete(id, {
          status: 'error',
          diagnostics: [diagnostic('CURVE_FILE_INVALID', '/curveFile', '曲线文件无法读取或格式无效；原有结果保持。')],
        });
      } finally {
        if (displayed === id) {
          accept.disabled = false;
          reject.disabled = false;
          dismiss();
        }
      }
      return;
    }
    if (result.ok && result.value.action.kind === 'project') {
      accept.disabled = true;
      reject.disabled = true;
      const action = result.value.action;
      let started = false;
      let recoveryUnavailable = false;
      const transition: NetworkProjectTransition = {
        beforeStart: async (sessionId, requestId) => {
          const base = hooks.base();
          if (
            base.documentSessionId !== result.value.base.documentSessionId ||
            base.revision !== result.value.base.revision ||
            base.physicsRevision !== result.value.base.physicsRevision
          )
            return false;
          started = await window.networkTools.lifecycle({
            operationId: id,
            phase: 'transition',
            targetSessionId: sessionId,
            requestId,
          });
          return started;
        },
        adopted: (sessionId, requestId) =>
          window.networkTools.lifecycle({ operationId: id, phase: 'adopted', targetSessionId: sessionId, requestId }),
      };
      void (async () => {
        const recovery = action.mode === 'restore' ? await hooks.recovery.read(action.recoveryId) : null;
        if (recovery && !recovery.ok) {
          recoveryUnavailable = true;
          owner.complete(id, { status: 'error', diagnostics: recovery.diagnostics });
          return;
        }
        await hooks.enqueue(async () => {
          if (action.mode === 'new') await hooks.files.fresh(transition);
          else if (action.mode === 'restore' && recovery?.ok)
            await hooks.files.restoreRecovery(recovery.value, transition);
          else await hooks.files.open('interactive', transition, action.mode === 'import');
        });
      })()
        .catch(() => owner.complete(id, failure()))
        .finally(() => {
          // A started operation is owned by the host; no renderer failure may turn an uncertain effect into a safe retry.
          void window.networkTools.lifecycle({
            operationId: id,
            phase: recoveryUnavailable ? 'recovery-unavailable' : started ? 'settled' : 'cancelled',
          });
          if (!started) owner.complete(id, { status: 'cancelled' });
          else owner.complete(id, failure());
          accept.disabled = false;
          reject.disabled = false;
          if (displayed === id) dismiss();
        });
      return;
    }
    if (!result.ok || (result.value.action.kind !== 'save' && result.value.action.kind !== 'curve')) {
      if (saveAs) void window.networkTools.lifecycle({ operationId: id, phase: 'settled' });
      dismiss();
      return;
    }
    accept.disabled = true;
    reject.disabled = true;
    let observed = false;
    const observe = (outcome: NetworkFileOutcome) => {
      observed = true;
      owner.complete(id, outcome);
    };
    const action = result.value.action;
    const curve = action.kind === 'curve' ? hooks.curve(action) : null;
    if (curve && !curve.ok) {
      owner.complete(id, { status: 'error', diagnostics: curve.diagnostics });
      accept.disabled = false;
      reject.disabled = false;
      dismiss();
      return;
    }
    const pending =
      action.kind === 'curve' && curve?.ok
        ? hooks.files.writeArtifact(
            curve.value.artifact,
            action.format === 'csv' ? 'data' : 'curves',
            action.destination,
            observe,
          )
        : hooks.files.save(
            saveAs,
            observe,
            saveAs
              ? (capture) =>
                  window.networkTools.lifecycle({ operationId: id, phase: 'writing', requestId: capture.requestId })
              : undefined,
          );
    void pending
      .catch(() => {
        if (!observed) owner.complete(id, failure());
      })
      .finally(() => {
        if (saveAs) void window.networkTools.lifecycle({ operationId: id, phase: 'settled' });
        if (!observed) owner.complete(id, failure());
        accept.disabled = false;
        reject.disabled = false;
        if (displayed === id) dismiss();
      });
  }
  async function prepare(params: {
    readonly base: NetworkToolBase;
    readonly operationKey: string;
    readonly action: NetworkToolFileAction;
  }) {
    const owner = operations;
    owner.invalidate(hooks.base());
    const replay = owner.replay(params.base, params.operationKey, params.action);
    if (replay) return replay;
    if (params.action.kind === 'drawing' || params.action.kind === 'export-batch') await document.fonts.ready;
    if (owner !== operations)
      return { ok: false as const, diagnostics: [diagnostic('RESPONSE_STALE', '/files', '连接已变化。')] };
    const batch = params.action.kind === 'export-batch' ? params.action : null;
    const archive = batch || ('destination' in params.action && params.action.destination === 'project');
    if (archive && !hooks.files.currentPath?.toLowerCase().endsWith('.hydproj'))
      return {
        ok: false as const,
        diagnostics: [
          diagnostic('FILE_TARGET_REQUIRED', '/files', '自动归档需要文件夹工程，请先保存工程或指定外部导出位置。'),
        ],
      };
    const recovery =
      params.action.kind === 'project' && params.action.mode === 'restore' ? await hooks.recovery.summaries() : null;
    if (recovery && !recovery.ok) return recovery;
    const recoveryId =
      params.action.kind === 'project' && params.action.mode === 'restore' ? params.action.recoveryId : '';
    const selectedCopy = recovery?.ok ? recovery.value.find((row) => row.id === recoveryId) : undefined;
    if (recoveryId && !selectedCopy)
      return {
        ok: false as const,
        diagnostics: [diagnostic('RECOVERY_NOT_FOUND', '/recovery', '所选副本已不存在，请重新读取本机副本列表。')],
      };
    if (params.action.kind === 'save' && params.action.mode === 'current' && !hooks.files.currentPath)
      return {
        ok: false as const,
        diagnostics: [
          diagnostic('FILE_TARGET_REQUIRED', '/files', '当前工程没有已绑定保存位置；请先在工作台保存并重新开启连接。'),
        ],
      };
    const curve = batch
      ? hooks.curve({
          kind: 'curve',
          curveId: batch.curveId,
          segment: batch.segment,
          format: 'csv',
          destination: 'project',
        })
      : params.action.kind === 'curve'
        ? hooks.curve(params.action)
        : null;
    if (curve && !curve.ok) return curve;
    const catalog = params.action.kind === 'catalog' ? hooks.catalog(params.action) : null;
    if (catalog && !catalog.ok) return catalog;
    const book = batch
      ? hooks.calculation({
          kind: 'book',
          calculationId: batch.calculationId,
          recordSelection: { kind: 'current' },
          format: 'docx',
          destination: 'project',
        })
      : params.action.kind === 'book'
        ? hooks.calculation(params.action)
        : null;
    if (book && !book.ok) return book;
    owner.invalidate(hooks.base());
    const prior = displayed ? owner.status(displayed) : null;
    if (
      prior?.ok &&
      prior.value.state !== 'awaiting-confirmation' &&
      prior.value.state !== 'writing' &&
      prior.value.state !== 'reading'
    )
      dismiss();
    const result = owner.prepare(params.base, hooks.base(), params.operationKey, params.action, hooks.uid('file'));
    if (!result.ok || result.value.state !== 'awaiting-confirmation' || displayed === result.value.operationId)
      return result;
    const id = result.value.operationId;
    if (hooks.files.busy) {
      owner.cancel(id);
      return { ok: false as const, diagnostics: [diagnostic('FILE_BUSY', '/files', '文件操作正在进行。')] };
    }
    displayed = id;
    accept.disabled = false;
    reject.disabled = false;
    if (params.action.kind === 'export-batch') {
      if (!book?.ok || !curve?.ok) {
        owner.cancel(id);
        dismiss();
        return {
          ok: false as const,
          diagnostics: [diagnostic('EXPORT_SOURCE_MISSING', '/files', '批量导出缺少冻结来源。')],
        };
      }
      const prepared = hooks.formalExport.prepareToolBatch(book.value);
      if (!prepared.ok) {
        owner.cancel(id);
        dismiss();
        return prepared;
      }
      const { drawing, book: word, paper, orientation } = prepared.value;
      batchArtifacts = [
        { kind: 'drawing', category: 'drawings', artifact: drawing },
        { kind: 'curve', category: 'data', artifact: curve.value.artifact },
        { kind: 'book', category: 'calculations', artifact: word },
      ];
      heading.textContent = 'AI 请求批量导出三份文件';
      accept.textContent = '确认导出全部三份';
      summary.textContent = [
        hooks.editor().document.title + ' · 修订 ' + params.base.revision,
        '工程归档：' + hooks.files.currentPath,
        '原理图 / ' + drawing.suggestedName + ' · ' + paper + ' · ' + (orientation === 'landscape' ? '横向' : '竖向'),
        '数据 / ' +
          curve.value.artifact.suggestedName +
          ' · 分段 ' +
          (params.action.segment + 1) +
          ' · ' +
          curve.value.summary,
        '计算书 / ' + word.suggestedName + ' · 当前设计 · ' + params.action.calculationId,
        '同名自动编号。每份文件都有独立回执。',
      ].join('\n');
      void confirm();
    } else if (params.action.kind === 'curve-import') {
      heading.textContent = 'AI 请求导入冻结曲线文件';
      accept.textContent = '确认选择文件';
      summary.textContent =
        '确认后在本机选择曲线数据文件（最多4,000,000字节）。仅读取和保留冻结样本，不修改工程、推进仿真或补造运行身份；导出仍须另行确认。';
      dialog.showModal();
    } else if (params.action.kind === 'project') {
      const label = { open: '打开', new: '新建', import: '导入副本', restore: '恢复副本' }[params.action.mode];
      heading.textContent = 'AI 请求' + label + '工程';
      accept.textContent = '确认' + label;
      summary.textContent =
        '当前工程：' +
        hooks.editor().document.title +
        ' · 修订 ' +
        params.base.revision +
        '\n操作：' +
        label +
        '\n目标：' +
        (selectedCopy
          ? selectedCopy.title + ' · ' + selectedCopy.capturedAt + ' · 修订 ' + selectedCopy.revision
          : params.action.mode === 'new'
            ? '新建空白工程，确认后在本机选择新位置；同名工程不会覆盖'
            : '确认后在本机选择文件（保留源文件）') +
        (params.action.mode === 'import' || params.action.mode === 'restore'
          ? '\n采用后为未保存副本，须另存为新工程。'
          : '') +
        '\n当前未保存内容需要再次确认放弃。切换后旧连接和候选立即退役。新工程沿用本次工作台工具栏的 AI 开关状态。';
      dialog.showModal();
    } else if (params.action.kind === 'curve' && curve?.ok) {
      accept.textContent = '确认导出';
      heading.textContent = 'AI 请求导出冻结曲线';
      summary.textContent =
        hooks.editor().document.title +
        ' · 修订 ' +
        params.base.revision +
        '\n' +
        curve.value.summary +
        '\n曲线：' +
        params.action.curveId +
        '\n来源：' +
        curve.value.artifact.snapshotId +
        '\n格式：' +
        params.action.format.toUpperCase() +
        (params.action.format === 'csv' ? ' · 分段 ' + (params.action.segment + 1) : '') +
        '\n文件：' +
        curve.value.artifact.suggestedName +
        '\n目标：' +
        (params.action.destination === 'project' ? '工程归档目录（自动编号）' : '确认后在本机选择位置') +
        '\n只导出此冻结来源，不更新工程、不覆盖既有结果身份。';
      if (archive) void confirm();
      else dialog.showModal();
    } else if (params.action.kind === 'save') {
      accept.textContent = '确认保存';
      heading.textContent = params.action.mode === 'as' ? 'AI 请求另存工程' : 'AI 请求保存工程';
      const target =
        params.action.mode !== 'as' && hooks.files.currentPath
          ? hooks.files.currentPath
          : '确认后由本机文件选择器选择新位置（不会覆盖已有工程）';
      summary.textContent =
        hooks.editor().document.title +
        ' · 修订 ' +
        params.base.revision +
        '\n目标：' +
        target +
        '\n保存本次工程内容；已有文件受冲突检查保护。';
      dialog.showModal();
    } else if (params.action.kind !== 'curve') {
      const action = params.action;
      if (archive) {
        const prepared =
          action.kind === 'drawing'
            ? hooks.formalExport.prepareToolDrawing(action.format)
            : action.kind === 'catalog' && catalog?.ok
              ? hooks.formalExport.prepareToolCatalog(catalog.value, action.format)
              : action.kind === 'book' && book?.ok
                ? hooks.formalExport.prepareToolBook(book.value, action.format)
                : null;
        if (!prepared?.ok) {
          owner.cancel(id);
          displayed = '';
          return (
            prepared ?? {
              ok: false as const,
              diagnostics: [diagnostic('EXPORT_SOURCE_MISSING', '/files', '导出来源已失效。')],
            }
          );
        }
        const ready = owner.confirm(id, hooks.base());
        if (!ready.ok) {
          displayed = '';
          return ready;
        }
        const artifact = 'drawing' in prepared.value ? prepared.value.drawing : prepared.value;
        let observed = false;
        void hooks.files
          .writeArtifact(artifact, action.kind === 'drawing' ? 'drawings' : 'calculations', 'project', (receipt) => {
            observed = true;
            owner.complete(id, receipt);
          })
          .catch(() => {
            if (!observed) {
              observed = true;
              owner.complete(id, failure());
            }
          })
          .finally(() => {
            if (!observed) owner.complete(id, failure());
            if (displayed === id) displayed = '';
          });
        return owner.status(id);
      }
      const observer = {
        starting: () => {
          if (
            (action.kind === 'book' && !hooks.calculation(action).ok) ||
            (action.kind === 'catalog' && !hooks.catalog(action).ok)
          ) {
            owner.cancel(id);
            return false;
          }
          return owner.confirm(id, hooks.base()).ok;
        },
        finished: (outcome: NetworkFileOutcome) => owner.complete(id, outcome),
        closed: () => {
          owner.invalidate(hooks.base());
          owner.cancel(id);
          if (displayed === id) displayed = '';
        },
      };
      const opened =
        action.kind === 'catalog'
          ? catalog?.ok &&
            hooks.formalExport.openToolCatalog(catalog.value, action.format, action.destination, observer)
          : action.kind === 'book'
            ? book?.ok && hooks.formalExport.openToolBook(book.value, action.format, action.destination, observer)
            : hooks.formalExport.openToolDrawing(action.format, action.destination, observer);
      if (!opened) {
        owner.cancel(id);
        displayed = '';
        return {
          ok: false as const,
          diagnostics: [diagnostic('FILE_BUSY', '/files', '导出窗口已打开，请先完成或取消。')],
        };
      }
    }
    return owner.status(id);
  }
  return {
    prepare,
    retryBatch,
    status(id: string) {
      this.render();
      return operations.status(id);
    },
    cancel(id: string) {
      const found = operations.status(id);
      if (found.ok && found.value.state === 'awaiting-confirmation' && hasReceipt(found.value.action))
        void window.networkTools.lifecycle({ operationId: id, phase: 'cancelled' });
      const result = operations.cancel(id);
      if (result.ok && displayed === id) dismiss();
      return result;
    },
    render() {
      operations.invalidate(hooks.base());
      if (displayed) {
        const found = operations.status(displayed);
        if (
          found.ok &&
          found.value.state !== 'awaiting-confirmation' &&
          found.value.state !== 'writing' &&
          found.value.state !== 'reading'
        ) {
          if (found.value.state === 'stale' && hasReceipt(found.value.action))
            void window.networkTools.lifecycle({ operationId: displayed, phase: 'stale' });
          dismiss();
        }
      }
    },
    retire() {
      operations.invalidate(null);
      dismiss();
      pendingBatch = undefined;
      operations = new NetworkToolFiles();
    },
  };
}
