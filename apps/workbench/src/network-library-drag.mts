import { networkDrawingScale } from '@hyd/domain';
import { element } from './network-dom.mjs';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import type { NetworkDraftSession } from '@hyd/application';
import { networkComponentPresentationBounds, type NetworkComponent } from '@hyd/domain';
import { networkSymbol } from './network-symbols.mjs';
import { pressureGaugePictogram } from './network-controller-symbols.mjs';
interface LibraryDragHooks {
  editor(): NetworkDraftSession;
  canvas: NetworkCanvas;
  fileBusy(): boolean;
  add(definitionId: string, position: { readonly x: number; readonly y: number }): boolean;
  toast(message: string): void;
  preview(reference: string): NetworkComponent | null;
}
/** In-process pointer gesture only. No external drop payload or second engineering state. */
export function setupNetworkLibraryDrag(hooks: LibraryDragHooks): void {
  const tools = element('componentTools');
  let drag: {
    pointerId: number;
    button: HTMLButtonElement;
    definitionId: string;
    x: number;
    y: number;
    active: boolean;
    owner: NetworkDraftSession;
    revision: number;
    ghost: HTMLElement | null;
  } | null = null;
  let suppressed: { button: HTMLButtonElement; until: number } | null = null;
  function clear(): void {
    const old = drag;
    drag = null;
    if (!old) return;
    old.ghost?.remove();
    document.documentElement.classList.remove('library-dragging');
    if (old.active) suppressed = { button: old.button, until: performance.now() + 700 };
    if (old.button.hasPointerCapture(old.pointerId)) old.button.releasePointerCapture(old.pointerId);
  }
  tools.addEventListener('pointerdown', (event) => {
    suppressed = null;
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('button[data-library-definition]')
        : null;
    if (event.button !== 0 || !button || drag || hooks.fileBusy() || !hooks.canvas.editable) return;
    const definitionId = button.dataset.libraryDefinition;
    if (!definitionId) return;
    const owner = hooks.editor();
    drag = {
      pointerId: event.pointerId,
      button,
      definitionId,
      x: event.clientX,
      y: event.clientY,
      active: false,
      owner,
      revision: owner.revision,
      ghost: null,
    };
    button.setPointerCapture(event.pointerId);
  });
  tools.addEventListener('pointermove', (event) => {
    const current = drag;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.active && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
    event.preventDefault();
    current.active = true;
    if (!current.ghost) {
      const ghost = document.createElement('div');
      ghost.className = 'library-drag-preview';
      ghost.setAttribute('aria-hidden', 'true');
      const component = hooks.preview(current.definitionId);
      const gauge = current.definitionId === 'instrument:pressure-gauge';
      const bounds = gauge
        ? { left: -45, right: 45, top: -40, bottom: 65 }
        : component && networkComponentPresentationBounds(component, { componentId: component.id, x: 0, y: 0 });
      if ((!component && !gauge) || !bounds) {
        clear();
        hooks.toast('元件缺少注册预览，已取消拖放。');
        return;
      }
      const board = element('board');
      if (!(board instanceof SVGSVGElement)) throw new Error('Board must be SVG');
      const matrix = board.getScreenCTM();
      if (!matrix) {
        clear();
        return;
      }
      const scale = Math.hypot(matrix.a, matrix.b);
      ghost.innerHTML = component
        ? `<svg viewBox="${bounds.left} ${bounds.top} ${bounds.right - bounds.left} ${bounds.bottom - bounds.top}" aria-hidden="true">${networkSymbol(component, [], [], { labels: false, details: false }, 0, networkDrawingScale(component))}</svg>`
        : pressureGaugePictogram();
      ghost.style.width = `${(bounds.right - bounds.left) * scale}px`;
      ghost.style.height = `${(bounds.bottom - bounds.top) * scale}px`;
      ghost.dataset.offsetX = String(bounds.left * scale);
      ghost.dataset.offsetY = String(bounds.top * scale);
      const text = document.createElement('span');
      text.textContent = '松开放置 · Esc取消';
      ghost.append(text);
      document.body.append(ghost);
      current.ghost = ghost;
      document.documentElement.classList.add('library-dragging');
    }
    current.ghost.style.left = `${event.clientX + Number(current.ghost.dataset.offsetX)}px`;
    current.ghost.style.top = `${event.clientY + Number(current.ghost.dataset.offsetY)}px`;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const point = hooks.canvas.positionAtClient(event.clientX, event.clientY);
    current.ghost.dataset.valid = String(!!target?.closest('#board') && !!point);
    if (current.definitionId === 'teaching:flow-meter') {
      const hint = current.ghost.querySelector('span');
      if (hint)
        hint.textContent = target?.closest('[data-connection],[data-connection-hit]')
          ? '松开尝试串入管线 · Esc取消'
          : '拖到独立直线段可自动接入';
    }
  });
  tools.addEventListener('pointerup', (event) => {
    const current = drag;
    if (!current || current.pointerId !== event.pointerId) return;
    const active = current.active;
    const point = hooks.canvas.positionAtClient(event.clientX, event.clientY);
    const target = document.elementFromPoint(event.clientX, event.clientY);
    clear();
    if (!active) return;
    event.preventDefault();
    if (
      current.owner !== hooks.editor() ||
      current.revision !== current.owner.revision ||
      hooks.fileBusy() ||
      !hooks.canvas.editable
    ) {
      hooks.toast('工程或编辑状态已改变，已取消本次拖放。');
      return;
    }
    if (!point || !target?.closest('#board')) {
      hooks.toast('未放到画布，未创建元件。');
      return;
    }
    if (hooks.add(current.definitionId, point)) {
      element('board').focus();
      const stage = element('canvasStage');
      if (
        (stage.clientWidth < 720 || stage.clientHeight < 420) &&
        element('minimizeLibrary').getAttribute('aria-expanded') === 'true'
      )
        element('minimizeLibrary').click();
    }
  });
  tools.addEventListener(
    'click',
    (event) => {
      if (
        suppressed &&
        performance.now() <= suppressed.until &&
        event.target instanceof Node &&
        suppressed.button.contains(event.target)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressed = null;
      }
    },
    true,
  );
  tools.addEventListener('pointercancel', clear);
  tools.addEventListener('lostpointercapture', () => {
    if (drag) clear();
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && drag) {
        event.preventDefault();
        clear();
      }
    },
    true,
  );
  window.addEventListener('blur', clear);
}
