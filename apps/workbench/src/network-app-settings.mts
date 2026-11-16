import { defaultConnectionRadius, type Point } from './network-cad.mjs';
import { branchRevealRadius } from './network-canvas-branch.mjs';
import { element } from './network-dom.mjs';
import { requestNetworkFile } from './network-service-client.mjs';
import { readNetworkTheme, applyNetworkTheme } from './network-v13-theme.mjs';
import type {
  NetworkToolSettingChange,
  NetworkToolSettingsSnapshot,
  NetworkToolSettingOutcome,
} from '@hyd/application';

const exportDirectoryKey = 'deatalos-export-directory-v1';

/** Local interaction preference. Project geometry and runtime remain owned by their existing controllers. */
export function createNetworkAppSettings(changed: () => void, recoveryChanged: () => void) {
  const dialog = element('appSettings');
  if (!(dialog instanceof HTMLDialogElement)) throw new Error('Application settings dialog required');
  const status = element('appSettingsStatus');
  const branchPreview = element('branchRadiusPreview');
  const snap = bindRadius('connectionRadius', 6, 24, defaultConnectionRadius, createSnapPreview(dialog));
  const reveal = bindRadius('branchRevealRadius', 48, 160, branchRevealRadius, (value) =>
    branchPreview.style.setProperty('--branch-preview-diameter', value * 2 + 'px'),
  );
  function showBranchPreview(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    branchPreview.style.left = event.clientX + 'px';
    branchPreview.style.top = event.clientY + 'px';
    if (!branchPreview.matches(':popover-open')) branchPreview.showPopover();
  }
  const hideBranchPreview = () => branchPreview.hidePopover();
  reveal.slider.addEventListener('pointerenter', showBranchPreview);
  reveal.slider.addEventListener('pointermove', showBranchPreview);
  reveal.slider.addEventListener('pointerleave', hideBranchPreview);
  reveal.slider.addEventListener('pointercancel', hideBranchPreview);
  reveal.slider.addEventListener('blur', hideBranchPreview);
  dialog.addEventListener('close', hideBranchPreview);
  const exportStatus = element('appExportStatus');
  const directoryText = element('appExportDirectory');
  const choose = element('chooseExportDirectory');
  const clear = element('clearExportDirectory');
  const drawingFormats = ['pdf', 'png', 'jpg', 'svg'] as const;
  const drawing = bindChoice('appDrawingFormat', drawingFormats, 'pdf');
  const drawingFormatsKey = 'deatalos-drawing-formats-v1';
  const storedFormats = readPreference(drawingFormatsKey);
  const savedFormats = drawingFormats.filter((format) => storedFormats?.split(',').includes(format));
  let enabledDrawingFormats = savedFormats.length
    ? savedFormats
    : drawingFormats.filter((format) => format !== 'svg' || drawing() === 'svg');
  const drawingChecks = [...element('appDrawingFormats').querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const drawingSelector = element('appDrawingFormat');
  if (!(drawingSelector instanceof HTMLSelectElement)) throw new Error('Drawing format selector required');
  const reflectDrawingFormats = (): void => {
    for (const checkbox of drawingChecks)
      checkbox.checked = enabledDrawingFormats.some((format) => format === checkbox.value);
    for (const option of drawingSelector.options) {
      option.hidden = !enabledDrawingFormats.some((format) => format === option.value);
      option.disabled = option.hidden;
    }
  };
  if (!enabledDrawingFormats.includes(drawing())) drawing.set(enabledDrawingFormats[0] ?? 'pdf');
  reflectDrawingFormats();
  for (const checkbox of drawingChecks)
    checkbox.addEventListener('change', () => {
      const next = drawingFormats.filter((format) =>
        drawingChecks.some((input) => input.value === format && input.checked),
      );
      if (!next.length) {
        reflectDrawingFormats();
        exportStatus.textContent = '请至少保留一种原理图格式。';
        return;
      }
      enabledDrawingFormats = next;
      reflectDrawingFormats();
      const savedDefault = next.includes(drawing()) || drawing.set(next[0] ?? 'pdf') === true;
      const saved = storePreference(drawingFormatsKey, next.join(','));
      if (!saved || !savedDefault) exportStatus.textContent = '设置本次有效，无法完整保存到本机。';
    });
  const curve = bindChoice('appCurveFormat', ['pdf', 'svg', 'csv', 'hydcurve'], 'pdf');
  const book = bindChoice('appBookFormat', ['docx', 'pdf'], 'docx');
  const catalog = bindChoice('appCatalogFormat', ['docx', 'md'], 'docx');
  const paper = bindChoice('appDrawingPaper', ['A4', 'A3', 'A2'], 'A3');
  const orientation = bindChoice('appDrawingOrientation', ['portrait', 'landscape'], 'landscape');
  const componentNames = bindChoice('appComponentNames', ['selected', 'always', 'hidden'], 'selected', status, changed);
  const portLabels = bindChoice('appPortLabels', ['selected', 'always', 'hidden'], 'always', status, changed);
  const range = bindChoice('appCurveRange', ['all', '1', '5', '10', '30', '60'], 'all', element('appCurveStatus'));
  const recoveryStatus = element('appRecoveryStatus');
  const interval = bindChoice(
    'appRecoveryInterval',
    ['0', '30', '60', '120', '300', '600'],
    '120',
    recoveryStatus,
    recoveryChanged,
  );
  const copies = bindChoice('appRecoveryCount', ['3', '5', '10', '20'], '5', recoveryStatus, recoveryChanged);
  const savedDirectory = readPreference(exportDirectoryKey);
  let directory =
    savedDirectory && savedDirectory.length <= 32000 && !savedDirectory.includes('\0') ? savedDirectory : null;
  reflectDirectory();
  choose.addEventListener('click', () => void chooseDirectory());
  clear.addEventListener('click', () => setDirectory(null));
  element('resetConnectionRadius').addEventListener('click', () => {
    const snapSaved = snap.reset();
    const revealSaved = reveal.reset();
    notify(snapSaved && revealSaved);
  });
  element('closeAppSettings').addEventListener('click', () => dialog.close());

  function notify(saved: boolean): void {
    status.textContent = saved ? '连线范围已保存到本机。' : '连线范围本次有效，无法保存到本机。';
    changed();
  }

  function readPreference(key: string, feedback = exportStatus): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      feedback.textContent = '无法读取本机偏好，已使用默认设置。';
      return null;
    }
  }
  function storePreference(key: string, value: string | null, feedback = exportStatus): boolean {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      feedback.textContent = '已保存到本机。';
      return true;
    } catch {
      feedback.textContent = '设置本次有效，无法保存到本机。';
      return false;
    }
  }
  function bindChoice<T extends string>(
    id: string,
    options: readonly T[],
    initial: T,
    feedback = exportStatus,
    applied?: () => void,
  ) {
    const control = element(id);
    if (!(control instanceof HTMLSelectElement)) throw new Error('Settings selector required: ' + id);
    const key = 'deatalos-' + id + '-v1';
    const saved = readPreference(key, feedback);
    let format = options.find((option) => option === saved) ?? initial;
    control.value = format;
    const set = (value: string): boolean | null => {
      const next = options.find((option) => option === value);
      if (next === undefined) return null;
      format = next;
      control.value = format;
      const persisted = storePreference(key, format, feedback);
      applied?.();
      return persisted;
    };
    control.addEventListener('change', () => set(control.value));
    return Object.assign(() => format, { set });
  }
  function reflectDirectory(): void {
    directoryText.textContent = directory ?? '随工程归档';
    clear.toggleAttribute('disabled', directory === null || choose.hasAttribute('disabled'));
  }
  function setDirectory(next: string | null): boolean {
    directory = next;
    const persisted = storePreference(exportDirectoryKey, next);
    reflectDirectory();
    return persisted;
  }
  async function chooseDirectory(current: () => boolean = () => true): Promise<boolean | null> {
    choose.setAttribute('disabled', '');
    reflectDirectory();
    try {
      const result = await requestNetworkFile({ action: 'choose-export-directory' });
      if (!current()) return null;
      if (result.status === 'ok' && result.operation === 'choose-export-directory') return setDirectory(result.path);
      if (result.status !== 'cancelled') exportStatus.textContent = '无法选择目录，请重试。';
      return null;
    } finally {
      choose.removeAttribute('disabled');
      reflectDirectory();
    }
  }

  function bindRadius(id: string, minimum: number, maximum: number, initial: number, preview: (value: number) => void) {
    const input = element(id);
    if (!(input instanceof HTMLInputElement)) throw new Error('Range input required: ' + id);
    const slider = input;
    const output = element(id + 'Value');
    const key = 'deatalos-' + id + '-v1';
    const valid = (value: number) => Number.isInteger(value) && value >= minimum && value <= maximum;
    let radius = initial;
    slider.min = String(minimum);
    slider.max = String(maximum);
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null && valid(Number(saved))) radius = Number(saved);
    } catch {
      status.textContent = '无法读取本机偏好，已使用默认连线范围。';
    }
    function reflect(value: number): void {
      output.textContent = value + ' px';
      preview(value);
    }
    function apply(value: number): boolean {
      radius = value;
      slider.value = String(radius);
      reflect(radius);
      try {
        localStorage.setItem(key, String(radius));
        return true;
      } catch {
        return false;
      }
    }
    slider.value = String(radius);
    reflect(radius);
    slider.addEventListener('input', () => reflect(slider.valueAsNumber));
    slider.addEventListener('change', () => {
      if (valid(slider.valueAsNumber)) notify(apply(slider.valueAsNumber));
    });
    return {
      slider,
      get radius() {
        return radius;
      },
      reset: () => apply(initial),
      set(value: number): boolean | null {
        if (!valid(value)) return null;
        const persisted = apply(value);
        notify(persisted);
        return persisted;
      },
    };
  }

  const choices = {
    drawingFormat: drawing,
    curveFormat: curve,
    bookFormat: book,
    catalogFormat: catalog,
    drawingPaper: paper,
    drawingOrientation: orientation,
    componentNames,
    portLabels,
    curveRange: range,
    recoveryInterval: interval,
    recoveryCopies: copies,
  };
  function toolSnapshot(): NetworkToolSettingsSnapshot {
    return {
      connectionRadius: snap.radius,
      branchRevealRadius: reveal.radius,
      drawingFormat: drawing(),
      curveFormat: curve(),
      bookFormat: book(),
      catalogFormat: catalog(),
      drawingPaper: paper(),
      drawingOrientation: orientation(),
      componentNames: componentNames(),
      portLabels: portLabels(),
      curveRange: range(),
      recoveryInterval: interval(),
      recoveryCopies: copies(),
      exportDirectory: directory,
      theme: readNetworkTheme(),
    };
  }
  async function toolApply(
    change: NetworkToolSettingChange,
    current: () => boolean,
  ): Promise<NetworkToolSettingOutcome> {
    if (!current())
      return {
        key: change.key,
        applied: false,
        persisted: false,
        value: toolSnapshot()[change.key],
        message: '连接或工程已退役，未继续应用。',
      };
    let persisted: boolean | null,
      applied = true;
    if (change.key === 'theme') {
      const result = await applyNetworkTheme(change.value);
      persisted = result.persisted;
      applied = result.applied;
    } else if (change.key === 'connectionRadius' || change.key === 'branchRevealRadius') {
      persisted = (change.key === 'connectionRadius' ? snap : reveal).set(change.value);
      applied = persisted !== null;
    } else if (change.key === 'exportDirectory') {
      persisted =
        change.value === 'project'
          ? setDirectory(null)
          : change.value === 'choose'
            ? await chooseDirectory(current)
            : null;
      applied = persisted !== null;
    } else {
      if (typeof change.value !== 'string')
        return {
          key: change.key,
          applied: false,
          persisted: false,
          value: toolSnapshot()[change.key],
          message: '选项设置必须为已登记文本值，未应用。',
        };
      if (change.key === 'drawingFormat') {
        const format = drawingFormats.find((value) => value === change.value);
        if (format && !enabledDrawingFormats.includes(format)) {
          enabledDrawingFormats = drawingFormats.filter(
            (value) => value === format || enabledDrawingFormats.includes(value),
          );
          reflectDrawingFormats();
          const savedFormats = storePreference(drawingFormatsKey, enabledDrawingFormats.join(','));
          persisted = drawing.set(format) === true && savedFormats;
        } else persisted = drawing.set(change.value);
      } else persisted = choices[change.key].set(change.value);
      applied = persisted !== null;
    }
    return {
      key: change.key,
      applied,
      persisted,
      value: toolSnapshot()[change.key],
      message: !applied
        ? '本项未应用；选择已取消、接口忙或值无效。'
        : persisted === true
          ? '已应用并保存本机偏好；后台清理和原生标题栏效果另行执行。'
          : '本次设置有效；本机持久化未获确认。',
    };
  }
  return {
    toolSnapshot,
    toolApply,
    get exportDirectory() {
      return directory;
    },
    exportDefaults: () => ({
      drawing: drawing(),
      drawingFormats: [...enabledDrawingFormats],
      curve: curve(),
      book: book(),
      catalog: catalog(),
      paper: paper(),
      orientation: orientation(),
      destination: directory ? ('external' as const) : ('project' as const),
    }),
    canvasLabels: () => ({ components: componentNames(), ports: portLabels() }),
    curveRangeSeconds: () => (range() === 'all' ? null : Number(range())),
    recovery: () => ({ intervalMs: Number(interval()) * 1000, copies: Number(copies()) }),
    get connectionRadius() {
      return snap.radius;
    },
    get branchRevealRadius() {
      return reveal.radius;
    },
  };
}

