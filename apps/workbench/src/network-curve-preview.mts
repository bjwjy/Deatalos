import { parseExportArtifact, type CurveRequest, type NetworkExportCapture } from '@hyd/application';
import { ContractReader, networkObjectDisplayName } from '@hyd/domain';
import { createSidebarProjection } from './network-sidebar-series.mjs';
import { element, escapeHtml } from './network-dom.mjs';
interface Hooks {
  capture(): NetworkExportCapture | null;
  refresh(): Promise<NetworkExportCapture | null>;
  refreshLive(): Promise<void>;
  running(): boolean;
}
/** A projection of the same frozen capture used by the data panel and export window. */
export function createNetworkCurvePreview(hooks: Hooks) {
  const control = element('curveQuantity');
  if (!(control instanceof HTMLSelectElement)) throw new Error('Sidebar curve selector missing');
  const select = control;
  const preview = element('curve');
  const status = element('curveStatus');
  const projectSeries = createSidebarProjection();
  let display:
    { capture: NetworkExportCapture; target: CurveRequest['target']; toS: number; title: string } | undefined;
  let idleWorker: Worker | undefined;
  let cancelDraw: (() => void) | undefined;
  let lastCapture: NetworkExportCapture | null | undefined = undefined,
    lastTarget = '';
  let optionMarkup: string | undefined;
  let reading = false,
    wasRunning = false;
  let refreshTimer: number | undefined;
  let period = 0;
  let drawn: { display: typeof display; width: number; height: number } | undefined;
  function refresh(live = false): void {
    if (reading) return;
    reading = true;
    element('refreshCurvePreview').setAttribute('disabled', '');
    void (live ? hooks.refreshLive() : hooks.refresh())
      .then(render)
      .catch((cause: unknown) => {
        element('curveStatus').textContent = '读取失败：' + String(cause).slice(0, 150);
      })
      .finally(() => {
        reading = false;
        element('refreshCurvePreview').removeAttribute('disabled');
      });
  }
  function refreshPeriod() {
    if (document.hidden || document.documentElement.dataset.inspectorOpen === 'false') return 0;
    const open = (id: string) => {
      const panel = element(id).closest<HTMLElement>('.status-panel');
      return panel && !panel.hidden && panel.dataset.collapsed !== 'true';
    };
    if (open('sidebarCurve')) return 500;
    return open('shortcutResults') ? 2000 : 0;
  }
  function render() {
    const capture = hooks.capture();
    const running = hooks.running();
    const visiblePeriod = refreshPeriod();
    const nextPeriod = running && capture ? visiblePeriod : 0;
    if (nextPeriod !== period) {
      window.clearInterval(refreshTimer);
      period = nextPeriod;
      if (period) {
        // Schedule from the start of each interval. A busy capture or draw skips
        // the tick so a slow circuit cannot accumulate work on the UI thread.
        refreshTimer = window.setInterval(() => {
          if (hooks.running() && hooks.capture() && refreshPeriod() === period && !reading && !cancelDraw)
            refresh(true);
        }, period);
      }
    }
    const needsFinal = wasRunning && !running;
    wasRunning = running;
    if (visiblePeriod && needsFinal) refresh();
    if (capture === lastCapture && select.value === lastTarget) return;
    const previous = select.value;
    if (capture !== lastCapture) {
      const markup =
        capture?.view.quantities
          .map(
            (q, i) =>
              `<option value="${i}">${escapeHtml(networkObjectDisplayName(capture.view.document, q.objectKind, q.objectId) + ' · ' + q.label)}</option>`,
          )
          .join('') ?? '<option value="">暂无可预览量值</option>';
      if (markup !== optionMarkup) {
        optionMarkup = markup;
        select.innerHTML = markup;
        const preferred = capture?.view.quantities.findIndex((q) => q.field === 'position');
        if ([...select.options].some((option) => option.value === previous)) select.value = previous;
        else if (preferred !== undefined && preferred >= 0) select.value = String(preferred);
      }
    }
    lastCapture = capture;
    lastTarget = select.value;
    const previousDisplay = display;
    cancelDraw?.();
    display = undefined;
    drawn = undefined;
    preview.classList.remove('curve-empty');
    if (!capture) {
      idleWorker?.terminate();
      idleWorker = undefined;
      stamp(null);
      status.textContent = '尚无运行记录';
      preview.classList.add('curve-empty');
      preview.innerHTML = '<span>尚无有效运行记录</span>';
      return;
    }
    const q = capture.view.quantities[Number(select.value)],
      first = capture.samples[0],
      last = capture.samples.at(-1);
    if (!q || !first || !last) {
      stamp(capture);
      preview.textContent = '';
      status.textContent = '所选量值没有实际样本。';
      return;
    }
    const target = { objectKind: q.objectKind, objectId: q.objectId, field: q.field };
    const before = previousDisplay?.target;
    if (
      previousDisplay?.capture.view.point.identity.simulationSessionId !==
        capture.view.point.identity.simulationSessionId ||
      before?.objectKind !== target.objectKind ||
      before.objectId !== target.objectId ||
      before.field !== target.field
    ) {
      stamp(null);
      preview.textContent = '';
      status.textContent = '正在整理曲线…';
    }
    display = { capture, target, toS: last.identity.timeS, title: q.label };
    draw();
  }
  function stamp(capture: NetworkExportCapture | null): void {
    status.dataset.simulationSessionId = capture?.view.point.identity.simulationSessionId ?? '';
    status.dataset.tick = capture ? String(capture.view.point.identity.tick) : '';
    status.dataset.snapshotId = capture?.snapshotId ?? '';
  }
  function draw(): void {
    const width = preview.clientWidth,
      height = preview.clientHeight;
    if (!display || width < 120 || height < 100) return;
    if (drawn?.display === display && drawn.width === width && drawn.height === height) return;
    cancelDraw?.();
    const job = display;
    const { capture, target, title } = job;
    drawn = { display, width, height };
    const current = () => display === job && hooks.capture() === capture && select.value === lastTarget;
    const reportFailure = (message: string) => {
      if (current()) status.textContent = message;
    };
    let task: Worker;
    try {
      task = idleWorker ?? new Worker('./network-curve-worker.mjs', { type: 'module' });
      idleWorker = undefined;
    } catch {
      reportFailure('曲线整理线程无法启动，保留已显示的曲线。');
      return;
    }
    const finish = (reuse = false) => {
      task.onmessage = null;
      task.onerror = null;
      if (reuse) idleWorker = task;
      else task.terminate();
      window.clearTimeout(timer);
      if (cancelDraw === finish) cancelDraw = undefined;
    };
    const timer = window.setTimeout(() => {
      finish();
      reportFailure('曲线整理超过30秒，保留已显示的曲线。');
    }, 30000);
    cancelDraw = finish;
    task.onmessage = (event: MessageEvent<unknown>) => {
      const accepted = cancelDraw === finish && current();
      finish(accepted);
      if (!accepted) return;
      const r = new ContractReader(),
        reply = r.object(event.data, '', ['status', 'artifact', 'message']);
      if (reply.status === 'error') {
        const message = r.finish(r.text(reply.message, '/message', 1, 3000));
        reportFailure(message.ok ? message.value : '曲线整理失败，保留已显示的曲线。');
        return;
      }
      r.constant(reply.status, 'sidebar', '/status');
      const svg = parseExportArtifact(reply.artifact);
      if (!r.finish(true).ok || !svg.ok || svg.value.format !== 'svg' || svg.value.snapshotId !== capture.snapshotId) {
        reportFailure('曲线预览响应无效，保留已显示的曲线。');
        return;
      }
      preview.innerHTML = svg.value.text;
      stamp(capture);
      status.textContent = `${capture.selection === 'history' ? '历史记录 · ' : ''}读取至 ${job.toS.toPrecision(5)} s`;
    };
    task.onerror = () => {
      const accepted = cancelDraw === finish;
      finish();
      if (accepted) reportFailure('曲线整理失败，保留已显示的曲线。');
    };
    const active = () => cancelDraw === finish && current();
    void projectSeries(capture, target, active)
      .then((series) => {
        if (!series || !active()) return;
        task.postMessage(
          { mode: 'sidebar', ...series, title, snapshotId: capture.snapshotId, viewport: { width, height } },
          [series.data.buffer],
        );
      })
      .catch((cause: unknown) => {
        if (!active()) return;
        finish();
        reportFailure('曲线预览读取失败：' + String(cause).slice(0, 150));
      });
  }
  new ResizeObserver(draw).observe(preview);
  select.addEventListener('change', render);
  element('refreshCurvePreview').addEventListener('click', () => refresh());
  element('curveExportSettings').addEventListener('click', () => element('openCurveTools').click());
  return {
    render,
    target() {
      const quantity = select.value === '' ? undefined : lastCapture?.view.quantities[Number(select.value)];
      return quantity
        ? { objectKind: quantity.objectKind, objectId: quantity.objectId, field: quantity.field }
        : undefined;
    },
  };
}
