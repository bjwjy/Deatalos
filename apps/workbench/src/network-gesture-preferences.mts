import { element } from './network-dom.mjs';
import { networkUiIcon, type NetworkUiIcon } from './network-v13-icons.mjs';

const directions = ['右', '右下', '下', '左下', '左', '左上', '上', '右上'] as const;
const gestureCommands = {
  none: '未绑定',
  trim: '裁剪多余管段',
  fitAll: '适合全图',
  text: '放置文字',
  arrangeComponents: '自动摆放',
  undo: '撤销',
  redo: '重做',
  rotateSelected: '旋转 90°',
  addNode: '添加分支节点',
  manualRoute: '编辑手动路径',
  autoRoute: '恢复自动布线',
  mergeRoute: '合并近共线线段',
};
export type GestureCommand = keyof typeof gestureCommands;
const defaults: readonly GestureCommand[] = [
  'text',
  'none',
  'arrangeComponents',
  'none',
  'trim',
  'none',
  'fitAll',
  'none',
];
const storageKey = 'deatalos.canvas.mouseGestures.v1';
const isCommand = (value: unknown): value is GestureCommand =>
  typeof value === 'string' && Object.hasOwn(gestureCommands, value);

const icons: Record<GestureCommand, NetworkUiIcon> = {
  none: 'minus',
  trim: 'cut',
  fitAll: 'expand',
  text: 'text',
  arrangeComponents: 'grid',
  undo: 'undo',
  redo: 'redo',
  rotateSelected: 'rotate-clockwise',
  addNode: 'node',
  manualRoute: 'connect',
  autoRoute: 'reset',
  mergeRoute: 'align',
};
const defaultInner = 70,
  defaultOuter = 115;
function readRadius(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}
function polar(radius: number, angle: number) {
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}
function sectorPath(index: number, active: number, mode: number, inner: number, outer: number) {
  const step = 8 / mode,
    half = Math.PI / mode,
    extra = (half * 4) / 9;
  const center = (index * Math.PI) / 4;
  const previous = (index - step + 8) % 8,
    next = (index + step) % 8;
  const start = center - half + (index === active ? -extra : previous === active ? extra : 0);
  const end = center + half + (index === active ? extra : next === active ? -extra : 0);
  return (
    'M' +
    polar(outer, start) +
    ' A' +
    outer +
    ' ' +
    outer +
    ' 0 0 1 ' +
    polar(outer, end) +
    ' L' +
    polar(inner, end) +
    ' A' +
    inner +
    ' ' +
    inner +
    ' 0 0 0 ' +
    polar(inner, start) +
    ' Z'
  );
}
function gestureIndex(angle: number, active: number, mode: number) {
  const delta = angle - (active * Math.PI) / 4;
  if (active >= 0 && Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) <= (Math.PI / mode) * (1 + 4 / 9))
    return active;
  const slot = Math.round((angle * mode) / (2 * Math.PI));
  return ((slot + mode) % mode) * (8 / mode);
}
function ringMarkup(
  mode: 4 | 8,
  bindings: readonly GestureCommand[],
  interactive: boolean,
  inner: number,
  outer: number,
) {
  const extent = outer + 4;
  const middle = (inner + outer) / 2;
  const size = Math.min(17, (outer - inner) * 0.64);
  const slices: string[] = [];
  for (let i = 0; i < 8; i += 8 / mode) {
    const command = bindings[i]!;
    const center = (i * Math.PI) / 4;
    const wedge = sectorPath(i, -1, mode, inner, outer);
    const x = middle * Math.cos(center) - size / 2,
      y = middle * Math.sin(center) - size / 2;
    const label = '向' + directions[i] + ' · ' + gestureCommands[command];
    const control = interactive ? 'role="button" tabindex="0" aria-label="' + label + '"' : '';
    slices.push(
      '<g data-sector="' +
        i +
        '" ' +
        control +
        '><path class="gesture-slice" d="' +
        wedge +
        '"/><g class="gesture-glyph" transform="translate(' +
        x +
        ' ' +
        y +
        ')">' +
        networkUiIcon(icons[command], size) +
        '</g></g>',
    );
  }
  return (
    '<svg class="gesture-ring" viewBox="' +
    [-extent, -extent, extent * 2, extent * 2].join(' ') +
    '" aria-label="笔势方向">' +
    '<circle class="gesture-band" r="' +
    middle +
    '" stroke-width="' +
    (outer - inner) +
    '"/>' +
    slices.join('') +
    '<circle class="gesture-rim" r="' +
    inner +
    '"/><circle class="gesture-rim" r="' +
    outer +
    '"/></svg>'
  );
}
function highlight(host: HTMLElement, index: number, mode: number, inner: number, outer: number) {
  for (const sector of host.querySelectorAll<SVGElement>('[data-sector]')) {
    const selected = Number(sector.dataset.sector) === index;
    sector.classList.toggle('chosen', selected);
    sector
      .querySelector('.gesture-slice')
      ?.setAttribute('d', sectorPath(Number(sector.dataset.sector), index, mode, inner, outer));
  }
}