/** Isolated two-node trial. Both the sample radius and hit distance are measured in CSS pixels. */
function createSnapPreview(dialog: HTMLDialogElement): (value: number) => void {
  const preview = document.getElementById('connectionRadiusPreview');
  if (!(preview instanceof SVGSVGElement)) throw new Error('Connection preview SVG missing');
  const svg = preview;
  const node = svg.querySelector('[data-snap-node]');
  const range = svg.querySelector('[data-snap-range]');
  const line = svg.querySelector('[data-snap-line]');
  if (!(node instanceof SVGCircleElement) || !(range instanceof SVGCircleElement) || !(line instanceof SVGLineElement))
    throw new Error('Connection preview marks missing');
  const target = new DOMPoint(node.cx.baseVal.value, node.cy.baseVal.value);
  const ring = range;
  const trialLine = line;
  const status = element('connectionPreviewStatus');
  let radius = defaultConnectionRadius;
  let pointer: Point | undefined;

  function state(value: 'idle' | 'free' | 'snapped'): void {
    if (svg.dataset.snapState === value) return;
    svg.dataset.snapState = value;
    status.textContent = { idle: '移近试吸附', free: '未吸附', snapped: '已吸附' }[value];
  }
  function draw(): void {
    const matrix = svg.getScreenCTM();
    if (!pointer || !matrix) return;
    const center = target.matrixTransform(matrix);
    const snapped = Math.hypot(pointer.x - center.x, pointer.y - center.y) <= radius;
    const end = snapped ? target : new DOMPoint(pointer.x, pointer.y).matrixTransform(matrix.inverse());
    trialLine.x2.baseVal.value = end.x;
    trialLine.y2.baseVal.value = end.y;
    state(snapped ? 'snapped' : 'free');
  }
  svg.addEventListener('pointermove', (event) => {
    pointer = { x: event.clientX, y: event.clientY };
    draw();
  });
  const clear = () => {
    pointer = undefined;
    state('idle');
  };
  svg.addEventListener('pointerleave', clear);
  svg.addEventListener('pointercancel', clear);
  dialog.addEventListener('close', clear);
  return (value) => {
    radius = value;
    ring.r.baseVal.value = radius;
    draw();
  };
}

export type NetworkExportDefaults = ReturnType<ReturnType<typeof createNetworkAppSettings>['exportDefaults']>;
