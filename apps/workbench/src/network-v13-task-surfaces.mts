import { element } from './network-dom.mjs';
import { drawingSwitch, drawingViewport } from './network-formal-drawing-view.mjs';

interface Tab {
  readonly key: string;
  readonly label: string;
  readonly pane: HTMLElement;
}
/** Pure view navigation: panes retain the existing owners' DOM, buffers and listeners. */
function tabs(
  host: HTMLElement,
  items: readonly Tab[],
  selected: (key: string) => void = () => {},
  orientation: 'horizontal' | 'vertical' = 'horizontal',
): (key: string) => void {
  const row = document.createElement('div');
  row.className = 'b3-tabs';
  row.setAttribute('role', 'tablist');
  row.setAttribute('aria-orientation', orientation);
  const indicator = document.createElement('span');
  indicator.className = 'b3-tab-glide';
  indicator.setAttribute('aria-hidden', 'true');
  row.append(indicator);
  let current = items[0]?.key;
  function reflect(): void {
    if (orientation === 'vertical') return;
    const button = row.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    if (button) {
      indicator.style.width = button.offsetWidth + 'px';
      indicator.style.transform = `translateX(${button.offsetLeft}px)`;
    }
  }
  function activate(key: string): void {
    if (!items.some((item) => item.key === key)) return;
    current = key;
    for (const item of items) {
      item.pane.hidden = item.key !== key;
      const button = row.querySelector<HTMLButtonElement>(`[data-tab="${item.key}"]`);
      button?.setAttribute('aria-selected', String(item.key === key));
      if (button) button.tabIndex = item.key === key ? 0 : -1;
    }
    selected(key);
    reflect();
  }
  for (const item of items) {
    item.pane.classList.add('b3-pane');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.dataset.tab = item.key;
    button.setAttribute('role', 'tab');
    button.id = host.id + '-tab-' + item.key;
    if (!item.pane.id) item.pane.id = button.id + '-pane';
    button.setAttribute('aria-controls', item.pane.id);
    item.pane.setAttribute('role', 'tabpanel');
    item.pane.setAttribute('aria-labelledby', button.id);
    button.addEventListener('click', () => activate(item.key));
    button.addEventListener('keydown', (event) => {
      const index = items.findIndex((value) => value.key === current);
      const next =
        event.key === (orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight')
          ? (index + 1) % items.length
          : event.key === (orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft')
            ? (index - 1 + items.length) % items.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : undefined;
      const target = next === undefined ? undefined : items[next];
      if (target) {
        event.preventDefault();
        activate(target.key);
        row.querySelector<HTMLButtonElement>(`[data-tab="${target.key}"]`)?.focus();
      }
    });
    row.append(button);
  }
  host.prepend(row);
  if (current) activate(current);
  host.closest('dialog')?.addEventListener('toggle', reflect);
  window.addEventListener('resize', reflect);
  return activate;
}
function pane(): HTMLDivElement {
  const node = document.createElement('div');
  node.className = 'b3-pane';
  return node;
}
function calculation(rootId: string, prefix: string, sizing: boolean): void {
  const root = element(rootId);
  const host = element(sizing ? 'sizingForm' : rootId);
  const goal = root.querySelector<HTMLElement>(':scope>.goal-tools');
  const catalog = root.querySelector<HTMLElement>(':scope>.catalog-tools');
  if (!goal || !catalog) throw new Error('Calculation task views missing');
  const demand = pane();
  const comparison = pane();
  const check = document.createElement('section');
  check.className = 'calculation-current-check';
  root.closest('dialog')?.classList.add('calculation-workflow');
  root.classList.add('calculation-workflow-root');
  demand.classList.add('calculation-demand');
  comparison.classList.add('calculation-comparison');
  const originals = [...root.childNodes];
  root.append(demand, comparison);
  for (const child of originals) if (child !== goal && child !== catalog) demand.append(child);
  check.append(element(prefix + 'Result'));
  comparison.append(check, goal);
  const actions = document.createElement('div');
  actions.className = 'calculation-main-actions';
  actions.append(element(prefix + 'Preview'), element(prefix + 'Select'));
  demand.append(actions);
  for (const suffix of ['Cancel', 'Apply', 'Export', 'Word']) element(prefix + suffix).hidden = true;
  element(prefix + 'Preview').classList.add('calculation-run');
  element(prefix + 'Select').classList.add('primary');
  const resize = sizing ? element('sizingResize') : null;
  const mode = sizing ? element('sizingMode') : null;
  if (mode instanceof HTMLSelectElement) mode.closest('label')?.setAttribute('hidden', '');
  if (resize) {
    const estimate = document.createElement('details');
    estimate.className = 'calculation-estimate';
    const title = document.createElement('summary');
    title.textContent = '单缸尺寸估算';
    resize.hidden = false;
    estimate.append(title, resize);
    demand.insertBefore(estimate, actions);
  }
  root.append(demand, comparison, catalog);
  const activate = tabs(
    root,
    [
      { key: 'demand', label: '工况与目标', pane: demand },
      { key: 'goal', label: '方案比较', pane: comparison },
      { key: 'catalog', label: '选型与导出', pane: catalog },
    ],
    (key) => {
      if (key === 'catalog') catalog.dispatchEvent(new Event('calculation:catalog'));
    },
  );
  root.addEventListener('calculation:invalid', () => activate('demand'));
  element(prefix + 'Preview').addEventListener('click', () => {
    if (root.closest('dialog')?.open && element(prefix + 'Result').textContent?.trim()) activate('goal');
  });
  const reflect = () => {
    check.hidden = !!goal.querySelector('[data-goal-result]')?.textContent?.trim();
  };
  const goalResult = goal.querySelector('[data-goal-result]');
  if (goalResult) new MutationObserver(reflect).observe(goalResult, { childList: true, subtree: true });
  reflect();
  host.classList.add('calculation-workflow-host');
}

function curve(): void {
  const dialog = element('curveTools'),
    body = dialog.querySelector<HTMLElement>(':scope>.dialog-body');
  if (!body) return;
  const layout = pane(),
    settings = pane(),
    chart = pane();
  layout.className = 'b3-curve-layout';
  settings.className = 'b3-curve-settings';
  const settingsNode = element('curve-settings');
  for (const child of [...body.childNodes]) {
    // Retain the history panel's origin comment in the settings column while the sidebar borrows its node.
    if (child instanceof Comment && child.data === 'status-origin:history') settings.append(child);
    else if (child instanceof HTMLElement && ['curve-settings', 'recordSourcePanel', 'curve-source'].includes(child.id))
      settings.append(child);
    else chart.append(child);
  }
  settingsNode.classList.add('white-curve-controls');
  layout.append(settings, chart);
  body.append(layout);
  element('curve-frame').classList.add('b3-chart-frame');
  dialog.querySelector('.curve-primary-actions')?.classList.add('b3-chart-actions');
}
function formal(): void {
  const dialog = element('formalExport'),
    body = dialog.querySelector<HTMLElement>(':scope>.dialog-body');
  if (!body) return;
  const controls = element('formal-inputs'),
    preview = pane(),
    inputPane = pane(),
    page = pane();
  page.className = 'b3-formal-layout';
  page.id = 'formal-layout';
  inputPane.classList.add('formal-settings-pane');
  inputPane.append(controls);
  preview.className = 'white-formal-preview';
  const previewSurface = element('formal-preview');
  preview.append(element('formal-status'), previewSurface);
  const toolbar = document.createElement('div');
  toolbar.className = 'white-book-toolbar';
  const fit = document.createElement('button');
  fit.type = 'button';
  fit.textContent = '适合宽度';
  const zoom = document.createElement('select');
  zoom.setAttribute('aria-label', '文档预览比例');
  zoom.innerHTML =
    '<option value=".5">50%</option><option value=".75">75%</option><option value=".85" selected>85%</option><option value="1">100%</option><option value="1.25">125%</option>';
  const applyZoom = (value: number) => element('formal-preview').style.setProperty('--book-zoom', String(value));
  zoom.addEventListener('change', () => {
    const value = Number(zoom.value);
    if ([0.5, 0.75, 0.85, 1, 1.25].includes(value)) applyZoom(value);
  });
  fit.addEventListener('click', () =>
    applyZoom(Math.max(0.4, Math.min(1.25, (element('formal-preview').clientWidth - 40) / 520))),
  );
  toolbar.append(fit, zoom);
  const drawingTools = drawingViewport(previewSurface);
  preview.prepend(toolbar, drawingTools);
  for (const child of [...body.childNodes]) if (child !== controls && child !== page) inputPane.append(child);
  page.append(inputPane, preview);
  body.append(page);
  element('formal-paper-controls').classList.add('b3-grid');
  const fields = element('formal-fields'),
    information = pane(),
    signatures = pane(),
    output = pane(),
    template = pane();
  const signatureKeys = new Set([
    'designName',
    'designDate',
    'checkName',
    'checkDate',
    'reviewName',
    'reviewDate',
    'processName',
    'processDate',
    'standardName',
    'standardDate',
    'approveName',
    'approveDate',
  ]);
  const labels = [...fields.querySelectorAll<HTMLElement>('label:has([data-formal-field])')];
  for (const label of labels) {
    const input = label.querySelector<HTMLElement>('[data-formal-field]');
    (signatureKeys.has(input?.dataset.formalField || '') || label.closest('#formal-custom-values')
      ? signatures
      : information
    ).append(label);
  }
  for (const changes of fields.querySelectorAll('fieldset')) signatures.append(changes);
  for (const empty of fields.querySelectorAll(':scope>div,:scope>details'))
    if (!empty.querySelector('input') && empty.id !== 'formal-custom-values') empty.remove();
  information.classList.add('b3-grid');
  const editTitle = document.createElement('button');
  editTitle.id = 'formal-edit-title';
  editTitle.type = 'button';
  editTitle.textContent = '放大标题栏填写 ↗';
  information.append(editTitle);
  signatures.hidden = true;
  const customValues = element('formal-custom-values');
  signatures.append(customValues);
  fields.append(information, signatures);
  const templateControls = element('formal-template-panel');
  templateControls.before(template);
  template.append(templateControls);
  if (templateControls instanceof HTMLDetailsElement) templateControls.open = true;
  for (const child of [...controls.childNodes])
    if (child !== fields && child !== template && !(child instanceof HTMLElement && child.id === 'formal-prepare'))
      output.append(child);
  controls.prepend(output);
  const activate = tabs(
    page,
    [
      { key: 'output', label: '输出设置', pane: output },
      { key: 'information', label: '工程信息', pane: information },
      { key: 'template', label: '工程模板', pane: template },
    ],
    () => {
      inputPane.scrollTop = 0;
    },
  );
  const destination = element('formal-destination').closest('label');
  for (const [id, label] of [
    ['svgLabels', '图中名称'],
    ['formal-orientation', '方向'],
    ['formal-binding', '装订边'],
  ] as const)
    drawingSwitch(id, label);
  dialog.addEventListener('beforetoggle', (event) => {
    if (!(event instanceof ToggleEvent) || event.newState !== 'open') return;
    if (dialog.dataset.exportKind === 'drawing') {
      if (destination) output.append(destination);
      drawingTools.append(element('formal-prepare'));
    } else {
      if (destination) inputPane.insertBefore(destination, element('formal-drawing-help'));
      controls.append(element('formal-prepare'));
    }
  });
  dialog.addEventListener('toggle', () => {
    if (dialog instanceof HTMLDialogElement && dialog.open) activate('output');
  });
  const reflect = () => {
    for (const key of ['information', 'template']) {
      const tab = page.querySelector<HTMLButtonElement>(`[data-tab="${key}"]`);
      if (tab) tab.disabled = key === 'template' ? templateControls.hidden === true : fields.hidden === true;
    }
  };
  new MutationObserver(reflect).observe(fields, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(reflect).observe(templateControls, { attributes: true, attributeFilter: ['hidden'] });
  reflect();
  element('formal-save').classList.add('dialog-primary');
}
function ai(): void {
  const root = element('externalTools');
  const dialog = element('externalToolsDialog');
  root.classList.add('settings-tabs');
  dialog.querySelector(':scope > .v13-dialog-body')?.classList.add('settings-tab-body');
  const activate = tabs(
    root,
    [
      { key: 'advanced', label: '本机连接', pane: element('aiConnection') },
      { key: 'candidate', label: '修改候选', pane: element('aiCandidatePane') },
      { key: 'ordinary', label: '手动建议', pane: element('aiOrdinarySettings') },
    ],
    undefined,
    'vertical',
  );
  dialog.addEventListener('show-ai-candidate', () => {
    activate('candidate');
    root.querySelector<HTMLElement>('[data-tab="candidate"]')?.focus({ preventScroll: true });
  });
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-ai-mode]') : null;
    if (button?.dataset.aiMode) activate(button.dataset.aiMode);
  });
}
export function setupNetworkTaskSurfaces(): void {
  tabs(
    element('appSettingsTabs'),
    [
      { key: 'appearance', label: '外观', pane: element('appAppearanceSettings') },
      { key: 'canvas', label: '画布与连线', pane: element('appCanvasSettings') },
      { key: 'gestures', label: '鼠标笔势', pane: element('appGestureSettings') },
      { key: 'ai-control', label: 'AI 控制', pane: element('appAiSettings') },
      { key: 'simulation', label: '仿真', pane: element('appSimulationSettings') },
      { key: 'curve', label: '曲线', pane: element('appCurveSettings') },
      { key: 'export', label: '导出', pane: element('appExportSettings') },
      { key: 'recovery', label: '工程恢复', pane: element('appRecoverySettings') },
    ],
    undefined,
    'vertical',
  );
  calculation('basicDutyForm', 'basic', true);
  calculation('dutyForm', 'duty', false);
  curve();
  formal();
  ai();
}
