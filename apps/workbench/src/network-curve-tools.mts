import {
  parseNetworkArtifact,
  parseExportArtifact,
  parseOfflineCurve,
  parseCurveFile,
  parseCurveFigureSettings,
  curveFileText,
  storedCurveCsv,
  planNetworkCurve,
  prepareCurveFile,
  exportCurveSegment,
  legacyNetworkRecordCapacity,
  networkRecordMaximum,
  utf8Bytes,
  type NetworkArtifact,
  type ExportArtifact,
  type NetworkExportCapture,
  type NetworkDraftSession,
  type CurveRequest,
  type CurveFile,
  type OfflineCurve,
  type CurveFigureSettings,
  type CurvePlan,
} from '@hyd/application';
import { ContractReader, checkJson, networkObjectDisplayName } from '@hyd/domain';
import { element, escapeHtml as esc } from './network-dom.mjs';
import type { NetworkExportDefaults } from './network-app-settings.mjs';
import {
  curveFigureSvg,
  curveGeometry,
  fitCurveScope,
  type CurveFigureOptions,
  type CurvePlot,
  type CurveViewport,
  type CurveScopeRange,
} from './network-curve-svg.mjs';
interface Hooks {
  editor(): NetworkDraftSession;
  exportDefaults(): NetworkExportDefaults;
  initialRangeSeconds(): number | null;
  capture(source?: 'current'): Promise<NetworkExportCapture | null>;
  history(projectId: string): Promise<readonly NetworkExportCapture[]>;
  preferredTarget?():
    Pick<NetworkExportCapture['view']['quantities'][number], 'objectKind' | 'objectId' | 'field'> | undefined;
  write(artifact: NetworkArtifact, category: 'curves' | 'data', destination: 'project' | 'external'): Promise<boolean>;
}
type PlotView = Pick<OfflineCurve, 'samples' | 'label' | 'unit' | 'metadata'>;
const curveExportActions = {
  pdf: 'savePdf',
  svg: 'saveSvg',
  csv: 'saveCsv',
  hydcurve: 'saveData',
} as const;
interface Preview {
  readonly svg: ExportArtifact;
  readonly csv: readonly ExportArtifact[];
  readonly plot: PlotView | null;
  readonly indices: readonly number[];
  readonly figure: CurveFigureSettings;
  readonly summary: string;
}
function input(id: string) {
  const e = element('curve-' + id);
  if (!(e instanceof HTMLInputElement)) throw new Error('Curve input missing: ' + id);
  return e;
}
function select(id: string) {
  const e = element('curve-' + id);
  if (!(e instanceof HTMLSelectElement)) throw new Error('Curve select missing: ' + id);
  return e;
}
function button(id: string) {
  const e = element('curve-' + id);
  if (!(e instanceof HTMLButtonElement)) throw new Error('Curve button missing: ' + id);
  return e;
}
function parsePreview(raw: unknown, snapshotId: string): Preview | string {
  const safe = checkJson(raw);
  if (!safe.ok) return '曲线响应超过容量或无效。';
  const r = new ContractReader(),
    o = r.object(raw, '', ['status', 'snapshotId', 'svg', 'csv', 'plot', 'indices', 'figure', 'summary']);
  r.constant(o.status, 'ok', '/status');
  r.constant(o.snapshotId, snapshotId, '/snapshotId');
  const svg = parseExportArtifact(o.svg),
    figure = parseCurveFigureSettings(o.figure),
    plot = o.plot === null ? null : parseOfflineCurve(o.plot),
    csv: ExportArtifact[] = [];
  if (
    !svg.ok ||
    svg.value.format !== 'svg' ||
    svg.value.snapshotId !== snapshotId ||
    !figure.ok ||
    (plot && (!plot.ok || plot.value.snapshotId !== snapshotId))
  )
    return '曲线响应或来源身份无效。';
  for (const raw of r.array(o.csv, '/csv', 100)) {
    const part = parseExportArtifact(raw);
    if (!part.ok || part.value.format !== 'csv' || part.value.snapshotId !== snapshotId)
      return '数据响应或来源身份无效。';
    csv.push(part.value);
  }
  const indices = r.array(o.indices, '/indices', networkRecordMaximum).map((value, i) => {
    const field = '/indices/' + i;
    const index = r.number(value, field, 0, networkRecordMaximum - 1);
    if (!Number.isSafeInteger(index)) r.fail('CURVE_INDEX_INVALID', field, '采样点序号必须为整数。');
    return index;
  });
  const result = r.finish({
    svg: svg.value,
    csv,
    plot: plot?.ok ? plot.value : null,
    indices,
    figure: figure.value,
    summary: r.text(o.summary, '/summary', 0, 2000),
  });
  return result.ok ? result.value : result.diagnostics.map((d) => d.message).join('；');
}
export function createNetworkCurveTools(hooks: Hooks) {
  const control = element('curveTools');
  if (!(control instanceof HTMLDialogElement)) throw new Error('Curve dialog missing');
  const dialog = control;
  const chart = element('curve-preview');
  const sources = new Map<string, NetworkExportCapture>();
  type Inspection = NonNullable<CurveFigureOptions['hover']>;
  let hover: Inspection | undefined;
  let comparisonKeys: CurveRequest['keys'] = [];
  let comparison: { readonly source: NetworkExportCapture; readonly plan: CurvePlan } | undefined;
  let drawnViewport: CurveViewport | undefined;
  let scope: CurveScopeRange | undefined;
  let recentViewSeconds: number | null = null;
  let scopeFrame = 0;
  let capture: NetworkExportCapture | null = null,
    loaded: CurveFile | null = null,
    owner: NetworkDraftSession | null = null,
    revision = -1,
    keys: CurveRequest['keys'] = [],
    preview: Preview | null = null,
    generation = 0,
    worker: Worker | null = null,
    timer: ReturnType<typeof setTimeout> | null = null,
    updateTimer: ReturnType<typeof setTimeout> | null = null,
    loading = false,
    saving = false;
  const status = (message: string) => {
    element('curve-toolsStatus').textContent = message;
  };
  const current = () => dialog.open && owner === hooks.editor() && revision === hooks.editor().physicsRevision;
  const figure = () =>
    parseCurveFigureSettings({
      paper: select('paper').value,
      title: input('title').value,
      showExplanation: input('explanation').checked,
    });
  const index = () => Number(select('quantity').value);
  const enableSave = (enabled: boolean) => {
    for (const id of Object.values(curveExportActions)) button(id).disabled = !enabled;
    select('destination').disabled = saving;
    select('sourceChoice').disabled = loading || saving || !sources.size;
    select('comparisonChoice').disabled = !enabled || select('comparisonChoice').options.length < 2;
    select('quickQuantity').disabled = !enabled || !select('quickQuantity').options.length;
    reflectScope();
  };
  function setLoading(active: boolean): void {
    loading = active;
    if (active) {
      element('curve-settings').setAttribute('disabled', '');
      enableSave(false);
    } else {
      element('curve-settings').removeAttribute('disabled');
      select('sourceChoice').disabled = saving || !sources.size;
    }
  }
  function stop() {
    generation++;
    worker?.terminate();
    worker = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (updateTimer !== null) clearTimeout(updateTimer);
    updateTimer = null;
  }
  function hideHover() {
    hover = undefined;
    element('curveInspectionReadout').textContent = '在绘图区移动鼠标读数，点击固定或取消。';
    element('curve-hover').hidden = true;
  }
  function invalidate(message = '设置已改变，正在自动更新…') {
    stop();
    preview = null;
    drawnViewport = undefined;
    element('curve-preview').textContent = '';
    enableSave(false);
    hideHover();
    status(message);
  }
  function scheduleUpdate(): void {
    if (saving || loading || !current()) return;
    invalidate();
    const ticket = generation;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      if (ticket === generation && current()) apply();
    }, 180);
  }
  function releaseView() {
    stop();
    setLoading(false);
    capture = null;
    loaded = null;
    owner = null;
    preview = null;
    keys = [];
    comparisonKeys = [];
    comparison = undefined;
    drawnViewport = undefined;
    scope = undefined;
    reflectScope();
    sources.clear();
    element('curve-preview').textContent = '';
    hideHover();
  }
  function close() {
    if (saving) {
      status('文件正在保存，请先完成或取消文件选择。');
      return;
    }
    releaseView();
    dialog.close();
  }
  function show() {
    if (!dialog.open) {
      owner = hooks.editor();
      revision = owner.physicsRevision;
      const defaults = hooks.exportDefaults();
      recentViewSeconds = hooks.initialRangeSeconds();
      select('destination').value = defaults.destination;
      const preferred = curveExportActions[defaults.curve];
      for (const id of Object.values(curveExportActions)) {
        const action = button(id);
        action.classList.toggle('dialog-primary', id === preferred);
        if (id === preferred) button('apply').after(action);
      }
      const shortcut = document.getElementById('shortcutCurveFormat');
      if (shortcut instanceof HTMLSelectElement) {
        shortcut.value = preferred;
        shortcut.dispatchEvent(new Event('change'));
      }
      dialog.showModal();
    }
  }
  function renderKeys() {
    element('curve-keys').innerHTML = keys
      .map(
        (k) =>
          `<div class="curve-key"><span>已固定点 · ${k.sampleIndex}</span><label>标注文字<input data-key="${k.sampleIndex}" data-field="label" maxlength="80" value="${esc(k.label)}"></label><label>水平偏移<input type="number" min="-300" max="300" data-key="${k.sampleIndex}" data-field="offsetX" value="${k.offsetX}"></label><label>垂直偏移<input type="number" min="-300" max="300" data-key="${k.sampleIndex}" data-field="offsetY" value="${k.offsetY}"></label><button data-remove-key="${k.sampleIndex}">取消固定</button></div>`,
      )
      .join('');
  }
  function renderPoints() {
    const samples = preview?.plot?.samples ?? [];
    select('point').innerHTML = samples
      .filter((p) => p.value !== null)
      .map((p) => `<option value="${p.index}">${p.timeS} s · ${p.value} ${esc(preview?.plot?.unit ?? '')}</option>`)
      .join('');
  }
  function accepted(result: Preview) {
    preview = result;
    const problem = planComparison();
    renderLegend();
    draw();
    status(problem || result.summary);
    enableSave(true);
    renderPoints();
  }
  function viewport() {
    const mode = dialog.dataset.shortcutView;
    const plot = primaryPlot();
    if (mode !== 'preview' && plot && chart.clientWidth >= 160 && chart.clientHeight >= 120)
      return {
        width: chart.clientWidth,
        height: chart.clientHeight,
        scope: scope ?? initialScope(plot),
      };
  }
  function initialScope(plot: CurvePlot): CurveScopeRange {
    const other = comparisonPlot();
    const full = fitCurveScope(plot, other);
    const last = plot.samples.at(-1)?.timeS;
    if (recentViewSeconds === null || last === undefined || last - recentViewSeconds <= full.xMin) return full;
    const from = last - recentViewSeconds;
    const visible = (series: CurvePlot) => ({
      ...series,
      samples: series.samples.filter((sample) => sample.timeS >= from && sample.timeS <= last),
    });
    return { ...fitCurveScope(visible(plot), other && visible(other)), xMin: from, xMax: last };
  }
  function label(source: string): string {
    if (source === 'current') return '当前运行';
    const capture = sources.get(source);
    if (!capture) return '已选记录';
    const time = new Date(capture.capturedAt).toLocaleString('zh-CN', { hour12: false });
    return '历史 · ' + time + ' · ' + capture.view.point.identity.simulationSessionId.slice(-6);
  }
  function primaryPlot(): CurvePlot | undefined {
    return (preview?.plot && { ...preview.plot, indices: preview.indices, keys }) || undefined;
  }
  function comparisonPlot(): CurvePlot | undefined {
    return comparison && { ...comparison.plan, keys: comparisonKeys };
  }
  function inspectionEnabled(): boolean {
    const mode = dialog.dataset.shortcutView;
    return mode !== 'preview' && (mode === 'settings' || !mode || dialog.dataset.detailsEnabled === 'true');
  }
  function figureOptions(tracking = false): CurveFigureOptions {
    const plot = comparisonPlot();
    return {
      primaryLabel: label(select('sourceChoice').value),
      ...(plot && comparison
        ? {
            comparison: {
              plot,
              label: label(select('comparisonChoice').value),
              snapshotId: comparison.source.snapshotId,
            },
          }
        : {}),
      ...(tracking && hover ? { hover } : {}),
    };
  }
  function paperSvg(): ExportArtifact | null {
    const plot = primaryPlot();
    if (!preview || !plot) return preview?.svg ?? null;
    const result = curveFigureSvg(plot, preview.figure, preview.svg.snapshotId, undefined, figureOptions());
    if (result.ok) {
      if (result.value.text.includes('data-annotation="marker"')) {
        status('出图中有固定标注找不到不遮线的位置，请减少标注或调整出图设置。');
        return null;
      }
      return result.value;
    }
    status(result.diagnostics.map((item) => item.message).join('；'));
    return null;
  }
  function draw(): void {
    if (!preview) return;
    const size = viewport();
    const plot = primaryPlot();
    const screen =
      size && plot
        ? curveFigureSvg(plot, preview.figure, preview.svg.snapshotId, size, figureOptions(inspectionEnabled()))
        : undefined;
    drawnViewport = screen?.ok ? size : undefined;
    chart.innerHTML = screen?.ok ? screen.value.text : (paperSvg()?.text ?? '');
    reflectScope();
  }
  function visibleSamples(plot: CurvePlot) {
    if (!scope && recentViewSeconds === null) return plot.samples;
    const { xMin, xMax } = scope ?? initialScope(plot);
    return plot.samples.filter((sample) => sample.timeS >= xMin && sample.timeS <= xMax);
  }
  function reflectScope(): void {
    const plot = primaryPlot();
    const samples = plot ? visibleSamples(plot) : [];
    const first = samples[0],
      last = samples.at(-1);
    button('fit').disabled = !plot || saving || loading;
    button('scopeCsv').disabled = !capture || !first || saving || loading;
    element('curve-scope-range').textContent =
      first && last
        ? `导出时间 ${Number(first.timeS.toPrecision(9))}–${Number(last.timeS.toPrecision(9))} s · ${samples.length} 个样本${capture?.record.samplesTruncated ? ' · 较早记录已截断' : ''}`
        : plot
          ? '当前视图无记录样本'
          : '';
  }
  function updateScope(next: CurveScopeRange): void {
    if (
      ![next.xMin, next.xMax, next.yMin, next.yMax].every(Number.isFinite) ||
      next.xMax <= next.xMin ||
      next.yMax <= next.yMin
    )
      return;
    scope = next;
    hideHover();
    if (!scopeFrame)
      scopeFrame = requestAnimationFrame(() => {
        scopeFrame = 0;
        if (current()) draw();
      });
  }
  new ResizeObserver(() => {
    if (viewport()) draw();
  }).observe(chart);
  new MutationObserver(draw).observe(dialog, { attributeFilter: ['data-shortcut-view'] });
  function request(): CurveRequest | null {
    const q = capture?.view.quantities[index()];
    if (!q) return null;
    return {
      target: { objectKind: q.objectKind, objectId: q.objectId, field: q.field },
      fromS: input('from').valueAsNumber,
      toS: input('to').valueAsNumber,
      maximumPoints: input('maximum').valueAsNumber,
      relativeTolerance: input('tolerance').valueAsNumber / 100,
      samplesPerFile: input('perFile').valueAsNumber,
      scope: select('scope').value === 'all' ? 'all' : 'curve',
      keys,
    };
  }
  function renderLegend(): void {
    const legend = element('curveCompareLegend');
    const names = capture ? [label(select('sourceChoice').value)] : loaded ? ['导入的曲线数据'] : [];
    if (comparison) names.push(label(select('comparisonChoice').value));
    legend.innerHTML = names.map((name, index) => `<span><i data-series="${index}"></i>${esc(name)}</span>`).join('');
  }
  function planComparison(): string {
    comparison = undefined;
    const source = sources.get(select('comparisonChoice').value);
    const req = request();
    const first = source?.samples[0],
      last = source?.samples.at(-1);
    if (!source || !req || !first || !last || !preview?.plot) return '';
    const primaryStart = capture?.samples[0]?.identity.timeS;
    const primaryEnd = capture?.samples.at(-1)?.identity.timeS;
    const full = req.fromS === primaryStart && req.toS === primaryEnd;
    const candidate = planNetworkCurve(source, {
      ...req,
      fromS: full ? first.identity.timeS : Math.max(req.fromS, first.identity.timeS),
      toS: full ? last.identity.timeS : Math.min(req.toS, last.identity.timeS),
      scope: 'curve',
      keys: comparisonKeys,
    });
    if (!candidate.ok || candidate.value.unit !== preview.plot.unit) {
      select('comparisonChoice').value = '';
      comparisonKeys = [];
      return !candidate.ok
        ? '无法叠加：' + candidate.diagnostics.map((item) => item.message).join('；')
        : '无法叠加：所选运行的量值单位不同。';
    }
    comparison = { source, plan: candidate.value };
    return '';
  }
  function sourceChoices(primary: string, secondary = ''): void {
    const options = [...sources.keys()];
    const main = select('sourceChoice'),
      compare = select('comparisonChoice');
    main.replaceChildren(...options.map((id) => new Option(label(id), id)));
    if (!options.length) main.add(new Option('暂无运行记录', ''));
    main.value = options.includes(primary) ? primary : (options[0] ?? '');
    compare.replaceChildren(
      new Option('不叠加', ''),
      ...options.filter((id) => id !== main.value).map((id) => new Option(label(id), id)),
    );
    compare.value = [...compare.options].some((option) => option.value === secondary) ? secondary : '';
    main.disabled = !options.length;
    compare.disabled = compare.options.length < 2;
  }
  function installCapture(result: NetworkExportCapture, preferred?: CurveRequest['target']): void {
    const first = result.samples[0],
      last = result.samples.at(-1);
    if (!first || !last) {
      status('当前没有实际样本。');
      return;
    }
    capture = result;
    scope = undefined;
    loaded = null;
    keys = [];
    comparisonKeys = [];
    comparison = undefined;
    const quantities = select('quantity');
    quantities.replaceChildren(
      ...result.view.quantities.map(
        (q, i) =>
          new Option(
            networkObjectDisplayName(result.view.document, q.objectKind, q.objectId) + ' · ' + q.label,
            String(i),
          ),
      ),
    );
    const chosen = result.view.quantities.findIndex((q) =>
      preferred
        ? q.objectKind === preferred.objectKind && q.objectId === preferred.objectId && q.field === preferred.field
        : q.field === 'position',
    );
    if (chosen >= 0) quantities.value = String(chosen);
    const quick = select('quickQuantity');
    quick.replaceChildren(...[...quantities.options].map((option) => new Option(option.text, option.value)));
    quick.value = quantities.value;
    quick.disabled = !quick.options.length;
    input('from').value = String(first.identity.timeS);
    input('to').value = String(last.identity.timeS);
    input('maximum').max = String(networkRecordMaximum);
    input('maximum').value = String(Math.max(legacyNetworkRecordCapacity, result.samples.length));
    input('tolerance').value = '0.5';
    input('perFile').value = result.samples.length > legacyNetworkRecordCapacity ? '1000' : '200';
    input('title').value = quantities.selectedOptions[0]?.textContent ?? '';
    for (const id of ['maximum', 'tolerance', 'perFile']) input(id).disabled = false;
    const initialNote = result.record.samplesTruncated
      ? ` 已达到容量，较早的 ${result.record.samplesDropped} 个样本已滚动丢弃。「适合全部」仅覆盖现存时段。`
      : first.identity.timeS > 0
        ? ' 这份记录未包含 0 秒样本。'
        : '';
    element('curve-source').textContent =
      `${label(select('sourceChoice').value)} · 已保留 ${result.samples.length} / ${result.record.capacity} 个样本；此窗口冻结该批数据。${initialNote}`;
    element('curve-source-details').textContent =
      `快照 ${result.snapshotId}；运行 ${result.view.point.identity.simulationSessionId}；${first.identity.timeS}–${last.identity.timeS} s`;
    renderKeys();
    renderLegend();
  }
  function activeCurve(): OfflineCurve | null {
    const curve = loaded?.curves[index()];
    if (!curve) return null;
    const f = figure();
    if (!f.ok) {
      status(f.diagnostics.map((d) => d.message).join('；'));
      return null;
    }
    const parsed = parseOfflineCurve({
      ...curve,
      state: {
        ...curve.state,
        title: f.value.title,
        paper: f.value.paper,
        fromS: input('from').valueAsNumber,
        toS: input('to').valueAsNumber,
        keys,
      },
    });
    if (!parsed.ok) {
      status(parsed.diagnostics.map((d) => d.message).join('；'));
      return null;
    }
    return parsed.value;
  }
  function loadedWithState(): CurveFile | null {
    if (!loaded) return null;
    const curve = activeCurve(),
      f = figure();
    if (!curve || !f.ok) return null;
    const all = select('scope').value === 'all',
      curves = all ? loaded.curves.map((c, i) => (i === index() ? curve : c)) : [curve],
      explanations = all
        ? loaded.explanations.map((v, i) => (i === index() ? f.value.showExplanation : v))
        : [f.value.showExplanation];
    const parsed = parseCurveFile({ ...loaded, curves, explanations });
    if (!parsed.ok) {
      status(parsed.diagnostics.map((d) => d.message).join('；'));
      return null;
    }
    return parsed.value;
  }
  function apply() {
    if (saving || loading || !current()) return;
    const f = figure();
    if (!f.ok) {
      invalidate(f.diagnostics.map((d) => d.message).join('；'));
      return;
    }
    if (loaded) {
      const curve = activeCurve();
      if (!curve) {
        invalidate(element('curve-toolsStatus').textContent ?? '导入曲线设置无效。');
        return;
      }
      invalidate('正在更新图表…');
      const samples = curve.samples.filter((p) => p.timeS >= curve.state.fromS && p.timeS <= curve.state.toS);
      if (!samples.length) {
        status('所选时间范围没有实际样本，请调整范围；未生成或补造数据。');
        return;
      }
      const svg = curveFigureSvg(
        {
          samples,
          indices: samples.map((p) => p.index),
          label: curve.label,
          unit: curve.unit,
          metadata: curve.metadata,
          keys,
        },
        f.value,
        curve.snapshotId,
      );
      if (!svg.ok) {
        status(svg.diagnostics.map((d) => d.message).join('；'));
        return;
      }
      // Applied view state belongs to each imported curve, including after selection changes.
      loaded = {
        ...loaded,
        curves: loaded.curves.map((stored, i) => (i === index() ? curve : stored)),
        explanations: loaded.explanations.map((stored, i) => (i === index() ? f.value.showExplanation : stored)),
      };
      accepted({
        svg: svg.value,
        csv: [],
        plot: { samples, label: curve.label, unit: curve.unit, metadata: curve.metadata },
        indices: samples.map((p) => p.index),
        figure: f.value,
        summary: `已导入曲线，显示${samples.length}个实际样本；可选择PDF、CSV或另存数据文件。`,
      });
      return;
    }
    void runWorker('preview');
  }
  async function runWorker(
    mode: 'preview' | 'data' | 'csv',
    job?: {
      readonly request: CurveRequest;
      readonly comparison?: { readonly capture: NetworkExportCapture; readonly request: CurveRequest };
    },
  ) {
    const selected = capture,
      req = job?.request ?? request(),
      f = figure();
    if (!selected || !req || !f.ok || !current()) return;
    stop();
    if (mode === 'preview') {
      preview = null;
      enableSave(false);
      hideHover();
    } else if (mode === 'csv') setLoading(true);
    status(
      mode === 'preview'
        ? '正在更新曲线…'
        : mode === 'csv'
          ? '正在整理当前视图的精简 CSV…'
          : '正在保存范围内的完整曲线数据…',
    );
    const ticket = generation,
      task = new Worker('./network-curve-worker.mjs', { type: 'module' });
    worker = task;
    const finish = () => {
      task.terminate();
      if (worker === task) {
        worker = null;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (mode === 'csv' && current()) {
          setLoading(false);
          enableSave(!!preview);
        }
      }
    };
    task.onmessage = (event: MessageEvent<unknown>) => {
      if (ticket !== generation || !current()) {
        finish();
        return;
      }
      const r = new ContractReader(),
        o = r.object(event.data, '', [
          'status',
          'message',
          'artifact',
          'summary',
          'snapshotId',
          'svg',
          'csv',
          'plot',
          'figure',
        ]);
      if (o.status === 'error') {
        finish();
        status(r.text(o.message, '/message', 1, 3000));
        return;
      }
      if (mode === 'csv') {
        const csv: ExportArtifact[] = [];
        if (o.status === 'csv')
          for (const raw of r.array(o.csv, '/csv', 200)) {
            const part = parseExportArtifact(raw);
            if (
              !part.ok ||
              part.value.format !== 'csv' ||
              (part.value.snapshotId !== selected.snapshotId &&
                part.value.snapshotId !== job?.comparison?.capture.snapshotId)
            ) {
              csv.length = 0;
              break;
            }
            csv.push(part.value);
          }
        finish();
        if (!csv.length || !r.finish(true).ok) status('精简 CSV 响应无效，原记录保留。');
        else void write(csv, 'CSV');
        return;
      }
      if (mode === 'data') {
        const artifact = parseNetworkArtifact(o.artifact);
        finish();
        if (!artifact.ok || artifact.value.format !== 'hydcurve' || artifact.value.snapshotId !== selected.snapshotId) {
          status('曲线数据响应无效或来源过期。');
          return;
        }
        void write([artifact.value], 'HYDCURVE');
        return;
      }
      const result = parsePreview(event.data, selected.snapshotId);
      finish();
      if (typeof result === 'string') {
        status(result);
        return;
      }
      accepted(result);
    };
    task.onerror = () => {
      if (ticket === generation && current()) status('曲线整理失败，原记录保留。');
      finish();
    };
    timer = setTimeout(() => {
      if (ticket === generation && current()) status('曲线整理超过30秒，请缩小范围或选择单条曲线。');
      finish();
    }, 30000);
    task.postMessage({
      mode,
      capture: selected,
      request: req,
      figure: f.value,
      ...(job?.comparison ? { comparison: job.comparison } : {}),
    });
  }
  async function read() {
    if (saving) return;
    show();
    stop();
    setLoading(true);
    capture = null;
    loaded = null;
    preview = null;
    comparison = undefined;
    comparisonKeys = [];
    sources.clear();
    enableSave(false);
    hideHover();
    chart.textContent = '';
    select('quickQuantity').replaceChildren(new Option('暂无可用量值', ''));
    select('quickQuantity').disabled = true;
    sourceChoices('');
    renderLegend();
    const ticket = generation;
    const projectId = hooks.editor().document.projectId;
    status('正在读取当前/历史记录…');
    const shortcut = dialog.dataset.fromShortcut === 'true';
    const preferred = shortcut ? hooks.preferredTarget?.() : undefined;
    try {
      const [live, saved] = await Promise.allSettled([
        hooks.capture(shortcut ? 'current' : undefined),
        hooks.history(projectId),
      ]);
      if (ticket !== generation || !current()) return;
      const result = live.status === 'fulfilled' ? live.value : null;
      if (result?.samples.length && result.view.document.projectId === projectId)
        sources.set(
          result.selection === 'current' ? 'current' : result.view.point.identity.simulationSessionId,
          result,
        );
      const history = saved.status === 'fulfilled' ? saved.value : [];
      let count = 0;
      for (const record of history) {
        const id = record.view.point.identity.simulationSessionId;
        if (id === result?.view.point.identity.simulationSessionId || sources.has(id)) continue;
        if (count++ >= 2) break;
        sources.set(id, record);
      }
      sourceChoices(result?.selection === 'history' ? result.view.point.identity.simulationSessionId : 'current');
      const chosen = sources.get(select('sourceChoice').value);
      if (!chosen) {
        status(
          saved.status === 'rejected'
            ? '未能读取本机曲线历史。也可导入已有曲线数据文件。'
            : '没有有效运行记录；也可导入已有曲线数据文件。',
        );
        return;
      }
      installCapture(chosen, preferred);
      setLoading(false);
      apply();
    } catch (cause: unknown) {
      if (ticket === generation && current()) status('读取失败：' + String(cause).slice(0, 200));
    } finally {
      if (ticket === generation && current()) setLoading(false);
    }
  }

  function loadSelected() {
    const curve = loaded?.curves[index()];
    if (!curve) return;
    scope = undefined;
    keys = curve.state.keys;
    input('title').value = curve.state.title;
    select('paper').value = curve.state.paper;
    input('explanation').checked = loaded?.explanations[index()] === true;
    input('from').value = String(curve.state.fromS);
    input('to').value = String(curve.state.toS);
    for (const id of ['maximum', 'tolerance', 'perFile']) input(id).disabled = true;
    renderKeys();
    apply();
  }
  async function importFile(associated?: File) {
    const file = associated ?? input('file').files?.[0];
    input('file').value = '';
    if (!file) return;
    show();
    if (saving) return;
    stop();
    setLoading(false);
    enableSave(!!preview);
    const ticket = generation;
    if (file.size > 4_000_000) {
      status('曲线文件超过4MB，当前图表保留。');
      return;
    }
    status('正在导入曲线数据…');
    setLoading(true);
    try {
      const text = await file.text();
      if (ticket !== generation || !current()) return;
      const raw: unknown = JSON.parse(text),
        parsed = parseCurveFile(raw);
      if (!parsed.ok) {
        status(parsed.diagnostics.map((d) => d.message).join('；'));
        return;
      }
      loaded = parsed.value;
      capture = null;
      comparison = undefined;
      comparisonKeys = [];
      sources.clear();
      sourceChoices('');
      select('quantity').innerHTML = loaded.curves
        .map((c, i) => `<option value="${i}">${esc(c.label + ' / ' + c.unit)}</option>`)
        .join('');
      select('quantity').value = '0';
      const quick = select('quickQuantity');
      quick.replaceChildren(...[...select('quantity').options].map((option) => new Option(option.text, option.value)));
      quick.value = '0';
      element('curve-source').textContent =
        `已导入 ${file.name} · ${loaded.curves.length}条曲线；未改动当前工程或运行。`;
      element('curve-source-details').textContent =
        `来源 ${loaded.snapshotId}；${loaded.identityLevel === 'sample' ? '含逐样本运行身份' : '旧单曲线文件仅保留原头部来源，未补造控制身份'}`;
      setLoading(false);
      loadSelected();
    } catch (cause: unknown) {
      if (ticket === generation && current()) status('无法导入曲线数据，当前图表保留：' + String(cause).slice(0, 150));
    } finally {
      if (ticket === generation && current()) {
        setLoading(false);
        enableSave(!!preview);
      }
    }
  }
  async function write(artifacts: readonly NetworkArtifact[], label: string) {
    if (!current() || saving || !artifacts.length) return;
    let output = artifacts;
    if (dialog.dataset.shortcutView === 'preview') {
      const name = element('shortcutCurveName');
      if (!(name instanceof HTMLInputElement)) throw new Error('Curve filename missing');
      const files: NetworkArtifact[] = [];
      for (const [i, artifact] of artifacts.entries()) {
        const part = artifacts.length > 1 ? '-' + (i + 1) : '';
        const parsed = parseNetworkArtifact({
          ...artifact,
          suggestedName: name.value.trim() + part + '.' + artifact.format,
        });
        if (!parsed.ok) {
          status(parsed.diagnostics.map((d) => d.message).join('；'));
          return;
        }
        files.push(parsed.value);
      }
      output = files;
    }
    const ticket = generation;
    const destination = select('destination').value === 'external' ? 'external' : 'project';
    saving = true;
    enableSave(false);
    element('curve-settings').setAttribute('disabled', '');
    let written = 0;
    try {
      for (const artifact of output) {
        if (ticket !== generation || !current()) break;
        if (!(await hooks.write(artifact, artifact.format === 'csv' ? 'data' : 'curves', destination))) break;
        written++;
      }
      if (current() && ticket === generation)
        status(
          written === artifacts.length
            ? `已保存 ${written} 份${label}。`
            : `保存中止，本次已写 ${written}/${artifacts.length} 份；原数据和标注保留。`,
        );
    } catch (cause: unknown) {
      if (current()) status('保存失败，原数据保留：' + String(cause).slice(0, 150));
    } finally {
      saving = false;
      element('curve-settings').removeAttribute('disabled');
      enableSave(!!preview);
    }
  }
  function scopeRequest(req: CurveRequest, plot: CurvePlot): CurveRequest | undefined {
    const samples = visibleSamples(plot);
    const first = samples[0],
      last = samples.at(-1);
    if (!first || !last) return;
    const keys = new Set(samples.map((sample) => sample.index));
    return { ...req, fromS: first.timeS, toS: last.timeS, keys: req.keys.filter((key) => keys.has(key.sampleIndex)) };
  }
  function saveScopeCsv(): void {
    if (!preview || !capture || saving || loading || !current()) return;
    const plot = primaryPlot(),
      req = request();
    const cropped = plot && req && scopeRequest(req, plot);
    if (!cropped) {
      status('当前视图没有主曲线采样点，请移动视图或点击「适合全部」。');
      return;
    }
    const overlay = comparisonPlot();
    const second = comparison && overlay && scopeRequest(comparison.plan.request, overlay);
    void runWorker('csv', {
      request: cropped,
      ...(second && comparison ? { comparison: { capture: comparison.source, request: second } } : {}),
    });
  }
  function save(format: 'pdf' | 'svg' | 'csv' | 'hydcurve') {
    if (!preview || saving || loading || !current()) return;
    if (format === 'hydcurve') {
      if (capture) {
        if (comparison) {
          const primaryRequest = request();
          if (!primaryRequest) return;
          const outputs: NetworkArtifact[] = [];
          for (const [source, request] of [
            [capture, primaryRequest],
            [comparison.source, comparison.plan.request],
          ] as const) {
            const file = prepareCurveFile(source, request, preview.figure);
            if (!file.ok) {
              status(file.diagnostics.map((item) => item.message).join('；'));
              return;
            }
            const text = curveFileText(file.value);
            if (!text.ok) {
              status(text.diagnostics.map((item) => item.message).join('；'));
              return;
            }
            outputs.push({
              version: 1,
              snapshotId: source.snapshotId,
              format,
              suggestedName: `曲线数据-${outputs.length + 1}.hydcurve`,
              text: text.value,
            });
          }
          void write(outputs, 'HYDCURVE');
          return;
        }
        void runWorker('data');
        return;
      }
      const set = loadedWithState();
      if (!set) return;
      const text = curveFileText(set);
      if (!text.ok) {
        status(text.diagnostics.map((d) => d.message).join('；'));
        return;
      }
      const artifact = parseNetworkArtifact({
        version: 1,
        snapshotId: set.snapshotId,
        format,
        suggestedName: '曲线数据.hydcurve',
        text: text.value,
      });
      if (artifact.ok) void write([artifact.value], 'HYDCURVE');
      return;
    }
    if (format === 'csv') {
      if (!loaded) {
        if (dialog.dataset.shortcutView !== 'settings' && (scope || recentViewSeconds !== null)) {
          saveScopeCsv();
          return;
        }
        const parts = [...preview.csv];
        if (comparison) {
          for (const [index] of comparison.plan.segments.entries()) {
            const part = exportCurveSegment(comparison.source, comparison.plan, index);
            if (!part.ok) {
              status(part.diagnostics.map((item) => item.message).join('；'));
              return;
            }
            parts.push(part.value);
          }
        }
        void write(parts, 'CSV');
        return;
      }
      const set = loadedWithState();
      if (!set) return;
      const parts: ExportArtifact[] = [];
      let bytes = 0;
      for (let i = 0; i < set.curves.length; i++) {
        const csv = storedCurveCsv(set, i);
        if (!csv.ok) {
          status(csv.diagnostics.map((d) => d.message).join('；'));
          return;
        }
        bytes += utf8Bytes(csv.value.text);
        if (bytes > 32_000_000) {
          status('CSV总量超过32MB，请选单条曲线。');
          return;
        }
        parts.push(csv.value);
      }
      void write(parts, 'CSV');
      return;
    }
    const svg = paperSvg();
    if (!svg) return;
    if (format === 'svg') {
      void write([svg], 'SVG');
      return;
    }
    const artifact = parseNetworkArtifact({ ...svg, format: 'pdf', suggestedName: '曲线图.pdf' });
    if (!artifact.ok) {
      status(artifact.diagnostics.map((d) => d.message).join('；'));
      return;
    }
    void write([artifact.value], 'PDF');
  }
  function toggle(sampleIndex: number, series: 0 | 1 = 0) {
    if (!preview || saving || loading) return;
    const plot = series === 0 ? primaryPlot() : comparisonPlot();
    const point = plot?.samples.find((sample) => sample.index === sampleIndex);
    if (!point || point.value === null) return;
    const former = series === 0 ? keys : comparisonKeys;
    const found = former.some((key) => key.sampleIndex === sampleIndex);
    if (!found && former.length >= 16) {
      status('每条曲线最多固定16个标注。');
      return;
    }
    const next = found
      ? former.filter((key) => key.sampleIndex !== sampleIndex)
      : [...former, { sampleIndex, label: '', offsetX: 0, offsetY: 0 }];
    if (series === 0) keys = next;
    else comparisonKeys = next;
    draw();
    if (
      !found &&
      drawnViewport &&
      chart.querySelector(
        '[data-annotation="marker"][data-key-series="' + series + '"][data-key-index="' + sampleIndex + '"]',
      )
    ) {
      if (series === 0) keys = former;
      else comparisonKeys = former;
      draw();
      status('图内没有安全位置，请先取消一个固定点。');
      return;
    }
    renderKeys();
    if (series === 0) apply();
    else {
      const problem = planComparison();
      if (problem) status(problem);
      renderLegend();
      draw();
    }
  }
  function inspectedPoints() {
    const entries: { mark: Inspection; timeS: number; value: number; unit: string }[] = [];
    for (const series of [0, 1] as const) {
      const plot = series === 0 ? primaryPlot() : comparisonPlot();
      if (!plot) continue;
      for (const sample of plot.samples)
        if (sample.value !== null)
          entries.push({
            mark: { series, sampleIndex: sample.index },
            timeS: sample.timeS,
            value: sample.value,
            unit: plot.unit,
          });
    }
    return entries;
  }
  function nearest(event: MouseEvent): Inspection | undefined {
    const plot = primaryPlot();
    const matrix = chart.querySelector('svg')?.getScreenCTM();
    if (!plot || !matrix || !preview || !drawnViewport || !inspectionEnabled()) return;
    const g = curveGeometry(plot, preview.figure, drawnViewport, comparisonPlot());
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    if (point.x < g.left || point.x > g.right || point.y < g.top || point.y > g.bottom) return;
    let best: Inspection | undefined;
    let dx = Infinity,
      dy = Infinity;
    for (const item of inspectedPoints()) {
      if (
        drawnViewport.scope &&
        (item.timeS < g.xMin || item.timeS > g.xMax || item.value < g.yMin || item.value > g.yMax)
      )
        continue;
      const x = Math.abs(g.x(item.timeS) - point.x);
      const y = Math.abs(g.y(item.value) - point.y);
      if (x < dx || (x === dx && y < dy)) {
        best = item.mark;
        dx = x;
        dy = y;
      }
    }
    return best;
  }
  let hoverFrame = 0;
  function inspect(mark: Inspection | undefined): void {
    if (hover?.series === mark?.series && hover?.sampleIndex === mark?.sampleIndex) return;
    hover = mark;
    const selected = inspectedPoints().find(
      (item) => item.mark.series === mark?.series && item.mark.sampleIndex === mark?.sampleIndex,
    );
    element('curveInspectionReadout').textContent = selected
      ? [
          Number(selected.value.toPrecision(8)) + ' ' + selected.unit,
          Number(selected.timeS.toPrecision(8)) + ' s',
          label(select(selected.mark.series === 0 ? 'sourceChoice' : 'comparisonChoice').value),
        ].join(' · ')
      : '在绘图区移动鼠标读数，点击固定或取消。';
    if (!hoverFrame)
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        if (current()) draw();
      });
  }
  chart.tabIndex = 0;
  chart.setAttribute(
    'aria-label',
    '曲线图。拖动平移，坐标轴上滚轮只缩放该轴，图内滚轮缩放两轴。方向键选点，Enter 固定或取消。',
  );
  let drag: { id: number; x: number; y: number; width: number; height: number; range: CurveScopeRange } | undefined;
  let suppressClick = false;
  function gesture(event: MouseEvent) {
    const plot = primaryPlot();
    const matrix = chart.querySelector('svg')?.getScreenCTM();
    if (!plot || !preview || !matrix || !drawnViewport?.scope || saving || loading) return;
    const g = curveGeometry(plot, preview.figure, drawnViewport, comparisonPlot());
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const x = point.x >= g.left && point.x <= g.right;
    const y = point.y >= g.top && point.y <= g.bottom;
    const axis = x && point.y >= g.bottom - 2 ? 'x' : y && point.x <= g.left + 2 ? 'y' : x && y ? 'both' : undefined;
    return { axis, g, point, range: drawnViewport.scope };
  }
  chart.addEventListener(
    'wheel',
    (event) => {
      if (drag || event.ctrlKey || event.metaKey || event.deltaY === 0) return;
      const hit = gesture(event);
      if (!hit?.axis) return;
      event.preventDefault();
      const { axis, g, point } = hit;
      const range = scope ?? hit.range;
      const pixels = event.deltaY * (event.deltaMode === 0 ? 1 : event.deltaMode === 1 ? 16 : chart.clientHeight);
      const scale = 1.125 ** (Math.max(-360, Math.min(360, pixels)) / 120);
      const zoom = (min: number, max: number, fraction: number) => {
        const span = max - min;
        const size = Math.max(1e-10, Math.min(1e12, span * scale));
        const start = min + (span - size) * fraction;
        return [start, start + size] as const;
      };
      const [xMin, xMax] =
        axis === 'y' ? [range.xMin, range.xMax] : zoom(range.xMin, range.xMax, (point.x - g.left) / (g.right - g.left));
      const [yMin, yMax] =
        axis === 'x'
          ? [range.yMin, range.yMax]
          : zoom(range.yMin, range.yMax, (g.bottom - point.y) / (g.bottom - g.top));
      updateScope({ xMin, xMax, yMin, yMax });
    },
    { passive: false },
  );
  chart.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    suppressClick = false;
    const hit = gesture(event);
    if (!hit?.axis || drag) return;
    const { g, point, range } = hit;
    drag = { id: event.pointerId, x: point.x, y: point.y, width: g.right - g.left, height: g.bottom - g.top, range };
    chart.setPointerCapture(event.pointerId);
  });
  chart.addEventListener('pointermove', (event) => {
    const hit = gesture(event);
    if (drag?.id === event.pointerId && hit) {
      const { x, y, width, height, range } = drag;
      const dx = hit.point.x - x,
        dy = hit.point.y - y;
      if (!suppressClick && Math.hypot(dx, dy) < 3) return;
      suppressClick = true;
      chart.setAttribute('data-scope-dragging', '');
      const shiftX = (-dx / width) * (range.xMax - range.xMin);
      const shiftY = (dy / height) * (range.yMax - range.yMin);
      updateScope({
        xMin: range.xMin + shiftX,
        xMax: range.xMax + shiftX,
        yMin: range.yMin + shiftY,
        yMax: range.yMax + shiftY,
      });
      return;
    }
    chart.dataset.scopeAxis = hit?.axis ?? '';
    inspect(nearest(event));
  });
  chart.addEventListener('lostpointercapture', (event) => {
    if (drag?.id !== event.pointerId) return;
    drag = undefined;
    chart.removeAttribute('data-scope-dragging');
  });
  chart.addEventListener('pointerleave', () => {
    delete chart.dataset.scopeAxis;
    inspect(undefined);
  });
  chart.addEventListener('click', (event) => {
    if (suppressClick) return;
    const selected = nearest(event);
    if (selected) toggle(selected.sampleIndex, selected.series);
  });
  chart.addEventListener('keydown', (event) => {
    if (!drawnViewport || !inspectionEnabled()) return;
    if (event.key === 'Enter' && hover) {
      event.preventDefault();
      toggle(hover.sampleIndex, hover.series);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const points = inspectedPoints().sort((a, b) => a.timeS - b.timeS);
    const current = points.findIndex(
      (item) => item.mark.series === hover?.series && item.mark.sampleIndex === hover?.sampleIndex,
    );
    const next = points[Math.max(0, Math.min(points.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)))];
    event.preventDefault();
    inspect(next?.mark);
  });
  select('sourceChoice').addEventListener('change', () => {
    if (saving || loading || !current()) return;
    const selected = sources.get(select('sourceChoice').value);
    if (!selected) return;
    const target = request()?.target;
    sourceChoices(select('sourceChoice').value, select('comparisonChoice').value);
    hideHover();
    installCapture(selected, target);
    apply();
  });
  select('comparisonChoice').addEventListener('change', () => {
    if (saving || loading || !current() || !preview) return;
    hideHover();
    comparisonKeys = [];
    const problem = planComparison();
    status(problem || preview.summary);
    renderLegend();
    draw();
  });
  select('quickQuantity').addEventListener('change', () => {
    select('quantity').value = select('quickQuantity').value;
    select('quantity').dispatchEvent(new Event('change'));
  });
  new MutationObserver(() => {
    if (!inspectionEnabled()) inspect(undefined);
  }).observe(dialog, { attributeFilter: ['data-details-enabled'] });

  element('openCurveTools').addEventListener('click', () => void read());
  element('importCurveFile').addEventListener('click', () => {
    show();
    input('file').click();
  });
  button('import').addEventListener('click', () => input('file').click());
  input('file').addEventListener('change', () => void importFile());
  element('refreshCurve').addEventListener('click', () => void read());
  button('close').addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  button('apply').addEventListener('click', apply);
  button('fit').addEventListener('click', () => {
    const first = capture?.samples[0]?.identity.timeS ?? loaded?.curves[index()]?.samples[0]?.timeS;
    const last = capture?.samples.at(-1)?.identity.timeS ?? loaded?.curves[index()]?.samples.at(-1)?.timeS;
    if (first === undefined || last === undefined) return;
    scope = undefined;
    recentViewSeconds = null;
    hideHover();
    if (input('from').valueAsNumber === first && input('to').valueAsNumber === last) draw();
    else {
      input('from').value = String(first);
      input('to').value = String(last);
      apply();
    }
  });
  button('scopeCsv').addEventListener('click', saveScopeCsv);
  for (const [id, format] of [
    ['savePdf', 'pdf'],
    ['saveSvg', 'svg'],
    ['saveCsv', 'csv'],
    ['saveData', 'hydcurve'],
  ] as const)
    button(id).addEventListener('click', () => save(format));
  select('quantity').addEventListener('change', () => {
    select('quickQuantity').value = select('quantity').value;
    hideHover();
    if (loaded) {
      loadSelected();
      return;
    }
    keys = [];
    comparisonKeys = [];
    scope = undefined;
    input('title').value = select('quantity').selectedOptions[0]?.textContent ?? '';
    renderKeys();
    apply();
  });
  element('curve-settings').addEventListener('input', (event) => {
    if (event.target === input('from') || event.target === input('to')) {
      scope = undefined;
      recentViewSeconds = null;
    }
    if (event.target !== select('quantity')) scheduleUpdate();
  });
  element('curve-keys').addEventListener('change', (event) => {
    if (saving || loading || !(event.target instanceof HTMLInputElement)) return;
    const e = event.target,
      at = Number(e.dataset.key),
      field = e.dataset.field;
    keys = keys.map((k) =>
      k.sampleIndex !== at
        ? k
        : field === 'label'
          ? { ...k, label: e.value }
          : field === 'offsetX'
            ? { ...k, offsetX: e.valueAsNumber }
            : field === 'offsetY'
              ? { ...k, offsetY: e.valueAsNumber }
              : k,
    );
    apply();
  });
  element('curve-keys').addEventListener('click', (event) => {
    if (event.target instanceof HTMLButtonElement && event.target.dataset.removeKey)
      toggle(Number(event.target.dataset.removeKey));
  });
  button('addKey').addEventListener('click', () => toggle(Number(select('point').value)));
  return {
    importFile,
    invalidateIfChanged() {
      if (dialog.open && owner && !current()) {
        releaseView();
        dialog.close();
      }
    },
  };
}