export function setupGesturePreferences() {
  let mode: 4 | 8 = 4;
  let bindings = [...defaults];
  let inner = defaultInner,
    outer = defaultOuter;
  let ratio: number | null = null;
  let triggerDistance = 14;
  const sensitivity = element('gestureSensitivity') as HTMLSelectElement;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (
      typeof saved?.triggerDistance === 'number' &&
      Array.from(sensitivity.options).some((option) => option.value === String(saved.triggerDistance))
    )
      triggerDistance = saved.triggerDistance;
    else if (saved?.triggerDistance === 3 || saved?.triggerDistance === 5) triggerDistance = 7;
    outer = readRadius(saved?.outer, 56, 156, defaultOuter);
    inner = Math.min(readRadius(saved?.inner, 16, 96, defaultInner), outer - 1);
    if (
      typeof saved?.ratio === 'number' &&
      saved.ratio > 0 &&
      saved.ratio < 1 &&
      Math.abs(saved.ratio * outer - inner) <= 1
    )
      ratio = saved.ratio;
    if (saved && (saved.mode === 4 || saved.mode === 8)) mode = saved.mode;
    if (Array.isArray(saved?.bindings))
      bindings = defaults.map((fallback, i) => (isCommand(saved.bindings[i]) ? saved.bindings[i] : fallback));
  } catch {
    /* Use defaults when browser storage is unavailable. */
  }
  const modeField = element('gestureMode') as HTMLSelectElement;
  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ mode, bindings, inner, outer, ratio, triggerDistance }));
    } catch {
      element('gestureSettingsStatus').textContent = '当前配置仅在本次使用期间有效。';
    }
  }
  // Prefer the four principal directions when opening older settings with duplicates.
  const seen = new Set<GestureCommand>();
  let repaired = false;
  for (const i of [0, 2, 4, 6, 1, 3, 5, 7]) {
    const command = bindings[i]!;
    if (command === 'none') continue;
    if (seen.has(command)) {
      bindings[i] = 'none';
      repaired = true;
    }
    seen.add(command);
  }
  if (repaired) save();
  const wheel = element('gestureBindings'),
    overlay = element('canvasGestureWheel');
  const palette = element('gesturePalette');
  const directionLabel = element('gestureDirection');
  let selected = 6;
  let dragged: GestureCommand | null = null;
  const commands = (Object.keys(gestureCommands) as GestureCommand[]).filter((id) => id !== 'none');
  for (const id of [...commands, 'none'] as GestureCommand[]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.gestureCommand = id;
    button.innerHTML =
      networkUiIcon(icons[id], 16) + '<span>' + (id === 'none' ? '清除绑定' : gestureCommands[id]) + '</span>';
    button.addEventListener('click', () => bind(selected, id));
    button.addEventListener('dragstart', (event) => {
      if (!event.dataTransfer || button.disabled) {
        event.preventDefault();
        return;
      }
      dragged = id;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('application/x-deatalos-gesture', id);
      highlight(wheel, -1, mode, inner, outer);
    });
    palette.append(button);
  }
  palette.addEventListener('dragend', () => {
    dragged = null;
    highlight(wheel, selected, mode, inner, outer);
  });
  function select(index: number) {
    selected = index;
    highlight(wheel, index, mode, inner, outer);
    for (const sector of wheel.querySelectorAll<SVGElement>('[data-sector]'))
      sector.setAttribute('aria-pressed', String(Number(sector.dataset.sector) === selected));
    directionLabel.textContent = '向' + directions[index] + ' · ' + gestureCommands[bindings[index]!];
  }
  const innerField = element('gestureInner') as HTMLInputElement;
  const outerField = element('gestureOuter') as HTMLInputElement;
  const lock = element('gestureRatioLock');
  function render() {
    for (const button of palette.querySelectorAll<HTMLButtonElement>('button[data-gesture-command]')) {
      const command = button.dataset.gestureCommand as GestureCommand;
      const at = command === 'none' ? -1 : bindings.indexOf(command);
      button.disabled = at >= 0;
      button.draggable = at < 0;
      button.title = at < 0 ? '' : '已绑定到' + (mode === 4 && at % 2 ? '八向模式的' : '') + '向' + directions[at];
    }
    lock.setAttribute('aria-pressed', String(ratio !== null));
    lock.title = ratio === null ? '内外环独立调节，点击锁定当前比例' : '内外环等比调节，点击解锁';
    lock.innerHTML = networkUiIcon(ratio === null ? 'unlock' : 'lock') + '<span>比例锁</span>';
    sensitivity.value = String(triggerDistance);
    innerField.value = String(inner);
    outerField.value = String(outer);
    element('gestureInnerValue').textContent = inner + ' px';
    element('gestureOuterValue').textContent = outer + ' px';
    for (const host of [wheel, element('canvasGestureHint')])
      host.style.setProperty('--gesture-diameter', (outer + 4) * 2 + 'px');
    modeField.value = String(mode);
    wheel.innerHTML = ringMarkup(mode, bindings, true, inner, outer);
    overlay.innerHTML = ringMarkup(mode, bindings, false, inner, outer);
    select(selected);
  }
  sensitivity.addEventListener('change', () => {
    triggerDistance = Number(sensitivity.value);
    save();
  });
  lock.addEventListener('click', () => {
    ratio = ratio === null ? inner / outer : null;
    render();
    save();
  });
  for (const slider of [innerField, outerField])
    slider.addEventListener('input', () => {
      if (ratio !== null) {
        const requestedOuter = slider === innerField ? innerField.valueAsNumber / ratio : outerField.valueAsNumber;
        const scaled = Math.max(56, 16 / ratio, Math.min(156, 96 / ratio, requestedOuter));
        outer = Math.round(scaled);
        inner = Math.min(outer - 1, Math.round(scaled * ratio));
      } else if (slider === innerField) {
        inner = Math.min(innerField.valueAsNumber, outer - 1);
      } else {
        outer = Math.max(outerField.valueAsNumber, inner + 1);
      }
      render();
      save();
    });
  function pick(event: Event) {
    if (!(event.target instanceof Element)) return;
    const sector = event.target.closest<SVGElement>('[data-sector]');
    if (sector) select(Number(sector.dataset.sector));
  }
  wheel.addEventListener('pointermove', (event) => {
    if (!(event.target instanceof Element)) return;
    const sector = event.target.closest<SVGElement>('[data-sector]');
    const index = sector ? Number(sector.dataset.sector) : selected;
    if (!wheel.querySelector('[data-sector="' + index + '"].chosen')) highlight(wheel, index, mode, inner, outer);
  });
  wheel.addEventListener('pointerleave', () => highlight(wheel, selected, mode, inner, outer));
  wheel.addEventListener('click', pick);
  wheel.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    pick(event);
  });
  function bind(index: number, command: GestureCommand) {
    if (command !== 'none' && bindings.includes(command)) return;
    selected = index;
    bindings[index] = command;
    render();
    save();
  }
  function dropSector(event: DragEvent) {
    return event.target instanceof Element ? event.target.closest<SVGElement>('[data-sector]') : null;
  }
  wheel.addEventListener('dragover', (event) => {
    if (!dragged || !event.dataTransfer) return;
    const sector = dropSector(event);
    highlight(wheel, sector ? Number(sector.dataset.sector) : -1, mode, inner, outer);
    if (!sector) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  wheel.addEventListener('drop', (event) => {
    const sector = dropSector(event);
    if (!dragged || !sector) return;
    event.preventDefault();
    bind(Number(sector.dataset.sector), dragged);
    dragged = null;
  });
  modeField.addEventListener('change', () => {
    mode = modeField.value === '8' ? 8 : 4;
    if (mode === 4 && selected % 2) selected = 6;
    render();
    save();
  });
  element('resetGestureBindings').addEventListener('click', () => {
    mode = 4;
    triggerDistance = 14;
    ratio = null;
    inner = defaultInner;
    outer = defaultOuter;
    bindings = [...defaults];
    selected = 6;
    render();
    save();
  });
  render();
  return {
    get innerRadius() {
      return inner;
    },
    get triggerDistance() {
      return triggerDistance;
    },
    get outerRadius() {
      return outer;
    },
    highlight: (index: number) => highlight(overlay, index, mode, inner, outer),
    resolve(dx: number, dy: number, active: number | null) {
      const index = gestureIndex(Math.atan2(dy, dx), active ?? -1, mode);
      return { command: bindings[index]!, index };
    },
  };
}
