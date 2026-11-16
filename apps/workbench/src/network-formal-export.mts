import {
  drawingFields,
  changeFields,
  parseDrawingSettings,
  calculationBook,
  parseNetworkArtifact,
  type NetworkArtifact,
  type NetworkFileOutcome,
  type NetworkDraftSession,
  type NetworkExportCapture,
  calculationBookMarkup,
  exportNetworkCatalog,
  parseCalculationBook,
  type NetworkCatalogPreview,
} from '@hyd/application';
import { networkLearningRecord, type CalculationRecord } from '@hyd/engineering';
import { diagnostic, type Result } from '@hyd/domain';
import { element, escapeHtml as esc } from './network-dom.mjs';
import { drawingSheet } from './network-drawing-sheet.mjs';
import { createDrawingTemplates } from './network-drawing-template.mjs';
import { bindTitleEditor } from './network-formal-drawing-view.mjs';
import type { NetworkExportDefaults } from './network-app-settings.mjs';
type DrawingFormat = NetworkExportDefaults['drawing'];
export interface ToolDrawingObserver {
  starting(): boolean;
  finished(outcome: NetworkFileOutcome): void;
  closed(): void;
}
interface Hooks {
  editor(): NetworkDraftSession;
  exportDefaults(): NetworkExportDefaults;
  capture(): Promise<NetworkExportCapture | null>;
  write(
    artifact: NetworkArtifact,
    category: 'drawings' | 'calculations',
    destination: 'project' | 'external',
    observe?: (outcome: NetworkFileOutcome) => void,
  ): Promise<boolean>;
  uid(prefix: string): string;
}
function select(id: string): HTMLSelectElement {
  const e = element(id);
  if (!(e instanceof HTMLSelectElement)) throw new Error('Formal selector missing');
  return e;
}
export function createNetworkFormalExport(hooks: Hooks) {
  const dialog = (() => {
    const e = element('formalExport');
    if (!(e instanceof HTMLDialogElement)) throw new Error('Formal dialog missing');
    return e;
  })();
  const root = element('formal-fields'),
    basic = ['organization', 'title', 'number', 'scale', 'designName', 'designDate'];
  const control = (key: string, label: string) =>
    `<label>${esc(label)}<input data-formal-field="${esc(key)}" maxlength="160" value=""></label>`;
  root.innerHTML = `<div class="formal-grid">${drawingFields
    .filter(([key]) => key && basic.includes(key))
    .map(([key, label]) => control(key ?? '', label ?? ''))
    .join('')}</div><details><summary>其他标题栏信息与更改记录</summary><div class="formal-grid">${drawingFields
    .filter(([key]) => key && !basic.includes(key))
    .map(([key, label]) => control(key ?? '', label ?? ''))
    .join(
      '',
    )}</div>${Array.from({ length: 3 }, (_, i) => `<fieldset class="formal-grid"><legend>更改记录 ${i + 1}</legend>${changeFields.map(([key, label]) => `<label>${esc(label)}<input data-formal-change="${i}" data-formal-key="${esc(key)}" maxlength="160"></label>`).join('')}</fieldset>`).join('')}</details>`;
  let owner: NetworkDraftSession | null = null,
    revision = -1,
    record: CalculationRecord | null = null,
    catalog: NetworkCatalogPreview | null = null,
    artifact: NetworkArtifact | null = null,
    generation = 0,
    busy = false;
  let toolObserver: ToolDrawingObserver | null = null;
  const status = (s: string) => {
    element('formal-status').textContent = s;
  };
  const current = () => dialog.open && owner === hooks.editor() && revision === hooks.editor().revision;
  const templates = createDrawingTemplates(root, () => invalidate());
  const titleCells = new Map<string, string>();
  bindTitleEditor(root, templates.current, titleCells, () => invalidate());
  root.addEventListener('input', (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    const key = event.target.dataset.formalField;
    if (key === 'total' || key === 'sheet') titleCells.delete(key + 'Cell');
    if (key === 'stage') for (let i = 0; i < 4; i++) titleCells.delete('stage.' + i);
  });
  let previewTimer: number | undefined;
  function invalidate(message = '设置已更新；可直接保存，也可预览检查。') {
    artifact = null;
    if (dialog.dataset.exportKind === 'drawing' && current()) {
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => prepare(), 120);
    } else element('formal-preview').textContent = '';
    element('formal-save').toggleAttribute('disabled', busy);
    status(message);
  }
  function close() {
    window.clearTimeout(previewTimer);
    const observer = toolObserver;
    toolObserver = null;
    observer?.closed();
    generation++;
    artifact = null;
    record = null;
    catalog = null;
    select('formal-format').disabled = false;
    select('formal-destination').disabled = false;
    owner = null;
    element('formal-preview').textContent = '';
    dialog.close();
  }
  function settings(): unknown {
    const fields: Record<string, string> = {},
      changes: Record<string, string>[] = [{}, {}, {}];
    const template = templates.current();
    const templateHeadings = new Set(template?.fields.map(({ key }) => 'templateHeading.' + key));
    const activeCells = [...titleCells].filter(
      ([key]) =>
        !key.startsWith('template') || templateHeadings.has(key) || (template && key.startsWith('templateSpare.')),
    );
    for (const e of root.querySelectorAll<HTMLInputElement>('[data-formal-field]'))
      if (e.dataset.formalField) fields[e.dataset.formalField] = e.value;
    for (const e of root.querySelectorAll<HTMLInputElement>('[data-formal-change]')) {
      const row = changes[Number(e.dataset.formalChange)];
      if (row && e.dataset.formalKey) row[e.dataset.formalKey] = e.value;
    }
    return {
      labels: select('svgLabels').value,
      paper: select('formal-paper').value,
      orientation: select('formal-orientation').value,
      bindingEdge: select('formal-binding').value !== 'no',
      occupancy: Number(select('formal-occupancy').value),
      fields,
      changes,
      ...(activeCells.length ? { titleCells: Object.fromEntries(activeCells) } : {}),
      ...(template ? { template } : {}),
    };
  }
  function measure(markup: string) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', 'position:fixed;left:-100000px;top:0;visibility:hidden;overflow:visible');
    svg.innerHTML = `<g font-family="Microsoft YaHei, sans-serif" font-size="12" fill="none" stroke="black">${markup}</g>`;
    document.body.append(svg);
    try {
      const group = svg.firstElementChild;
      if (!(group instanceof SVGGraphicsElement)) throw new Error('无法测量导出符号。');
      const box = group.getBBox();
      return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
    } finally {
      svg.remove();
    }
  }
  function drawingArtifact(
    editor: NetworkDraftSession,
    parsed: Extract<ReturnType<typeof parseDrawingSettings>, { ok: true }>['value'],
    context: Parameters<typeof drawingSheet>[2],
    format: DrawingFormat,
  ): Result<NetworkArtifact> {
    const metrics = document.createElement('canvas').getContext('2d');
    if (!metrics)
      return { ok: false, diagnostics: [diagnostic('DRAWING_FONT_UNAVAILABLE', '/drawing', '无法取得本机字体度量。')] };
    metrics.font = '100px SimSun,宋体,serif';
    return drawingSheet(
      editor.document,
      parsed,
      context,
      format,
      measure,
      (text) => metrics.measureText(text).width / 100,
    );
  }
  function bookArtifact(
    book: Extract<ReturnType<typeof calculationBook>, { ok: true }>['value'],
    snapshotId: string,
    format: 'docx' | 'pdf',
  ) {
    return parseNetworkArtifact({
      version: 1,
      snapshotId,
      format,
      suggestedName: '液压计算书.' + format,
      text: JSON.stringify(format === 'pdf' ? { format: 'HydraulicCalculationBookPdf', version: 1, book } : book),
    });
  }
  function prepareToolBatch(calculation: CalculationRecord) {
    if (dialog.open || busy)
      return { ok: false as const, diagnostics: [diagnostic('FILE_BUSY', '/files', '请先完成或关闭当前正式导出。')] };
    const editor = hooks.editor();
    const defaults = hooks.exportDefaults();
    const parsed = parseDrawingSettings({
      paper: defaults.paper,
      orientation: defaults.orientation,
      occupancy: 1,
      fields: Object.fromEntries(drawingFields.map(([key]) => [key, ''])),
      changes: Array.from({ length: 3 }, () => Object.fromEntries(changeFields.map(([key]) => [key, '']))),
    });
    if (!parsed.ok) return parsed;
    const capturedAt = new Date().toISOString();
    const drawing = drawingArtifact(
      editor,
      parsed.value,
      {
        snapshotId: hooks.uid('formal'),
        documentSessionId: editor.documentSessionId,
        revision: editor.revision,
        physicsRevision: editor.physicsRevision,
        capturedAt,
      },
      'pdf',
    );
    if (!drawing.ok) return drawing;
    const snapshotId = hooks.uid('formal');
    const book = calculationBook(calculation, {
      snapshotId,
      capturedAt,
      fields: parsed.value.fields,
    });
    if (!book.ok) return book;
    const word = bookArtifact(book.value, snapshotId, 'docx');
    if (!word.ok) return word;
    return {
      ok: true as const,
      value: {
        drawing: drawing.value,
        book: word.value,
        paper: parsed.value.paper,
        orientation: parsed.value.orientation,
      },
    };
  }
  function prepare(showPreview = true) {
    if (busy || !current() || !owner) return;
    window.clearTimeout(previewTimer);
    artifact = null;
    status('正在整理导出文件…');
    element('formal-save').setAttribute('disabled', '');
    const parsed = parseDrawingSettings(settings());
    if (!parsed.ok) {
      status(parsed.diagnostics.map((d) => d.message).join('；'));
      return;
    }
    const context = {
      snapshotId: hooks.uid('formal'),
      documentSessionId: owner.documentSessionId,
      revision: owner.revision,
      physicsRevision: owner.physicsRevision,
      capturedAt: new Date().toISOString(),
    };
    const format = select('formal-format').value;
    if (catalog !== null) {
      const result = exportNetworkCatalog(owner, catalog, format === 'md' ? 'md' : 'docx');
      if (!result.ok) {
        status(result.diagnostics.map((d) => d.message).join('；'));
        return;
      }
      artifact = result.value;
      if (result.value.format === 'md') {
        if (showPreview) {
          const page = document.createElement('pre');
          page.className = 'calculation-book catalog-markdown-preview';
          page.textContent = result.value.text;
          element('formal-preview').replaceChildren(page);
        }
        status('Markdown与Word使用相同冻结编号，可分别保存交给外部Agent。');
      } else {
        const raw: unknown = JSON.parse(result.value.text);
        const book = parseCalculationBook(raw);
        if (!book.ok) {
          artifact = null;
          status('选型任务书内容无效，请重新筛选。');
          return;
        }
        if (showPreview) element('formal-preview').innerHTML = calculationBookMarkup(book.value);
        status(
          catalog.plan.coverage.complete
            ? '已冻结本次需求和选型条件；完整型号及采购证据待核实。'
            : '已冻结元件工程参数和待核项；泵规格待工况核算完整后复核。',
        );
      }
    } else if (record !== null) {
      const book = calculationBook(record, {
        snapshotId: context.snapshotId,
        capturedAt: context.capturedAt,
        fields: parsed.value.fields,
        ...(format === 'docx' && select('formal-formula').value === 'latex' ? { formulaFormat: 'latex' } : {}),
      });
      if (!book.ok) {
        status(book.diagnostics.map((d) => d.message).join('；'));
        return;
      }
      const result = bookArtifact(book.value, context.snapshotId, format === 'pdf' ? 'pdf' : 'docx');
      if (!result.ok) {
        status(result.diagnostics.map((d) => d.message).join('；'));
        return;
      }
      artifact = result.value;
      if (showPreview) element('formal-preview').innerHTML = calculationBookMarkup(book.value);
      status(
        record.dutyCoverage && !record.dutyCoverage.complete
          ? '工况核算未完整覆盖。计算书会列出已核算项目、未核算工况及原因。'
          : `计算书来源已冻结；${book.value.formulaFormat === 'latex' ? 'LaTeX源码直接写入Word公式位置，可选中复制。' : '按公式、代入和结果排版；Word公式可编辑，PDF为A4纵向计算书。'}`,
      );
    } else {
      const drawingFormat = format === 'svg' || format === 'png' || format === 'jpg' ? format : 'pdf';
      const result = drawingArtifact(owner, parsed.value, context, drawingFormat);
      if (!result.ok) {
        status(result.diagnostics.map((d) => d.code + '：' + d.message).join('；'));
        return;
      }
      artifact = result.value;
      if (showPreview) element('formal-preview').innerHTML = result.value.text;
      status(
        `${parsed.value.paper} · ${parsed.value.orientation === 'landscape' ? '横向' : '竖向'} · 标题栏 180 × 56 mm`,
      );
    }
    if ((record !== null || catalog !== null) && artifact) {
      const control = element('formal-name');
      const name = control instanceof HTMLInputElement ? control.value.trim() : '';
      if (!name || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
        artifact = null;
        status('请填写有效文件名，不能包含路径或文件名保留字符。');
        return;
      }
      const named = parseNetworkArtifact({ ...artifact, suggestedName: name + '.' + artifact.format });
      if (!named.ok) {
        artifact = null;
        status(named.diagnostics.map((d) => d.message).join('；'));
        return;
      }
      artifact = named.value;
    }
    element('formal-save').removeAttribute('disabled');
  }
  function open(
    format: DrawingFormat | 'docx',
    calculation: CalculationRecord | null = null,
    destination?: 'project' | 'external',
    catalogPreview: NetworkCatalogPreview | null = null,
  ) {
    if (dialog.open || busy) return;
    const editor = hooks.editor();
    const defaults = hooks.exportDefaults();
    if (
      calculation &&
      (!calculation.context ||
        calculation.context.documentSessionId !== editor.documentSessionId ||
        calculation.context.physicsRevision !== editor.physicsRevision ||
        (calculation.context.documentRevision !== null && calculation.context.documentRevision !== editor.revision))
    )
      return;
    owner = editor;
    revision = editor.revision;
    record = calculation;
    dialog.dataset.exportKind = calculation || catalogPreview ? 'book' : 'drawing';
    dialog.toggleAttribute('data-catalog-export', catalogPreview !== null);
    element('formal-name-control').hidden = calculation === null && catalogPreview === null;
    element('formal-drawing-help').hidden = catalogPreview !== null;
    const filename = element('formal-name');
    if (filename instanceof HTMLInputElement) filename.value = catalogPreview ? '液压元件选型检索任务书' : '液压计算书';
    catalog = catalogPreview;
    generation++;
    const drawing = format !== 'docx';
    titleCells.clear();
    templates.reset(drawing);
    if (drawing) {
      select('formal-paper').value = defaults.paper;
      select('formal-orientation').value = defaults.orientation;
      select('formal-binding').value = 'yes';
    }
    for (const e of root.querySelectorAll<HTMLInputElement>('input')) e.value = '';
    const formatSelect = select('formal-format');
    if (format === 'docx')
      formatSelect.innerHTML = '<option value="docx">Word 计算书</option><option value="pdf">PDF 计算书</option>';
    else
      formatSelect.replaceChildren(
        ...[...new Set([...defaults.drawingFormats, format])].map((value) => new Option(value.toUpperCase(), value)),
      );
    if (catalog)
      select('formal-format').innerHTML = '<option value="docx">Word</option><option value="md">Markdown</option>';
    select('formal-format').value = catalog ? defaults.catalog : calculation ? defaults.book : format;
    select('formal-formula').value = 'native';
    element('formal-formula-control').hidden = !calculation || defaults.book !== 'docx';
    element('formal-title').textContent = format === 'docx' ? '计算书导出' : '原理图导出';
    if (catalog) element('formal-title').textContent = '选型检索任务书导出';
    element('formal-fields-note').textContent =
      format === 'docx'
        ? '工程信息可全部留空，仅用于本次计算书；不会修改工程。Word/PDF使用同一计算记录。'
        : '标题栏180 × 56 mm；默认保留原模板，可自定义字段。模板只保存字段设置，本图内容不随模板复用。';
    select('formal-destination').value = destination ?? defaults.destination;
    element('formal-paper-controls').hidden = format === 'docx';
    element('formal-template-panel').hidden = format === 'docx';
    root.hidden = catalog !== null;
    element('formal-preview').textContent = '';
    element('formal-source').textContent = catalogPreview
      ? `工程：${editor.document.title}；${catalogPreview.goalSelection ? '未应用候选' : '当前设计'}；修订 ${editor.revision}。`
      : calculation
        ? `计算来源：${calculation.title}；${calculation.dutyCoverage ? '稳态工况核算' : calculation.kind === 'preliminary' ? '初选预览' : '有效快照'}。`
        : `工程：${editor.document.title}；修订 ${editor.revision}。原理图按设计初始阀位绘制。`;
    dialog.showModal();
    prepare();
  }
  async function openSnapshot() {
    if (dialog.open || busy) return;
    const editor = hooks.editor(),
      rev = editor.revision,
      ticket = ++generation;
    const capture = await hooks.capture();
    if (ticket !== generation || hooks.editor() !== editor || editor.revision !== rev) return;
    if (!capture) {
      element('exportStatus').textContent = '请先运行并取得有效结果，或在计算窗口预览后导出计算书。';
      return;
    }
    const result = networkLearningRecord(capture.view.document, capture.view.point, capture.view.point.identity);
    if (!result.ok) {
      element('exportStatus').textContent = result.diagnostics.map((d) => d.message).join('；');
      return;
    }
    open('docx', result.value);
  }
  async function save() {
    if (busy || !current()) return;
    const waiting = generation;
    await document.fonts.ready;
    if (busy || waiting !== generation || !current()) return;
    // Always capture current controls. A preview is optional and is never the save gate.
    prepare(dialog.dataset.exportKind === 'drawing');
    if (!artifact) return;
    const selected = artifact,
      ticket = generation,
      observer = toolObserver;
    if (observer && !observer.starting()) {
      close();
      return;
    }
    let observed = false;
    let failureMessage = '';
    busy = true;
    select('svgLabels').disabled = true;
    element('formal-inputs').setAttribute('disabled', '');
    element('formal-save').setAttribute('disabled', '');
    try {
      const ok = await hooks.write(
        selected,
        record !== null || catalog !== null ? 'calculations' : 'drawings',
        select('formal-destination').value === 'external' ? 'external' : 'project',
        (outcome) => {
          observed = true;
          if (outcome.status === 'error') failureMessage = outcome.diagnostics.map(({ message }) => message).join('；');
          observer?.finished(outcome);
        },
      );
      if (ticket === generation && current())
        status(
          ok
            ? '已保存导出文件；实际位置和编号见导出提示。来源 ' + selected.snapshotId + '。'
            : '保存已取消或失败；' + (failureMessage || '本次填写和工程保留，可重试。'),
        );
    } catch (cause: unknown) {
      if (ticket === generation && current()) status('导出失败：' + String(cause).slice(0, 180));
    } finally {
      if (observer) {
        if (!observed)
          observer.finished({
            status: 'error',
            diagnostics: [
              {
                code: 'EXPORT_FAILED',
                field: '/export',
                message: '未取得文件写入回执，请检查工作台诊断。',
                severity: 'error',
                suggestion: '重新捕获后重试。',
              },
            ],
          });
        toolObserver = null;
        close();
      }
      busy = false;
      select('svgLabels').disabled = false;
      element('formal-inputs').removeAttribute('disabled');
      if (current() && artifact) element('formal-save').removeAttribute('disabled');
    }
  }
  element('openDrawingPdf').addEventListener('click', () => open(hooks.exportDefaults().drawing));
  dialog.addEventListener('beforetoggle', (event) => {
    if (!(event instanceof ToggleEvent) || dialog.dataset.exportKind !== 'drawing') return;
    void window.networkAppearance
      ?.setDrawingModal(event.newState === 'open')
      .catch((error: unknown) => console.error('原理图导出未能更新窗口最小化状态', error));
  });
  element('openCalculationWord').addEventListener('click', () => void openSnapshot());
  element('formal-close').addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  element('formal-prepare').addEventListener('click', () => prepare());
  select('formal-format').addEventListener('change', () => {
    element('formal-formula-control').hidden =
      catalog !== null || record === null || select('formal-format').value !== 'docx';
    if (catalog) prepare();
  });
  element('formal-save').addEventListener('click', () => void save());
  element('formal-inputs').addEventListener('input', () => {
    if (!busy) invalidate();
  });
  return {
    prepareToolBatch,
    openToolCatalog(
      preview: NetworkCatalogPreview,
      format: 'docx' | 'md',
      destination: 'project' | 'external',
      observer: ToolDrawingObserver,
    ): boolean {
      const editor = hooks.editor();
      if (
        dialog.open ||
        busy ||
        preview.sourceDocument !== editor.document ||
        preview.documentSessionId !== editor.documentSessionId ||
        preview.revision !== editor.revision
      )
        return false;
      open('docx', null, destination, preview);
      if (!dialog.open) return false;
      select('formal-format').value = format;
      // Keep the confirmed MCP action identical to its eventual receipt.
      select('formal-format').disabled = true;
      select('formal-destination').disabled = true;
      prepare();
      toolObserver = observer;
      return true;
    },
    openToolBook(
      calculation: CalculationRecord,
      format: 'docx' | 'pdf',
      destination: 'project' | 'external',
      observer: ToolDrawingObserver,
    ): boolean {
      if (dialog.open || busy) return false;
      open('docx', calculation, destination);
      if (!dialog.open) return false;
      select('formal-format').value = format;
      element('formal-formula-control').hidden = format !== 'docx';
      prepare();
      toolObserver = observer;
      return true;
    },
    openToolDrawing(
      format: 'svg' | 'pdf',
      destination: 'project' | 'external',
      observer: ToolDrawingObserver,
    ): boolean {
      if (dialog.open || busy) return false;
      open(format, null, destination);
      if (!dialog.open) return false;
      toolObserver = observer;
      return true;
    },
    cancelToolDrawing() {
      if (toolObserver && !busy) close();
    },
    openDrawing: (format: 'svg' | 'pdf', destination?: 'project' | 'external') => open(format, null, destination),
    openBook: (calculation: CalculationRecord) => open('docx', calculation),
    openCatalog(preview: NetworkCatalogPreview) {
      const editor = hooks.editor();
      if (
        preview.sourceDocument !== editor.document ||
        preview.documentSessionId !== editor.documentSessionId ||
        preview.revision !== editor.revision
      )
        return;
      open('docx', null, undefined, preview);
    },
    invalidateIfChanged() {
      if (dialog.open && owner && !current()) close();
    },
  };
}
