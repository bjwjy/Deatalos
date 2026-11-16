import { element } from './network-dom.mjs';
function open(id: string): void {
  const dialog = element(id);
  if (dialog instanceof HTMLDialogElement && !dialog.open) dialog.showModal();
}
/** Reuse the approved HTML header/fold/curve composition around the existing owned controls. */
export function setupNetworkShortcutPresentation(): void {
  const head = (id: string) =>
    element('statusPanels').querySelector<HTMLElement>(`.status-section[data-status-panel="${id}"] .c1-head`);
  function action(id: string, label: string, run: () => void, marker?: string): HTMLButtonElement | undefined {
    const row = head(id);
    if (!row) return;
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'c1-link';
    node.textContent = label;
    if (marker) node.setAttribute(marker, '');
    node.addEventListener('click', run);
    row.insertBefore(node, row.querySelector('.c1-fold-button'));
    return node;
  }
  const phase = document.createElement('span');
  phase.id = 'shortcutRunPhase';
  phase.className = 'c1-state';
  phase.textContent = element('shortcutControllerProgress').dataset.phaseLabel ?? '未初始化';
  phase.dataset.phase = element('shortcutControllerProgress').dataset.phase ?? 'empty';
  head('run')?.insertBefore(phase, head('run')?.querySelector('.c1-fold-button') ?? null);
  action('properties', '设置', () => element('openProperties').click(), 'data-shortcut-open');
  action('results', '更多', () => open('resultDataDialog'));
  action('sizing', '更多', () => open('sizingTools'));
  action('ai', '历史 ↗', () => open('aiCandidateHistory'));
  action('diagnostics', '历史 ↗', () =>
    element('diagnosticsDialog').dispatchEvent(new Event('show-diagnostic-history')),
  );
  const copyAll = element('shortcutDiagnostics').querySelector('[data-shortcut-copy-all-diagnostics]');
  if (copyAll) {
    const row = head('diagnostics');
    row?.insertBefore(copyAll, row.querySelector('.c1-link'));
    row?.classList.add('c3-diagnostic-heading');
  }
  const add = element('instanceControls').querySelector<HTMLButtonElement>('[data-throttle-add]');
  if (add) {
    add.classList.add('c1-link', 'c2-plus');
    const row = head('controls');
    row?.insertBefore(add, row.querySelector('.c1-fold-button'));
  }
  const viewer = element('curveTools');
  const title = element('curveToolsTitle');
  function mode(next: 'chart' | 'export' | 'preview' | 'settings'): void {
    viewer.dataset.shortcutView = next;
    element('curve-hover').hidden = true;
    title.textContent = {
      chart: '曲线查看',
      export: '曲线导出',
      preview: '导出预览',
      settings: '曲线查看与出图',
    }[next];
    const destination = element('curve-destination-field');
    (next === 'export' || next === 'preview' ? exportFields : element('curve-destination-home')).append(destination);
  }
  function chart(next: 'chart' | 'export'): void {
    mode(next);
    viewer.dataset.fromShortcut = 'true';
    element('openCurveTools').click();
  }
  element('openCurveTools').addEventListener(
    'click',
    () => {
      if (!(viewer instanceof HTMLDialogElement) || viewer.open || viewer.dataset.fromShortcut === 'true') return;
      mode('chart');
      viewer.dataset.fromShortcut = 'true';
    },
    true,
  );
  action('curve', '展开', () => chart('chart'), 'data-shortcut-expand-chart');
  const curve = element('sidebarCurve'),
    quantity = element('curveQuantity'),
    refresh = element('refreshCurvePreview'),
    plot = element('curve'),
    status = element('curveStatus'),
    exportButton = element('curveExportSettings');
  const toolbar = document.createElement('div');
  toolbar.className = 'c1-curve-toolbar';
  refresh.className = 'c1-link c1-refresh';
  refresh.textContent = '刷新';
  toolbar.append(quantity, refresh);
  plot.classList.add('c1-chart');
  const footer = document.createElement('footer');
  footer.className = 'c1-curve-footer';
  exportButton.className = 'c1-link';
  exportButton.textContent = '导出';
  exportButton.addEventListener(
    'click',
    () => {
      mode('export');
      viewer.dataset.fromShortcut = 'true';
    },
    true,
  );
  footer.append(status, exportButton);
  curve.replaceChildren(toolbar, plot, footer);
  const resize = document.createElement('div');
  resize.className = 'c1-chart-resize';
  resize.tabIndex = 0;
  resize.setAttribute('role', 'separator');
  resize.setAttribute('aria-label', '调整曲线高度');
  resize.setAttribute('aria-orientation', 'horizontal');
  resize.innerHTML = '<span></span>';
  curve.append(resize);
  let drag: { id: number; y: number; height: number } | undefined;
  const height = (value: number) => {
    const next = Math.max(150, Math.min(480, value));
    plot.style.height = next + 'px';
    resize.setAttribute('aria-valuenow', String(Math.round(next)));
  };
  resize.setAttribute('aria-valuemin', '150');
  resize.setAttribute('aria-valuemax', '480');
  height(190);
  resize.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag = { id: event.pointerId, y: event.clientY, height: plot.getBoundingClientRect().height };
    resize.setPointerCapture(event.pointerId);
  });
  resize.addEventListener('pointermove', (event) => {
    if (drag?.id === event.pointerId) height(drag.height + event.clientY - drag.y);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
    resize.addEventListener(name, () => {
      drag = undefined;
    });
  resize.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    height(plot.getBoundingClientRect().height + (event.key === 'ArrowDown' ? 20 : -20));
  });
  const commands = document.createElement('footer');
  const info = document.createElement('div');
  info.className = 'shortcut-chart-info';
  const details = document.createElement('div');
  details.className = 'c1-inspection-toolbar shortcut-chart-details';
  const inspectLabel = document.createElement('label');
  const inspect = document.createElement('input');
  inspect.type = 'checkbox';
  inspectLabel.append(inspect, ' 数据详细');
  details.append(inspectLabel, element('curveInspectionReadout'));
  inspect.addEventListener('change', () => {
    viewer.dataset.detailsEnabled = String(inspect.checked);
    if (!inspect.checked) element('curve-hover').hidden = true;
  });
  element('curve-frame').before(info, details);
  const source = element('curve-source');
  new MutationObserver(() => {
    info.textContent = source.textContent;
  }).observe(source, { childList: true });
  const exportFields = document.createElement('div');
  exportFields.className = 'shortcut-curve-export-fields';
  exportFields.innerHTML = `<label>输出格式<select id="shortcutCurveFormat"><option value="savePdf">PDF 图</option><option value="saveSvg">SVG 图</option><option value="saveCsv">CSV 数据</option><option value="saveData">曲线数据文件</option></select></label>
    <label>文件名<input id="shortcutCurveName" value="曲线图" maxlength="80"></label>`;
  element('curve-frame').after(exportFields);
  function command(label: string, action: () => void, view: string, primary = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = primary ? 'dialog-button dialog-primary' : 'dialog-button';
    button.textContent = label;
    button.dataset.curveMode = view;
    button.addEventListener('click', action);
    return button;
  }
  commands.className = 'shortcut-chart-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'dialog-button';
  close.textContent = '关闭';
  close.addEventListener('click', () => element('curve-close').click());
  const format = exportFields.querySelector('select');
  const filename = exportFields.querySelector('input');
  if (!format || !filename) throw new Error('Curve export controls missing');
  const target = () => element('curve-' + format.value);
  const preview = command(
    '导出',
    () => {
      if (!filename.value.trim() || /[\\/:*?"<>|\u0000-\u001f]/.test(filename.value) || /[. ]$/.test(filename.value)) {
        element('curve-toolsStatus').textContent = '请填写有效文件名。';
        filename.focus();
        return;
      }
      mode('preview');
    },
    'export',
    true,
  );
  const save = command('保存文件', () => target().click(), 'preview', true);
  const reflect = () => {
    const disabled = target().hasAttribute('disabled');
    preview.disabled = disabled;
    save.disabled = disabled;
  };
  const availability = new MutationObserver(reflect);
  for (const option of format.options)
    availability.observe(element('curve-' + option.value), { attributeFilter: ['disabled'] });
  format.addEventListener('change', reflect);
  reflect();
  commands.append(
    close,
    command('导出', () => mode('export'), 'chart'),
    command('出图设置', () => mode('settings'), 'export'),
    preview,
    command('返回调整', () => mode('export'), 'preview'),
    save,
  );
  viewer.append(commands);
  viewer.addEventListener('close', () => {
    mode('settings');
    delete viewer.dataset.fromShortcut;
    delete viewer.dataset.detailsEnabled;
    inspect.checked = false;
    filename.value = '曲线图';
    format.selectedIndex = 0;
    reflect();
  });
}
