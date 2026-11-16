import type { NetworkDefinition } from '@hyd/domain';
import { element } from './network-dom.mjs';
import { setupComponentLibrary, type LibraryMode } from './network-component-library.mjs';
import type { ValveLibrary } from './network-valve-library.mjs';

type LibraryState = 'open' | 'minimized' | 'closed';
interface WorkspacePreference {
  readonly version: 5;
  readonly inspectorWidth: number;
  readonly library: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly state: LibraryState;
    readonly mode: LibraryMode;
  };
}
const preferenceKey = 'hydraulic-network-workspace-v5';
const initial: WorkspacePreference = {
  version: 5,
  inspectorWidth: 350,
  library: { x: 16, y: 16, width: 240, height: 440, state: 'open', mode: 'scroll' },
};
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
function validNumber(value: unknown, low: number, high: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
}
function parsePreference(value: unknown): WorkspacePreference | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    (value.version !== 2 && value.version !== 3 && value.version !== 4 && value.version !== 5) ||
    !('inspectorWidth' in value) ||
    !validNumber(value.inspectorWidth, 240, 560) ||
    !('library' in value)
  )
    return null;
  const library = value.library;
  if (
    !library ||
    typeof library !== 'object' ||
    !('x' in library) ||
    !validNumber(library.x, 0, 1000000) ||
    !('y' in library) ||
    !validNumber(library.y, 0, 1000000) ||
    !('state' in library) ||
    (library.state !== 'open' && library.state !== 'minimized' && library.state !== 'closed')
  )
    return null;
  if (value.version === 2) {
    if (!('sidebarWidth' in value) || !validNumber(value.sidebarWidth, 120, 320)) return null;
    return {
      version: 5,
      inspectorWidth: value.inspectorWidth,
      library: { ...initial.library, x: library.x, y: library.y, state: library.state },
    };
  }
  if (
    !('width' in library) ||
    !validNumber(library.width, 180, 1000000) ||
    !('height' in library) ||
    !validNumber(library.height, 160, 1000000)
  )
    return null;
  if (
    (value.version === 4 || value.version === 5) &&
    (!('mode' in library) || (library.mode !== 'array' && library.mode !== 'scroll'))
  )
    return null;
  // Migrate older layouts once to the newly requested default; v5 preserves subsequent choices.
  const mode: LibraryMode = value.version === 5 && 'mode' in library && library.mode === 'array' ? 'array' : 'scroll';
  return {
    version: 5,
    inspectorWidth: value.inspectorWidth,
    library: { x: library.x, y: library.y, width: library.width, height: library.height, state: library.state, mode },
  };
}
/** Owns local presentation only. Engineering changes use the supplied existing add command. */
export function setupNetworkWorkspace(
  definitions: readonly NetworkDefinition[],
  add: (definitionId: string) => void,
  notify: (message: string) => void,
  presets?: ValveLibrary,
): void {
  const library = element('componentLibrary'),
    stage = element('canvasStage');
  const handle = element('libraryDragHandle');
  let preference = initial;
  function persist(): boolean {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(preference));
      return true;
    } catch {
      notify('当前布局已应用，但无法保存个人偏好；工程与结果保持。');
      return false;
    }
  }
  function placeLibrary(): void {
    library.hidden = preference.library.state === 'closed';
    library.dataset.libraryState = preference.library.state;
    const size = stage.getBoundingClientRect();
    const width = Math.min(
      preference.library.state === 'minimized' ? Math.min(preference.library.width, 230) : preference.library.width,
      Math.max(0, size.width - 16),
    );
    const height =
      preference.library.state === 'minimized'
        ? 32
        : Math.min(preference.library.height, Math.max(32, size.height - 16));
    library.style.width = `${width}px`;
    library.style.height = `${height}px`;
    library.style.left = `${clamp(preference.library.x, 0, size.width - width)}px`;
    library.style.top = `${clamp(preference.library.y, 0, size.height - height)}px`;
    const minimized = preference.library.state === 'minimized';
    element('minimizeLibrary').textContent = minimized ? '□' : '−';
    element('minimizeLibrary').setAttribute('aria-label', minimized ? '展开元件库' : '最小化元件库');
    element('minimizeLibrary').setAttribute('aria-expanded', String(!minimized));
  }
  function applyWidths(): void {
    const available = element('canvasArea').parentElement?.clientWidth ?? window.innerWidth;
    const right = clamp(preference.inspectorWidth, 240, Math.min(560, available - 246));
    document.documentElement.style.setProperty('--inspector-width', `${right}px`);
    const separator = element('inspectorResize');
    separator.setAttribute('aria-valuenow', String(Math.round(right)));
    separator.setAttribute('aria-valuemin', '240');
    separator.setAttribute('aria-valuemax', '560');
  }
  try {
    const stored =
      localStorage.getItem(preferenceKey) ??
      localStorage.getItem('hydraulic-network-workspace-v4') ??
      localStorage.getItem('hydraulic-network-workspace-v3') ??
      localStorage.getItem('hydraulic-network-workspace-v2');
    if (stored !== null) {
      const parsed = parsePreference(JSON.parse(stored));
      if (parsed) preference = parsed;
      else notify('个人工作区布局数据无效，已恢复默认；工程未改变。');
    } else {
      const legacy = localStorage.getItem('hydraulic-network-workspace-v1');
      if (legacy === 'drawing') preference = { ...initial, inspectorWidth: 280 };
      else if (legacy === 'inspection') preference = { ...initial, inspectorWidth: 440 };
    }
  } catch {
    notify('无法读取个人工作区布局，已使用默认布局；工程未改变。');
  }
  const cards = setupComponentLibrary(
    definitions,
    preference.library.mode,
    (definitionId) => {
      add(definitionId);
      if (stage.clientWidth < 720 || stage.clientHeight < 420) {
        if (setLibraryState('minimized')) notify('元件库已最小化，方便查看画布；点标题“□”可展开。');
      }
    },
    presets,
  );
  function setLibraryState(state: LibraryState): boolean {
    preference = { ...preference, library: { ...preference.library, state } };
    placeLibrary();
    return persist();
  }
  const modeButton = element('libraryMenuTrigger');
  const modeValue = element('libraryModeValue');
  function reflectLibraryMode(): void {
    const scroll = preference.library.mode === 'scroll';
    const label = scroll ? '滚动' : '阵列';
    modeValue.textContent = label;
    modeButton.setAttribute('aria-label', `元件库，当前${label}，切换为${scroll ? '阵列' : '滚动'}`);
  }
  reflectLibraryMode();
  modeButton.addEventListener('click', () => {
    const mode = preference.library.mode === 'scroll' ? 'array' : 'scroll';
    preference = { ...preference, library: { ...preference.library, mode } };
    cards.setMode(mode);
    reflectLibraryMode();
    if (setLibraryState('open')) notify(`元件库已切换为${modeValue.textContent}。`);
  });
  element('minimizeLibrary').addEventListener('click', () =>
    setLibraryState(preference.library.state === 'minimized' ? 'open' : 'minimized'),
  );
  element('closeLibrary').addEventListener('click', () => {
    const saved = setLibraryState('closed');
    document.querySelector<HTMLButtonElement>('[popovertarget="viewCommands"]')?.focus();
    if (saved) notify('元件库已关闭；从“视图 → 元件库”可恢复。');
  });
  function moveLibrary(x: number, y: number): void {
    const size = stage.getBoundingClientRect();
    preference = {
      ...preference,
      library: {
        ...preference.library,
        x: clamp(x, 0, size.width - library.offsetWidth),
        y: clamp(y, 0, size.height - library.offsetHeight),
      },
    };
    placeLibrary();
  }
  let dragging: {
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly left: number;
    readonly top: number;
  } | null = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return;
    event.preventDefault();
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    dragging = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: library.offsetLeft,
      top: library.offsetTop,
    };
  });
  handle.addEventListener('pointermove', (event) => {
    if (dragging?.pointerId === event.pointerId)
      moveLibrary(dragging.left + event.clientX - dragging.x, dragging.top + event.clientY - dragging.y);
  });
  const endMove = (event: PointerEvent) => {
    if (dragging?.pointerId !== event.pointerId) return;
    dragging = null;
    persist();
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
  handle.addEventListener('pointerup', endMove);
  handle.addEventListener('pointercancel', endMove);
  handle.addEventListener('keydown', (event) => {
    if (event.target !== handle) return;
    const step = event.shiftKey ? 40 : 10;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    moveLibrary(library.offsetLeft + dx, library.offsetTop + dy);
    persist();
  });
  // Eight edges/corners resize local presentation; geometry is bounded by the canvas.
  for (const direction of ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'] as const) {
    const grip = library.querySelector<HTMLElement>(`[data-library-resize="${direction}"]`);
    if (!grip) throw new Error('Library resize handle missing');
    type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    let start: {
      readonly pointerId: number;
      readonly clientX: number;
      readonly clientY: number;
      readonly box: Box;
    } | null = null;
    const currentBox = (): Box => ({
      x: library.offsetLeft,
      y: library.offsetTop,
      width: library.offsetWidth,
      height: library.offsetHeight,
    });
    function resize(box: Box, dx: number, dy: number): void {
      const width = stage.clientWidth,
        height = stage.clientHeight;
      const minimumWidth = Math.min(180, width),
        minimumHeight = Math.min(160, height);
      let left = box.x,
        top = box.y,
        right = box.x + box.width,
        bottom = box.y + box.height;
      if (direction.includes('w')) left = clamp(left + dx, 0, right - minimumWidth);
      if (direction.includes('e')) right = clamp(right + dx, left + minimumWidth, width);
      if (direction.includes('n')) top = clamp(top + dy, 0, bottom - minimumHeight);
      if (direction.includes('s')) bottom = clamp(bottom + dy, top + minimumHeight, height);
      preference = {
        ...preference,
        library: { ...preference.library, x: left, y: top, width: right - left, height: bottom - top },
      };
      placeLibrary();
    }
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || preference.library.state !== 'open') return;
      event.preventDefault();
      event.stopPropagation();
      grip.setPointerCapture(event.pointerId);
      if (direction === 'se') grip.focus();
      start = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, box: currentBox() };
    });
    grip.addEventListener('pointermove', (event) => {
      if (start?.pointerId === event.pointerId)
        resize(start.box, event.clientX - start.clientX, event.clientY - start.clientY);
    });
    const finish = (event: PointerEvent) => {
      if (start?.pointerId !== event.pointerId) return;
      start = null;
      persist();
      if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
    };
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
    grip.addEventListener('keydown', (event) => {
      if (direction !== 'se') return;
      const step = event.shiftKey ? 40 : 10;
      const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
      const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
      if (!dx && !dy) return;
      event.preventDefault();
      resize(currentBox(), dx, dy);
      persist();
    });
    window.addEventListener('blur', () => {
      if (start) {
        start = null;
        persist();
      }
    });
  }
  {
    const side = 'inspector';
    const separator = element(side + 'Resize');
    let start: { readonly pointerId: number; readonly x: number; readonly width: number } | null = null;
    const change = (width: number) => {
      preference = { ...preference, inspectorWidth: clamp(width, 240, 560) };
      applyWidths();
    };
    separator.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      separator.focus();
      separator.setPointerCapture(event.pointerId);
      // The preference owns the outer drawer width, not its inset scrollable card panel.
      start = {
        pointerId: event.pointerId,
        x: event.clientX,
        width: element('statusDrawerShell').getBoundingClientRect().width,
      };
      document.documentElement.classList.add('workspace-dragging');
    });
    separator.addEventListener('pointermove', (event) => {
      if (start?.pointerId === event.pointerId) change(start.width - (event.clientX - start.x));
    });
    const finish = (event: PointerEvent) => {
      if (start?.pointerId !== event.pointerId) return;
      start = null;
      document.documentElement.classList.remove('workspace-dragging');
      persist();
      if (separator.hasPointerCapture(event.pointerId)) separator.releasePointerCapture(event.pointerId);
    };
    separator.addEventListener('pointerup', finish);
    separator.addEventListener('pointercancel', finish);
    separator.addEventListener('dblclick', () => {
      change(initial.inspectorWidth);
      persist();
    });
    separator.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const delta = (event.key === 'ArrowRight' ? -1 : 1) * (event.shiftKey ? 40 : 10);
      change(element('statusDrawerShell').getBoundingClientRect().width + delta);
      persist();
    });
    window.addEventListener('blur', () => {
      start = null;
      document.documentElement.classList.remove('workspace-dragging');
    });
  }
  element('resetWorkspace').addEventListener('click', () => {
    preference = { ...preference, inspectorWidth: initial.inspectorWidth };
    applyWidths();
    if (persist()) notify('区域尺寸已恢复默认；工程与运行保持。');
  });
  window.addEventListener('resize', applyWidths);
  new ResizeObserver(placeLibrary).observe(stage);
  window.addEventListener('blur', () => {
    dragging = null;
  });
  applyWidths();
  placeLibrary();
}
