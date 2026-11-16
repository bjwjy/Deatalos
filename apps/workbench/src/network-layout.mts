import {
  previewNetworkLayoutAsync,
  parseServiceResult,
  type NetworkDraftSession,
  type NetworkLayoutPreview,
} from '@hyd/application';
import { ContractReader, diagnostic, type DisplayDiagnostic, type NetworkProject, type Result } from '@hyd/domain';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import { element } from './network-dom.mjs';
interface LayoutHooks {
  editor(): NetworkDraftSession;
  canvas: NetworkCanvas;
  apply(preview: NetworkLayoutPreview): boolean;
  diagnostics(items: readonly DisplayDiagnostic[]): void;
  notify(message: string): void;
}
/** Explicit one-shot commands share the existing layout transaction; neither changes the viewport. */
export function createNetworkLayout(hooks: LayoutHooks) {
  const root = element('layoutTools');
  root.innerHTML =
    '<summary>自动理线</summary><p id="layoutStatus" role="status"></p><button id="applyRouting">整理自动连线（Ctrl+Shift+L）</button><p class="muted">Ctrl+Shift+L仅整理自动连线，不满意可一次撤销。元件、分支节点和手动线路保持原位；保留实际管长和运行结果。顶部“整理”同时整理元件与连线，包含重建手动线路。避障受阻时调整遮挡元件，或拖动管线中点手动修补。</p>';
  let owner: NetworkDraftSession | null = null;
  type Job = {
    readonly editor: NetworkDraftSession;
    readonly revision: number;
    readonly document: NetworkProject;
    readonly kind: 'routing' | 'arrangement';
    readonly worker: Worker;
    settle?: (reply: Result<unknown>) => void;
    timer?: ReturnType<typeof setTimeout>;
  };
  let active: Job | undefined;
  const failure = (message: string): Extract<Result<never>, { readonly ok: false }> => ({
    ok: false,
    diagnostics: [diagnostic('LAYOUT_FAILED', '/layoutOperation', message)],
  });
  function dispose(job: Job): void {
    clearTimeout(job.timer);
    job.worker.onmessage = null;
    job.worker.onerror = null;
    job.worker.onmessageerror = null;
    job.worker.terminate();
  }
  function busy(): void {
    const arrangeButton = element('arrangeComponents');
    const arranging = active?.kind === 'arrangement';
    const label = arranging ? '正在整理，点击取消' : '整理';
    arrangeButton.setAttribute('aria-busy', String(arranging));
    arrangeButton.setAttribute('aria-label', label);
    arrangeButton.dataset.tip = arranging ? label : '整理元件与连线（含手动线路）；可一次撤销';
    element('applyRouting').setAttribute('aria-busy', String(active?.kind === 'routing'));
  }
  function cancel(message: string): void {
    const job = active;
    if (!job) return;
    active = undefined;
    dispose(job);
    job.settle?.(failure(message));
    delete job.settle;
    busy();
    status(message);
    hooks.notify(message);
  }
  function status(message: string): void {
    if (element('layoutStatus').textContent !== message) element('layoutStatus').textContent = message;
  }
  async function execute(kind: 'routing' | 'arrangement'): Promise<void> {
    const name = kind === 'arrangement' ? '元件整理' : '自动布线';
    if (active?.kind === kind) {
      cancel('已取消' + name + '，工程保持。');
      return;
    }
    if (active) cancel('已取消上一次整理。');
    if (!hooks.canvas.editable) {
      status('请先完成或取消当前编辑操作。');
      hooks.notify('请先完成或取消当前编辑操作。');
      return;
    }
    const editor = hooks.editor();
    let job: Job | undefined;
    try {
      const worker = new Worker('./network-layout-worker.mjs', { type: 'module' });
      job = { editor, revision: editor.revision, document: editor.document, kind, worker };
      const current = job;
      active = current;
      busy();
      const progress = (kind === 'arrangement' ? '正在整理元件' : '正在整理自动连线') + '…再次点击同一按钮可取消。';
      status(progress);
      hooks.notify(progress);
      const result = await previewNetworkLayoutAsync(
        editor,
        kind === 'routing' ? { kind, connectionIds: null } : { kind },
        {
          plan: (document, request) =>
            new Promise((resolve) => {
              current.settle = resolve;
              const settle = (reply: Result<unknown>) => {
                current.settle?.(reply);
                delete current.settle;
              };
              worker.onmessage = (event: MessageEvent<unknown>) => {
                const r = new ContractReader(),
                  o = r.object(event.data, '/layoutWorker', ['version', 'documentSessionId', 'revision', 'result']);
                r.constant(o.version, 1, '/layoutWorker/version');
                const session = r.id(o.documentSessionId, '/layoutWorker/documentSessionId'),
                  revision = r.number(o.revision, '/layoutWorker/revision', 0, Number.MAX_SAFE_INTEGER);
                const envelope = r.finish({ session, revision });
                if (!envelope.ok || session !== editor.documentSessionId || revision !== current.revision) {
                  settle(failure('后台整理回复的版本、会话或修订不匹配，未应用。'));
                  return;
                }
                settle(parseServiceResult(o.result));
              };
              worker.onerror = () => settle(failure('后台整理失败，工程和视图保持。'));
              worker.onmessageerror = () => settle(failure('后台整理回复无法读取，工程保持。'));
              current.timer = setTimeout(
                () => settle(failure('后台整理超过120秒，请缩小回路后重试；工程保持。')),
                120000,
              );
              worker.postMessage({
                version: 1,
                documentSessionId: editor.documentSessionId,
                revision: current.revision,
                document,
                request,
              });
            }),
        },
      );
      if (active !== current) return;
      active = undefined;
      busy();
      if (
        hooks.editor() !== editor ||
        editor.document !== current.document ||
        editor.revision !== current.revision ||
        !hooks.canvas.editable
      ) {
        status('工程或编辑操作已改变，本次整理未应用。');
        hooks.notify('工程或编辑操作已改变，本次整理未应用。');
        return;
      }
      if (!result.ok) {
        hooks.diagnostics(result.diagnostics);
        status(name + '失败：' + result.diagnostics.map((item) => item.message).join('；'));
        hooks.notify(name + '失败，请查看诊断；工程和视图保持。');
        return;
      }
      if (!result.value.plan.changedIds.length) {
        status(kind === 'arrangement' ? '当前元件布局无需整理。' : '当前自动连线无需整理；手动路径保持。');
        hooks.notify(kind === 'arrangement' ? '当前元件布局无需整理。' : '当前自动连线无需整理；手动路径保持。');
        return;
      }
      if (hooks.apply(result.value)) {
        status(name + '完成，不满意可以撤回。');
        hooks.notify(name + '完成，不满意可以撤回。');
      } else status(name + '未应用，请查看诊断；工程和视图保持。');
    } catch (cause: unknown) {
      if (job && active !== job) return;
      active = undefined;
      busy();
      const failed = failure(name + '未完成：' + String(cause).slice(0, 200));
      hooks.diagnostics(failed.diagnostics);
      status(name + '未完成，工程保持。');
      hooks.notify(name + '未完成，工程保持。');
    } finally {
      if (job) dispose(job);
    }
  }
  element('applyRouting').addEventListener('click', () => void execute('routing'));
  element('arrangeComponents').addEventListener('click', () => void execute('arrangement'));
  document.addEventListener('keydown', (event) => {
    if (
      !event.ctrlKey ||
      !event.shiftKey ||
      event.key.toLowerCase() !== 'l' ||
      event.altKey ||
      event.metaKey ||
      event.repeat ||
      event.isComposing ||
      event.defaultPrevented
    )
      return;
    const target = event.target instanceof Element ? event.target : null;
    if (
      target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]') ||
      document.querySelector('dialog[open]') ||
      document.querySelector('main')?.inert
    )
      return;
    event.preventDefault();
    void execute('routing');
  });
  return {
    render() {
      if (
        active &&
        (active.editor !== hooks.editor() ||
          active.document !== hooks.editor().document ||
          active.revision !== hooks.editor().revision)
      )
        cancel('工程已改变，已取消旧整理；当前工程保持。');
      if (owner === hooks.editor()) return;
      owner = hooks.editor();
      status('');
    },
  };
}
