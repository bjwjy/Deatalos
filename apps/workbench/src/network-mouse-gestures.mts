import { boardElement, element } from './network-dom.mjs';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import type { Point } from './network-cad.mjs';
import { setupGesturePreferences, type GestureCommand } from './network-gesture-preferences.mjs';
import { setupTailTrim } from './network-tail-trim.mjs';

export function setupMouseGestures(
  canvas: NetworkCanvas,
  editor: Parameters<typeof setupTailTrim>[1],
  apply: Parameters<typeof setupTailTrim>[2],
  texts: { placeAt(point: Point): void; cancelPlacement(): void },
  render: () => void,
) {
  const preferences = setupGesturePreferences(),
    board = boardElement(),
    trim = setupTailTrim(canvas, editor, apply);
  const hint = element('canvasGestureHint');
  document.body.append(hint);
  type Press = {
    id: number;
    x: number;
    y: number;
    owner: ReturnType<typeof editor>;
    revision: number;
    dragged: boolean;
    index: number | null;
  };
  let press: Press | null = null,
    nativeHandled = false;
  function clearPress() {
    const id = press?.id;
    press = null;
    hint.hidden = true;
    if (id !== undefined && board.hasPointerCapture(id)) board.releasePointerCapture(id);
  }
  function cancel() {
    clearPress();
    trim.cancel();
  }
  function execute(command: GestureCommand, origin?: Press) {
    if (command === 'none') return;
    texts.cancelPlacement();
    trim.cancel();
    if (command === 'trim') {
      trim.arm();
      board.focus({ preventScroll: true });
      return;
    }
    if (command === 'text' && origin) {
      const point = canvas.positionAtClient(origin.x, origin.y);
      if (point) texts.placeAt(point);
      return;
    }
    if (origin && ['manualRoute', 'autoRoute', 'mergeRoute', 'rotateSelected'].includes(command)) {
      const target = document.elementFromPoint(origin.x, origin.y);
      if (command === 'rotateSelected') {
        const id = target?.closest('[data-component]')?.getAttribute('data-component');
        if (id) {
          canvas.select([{ kind: 'component', id }]);
          render();
        }
        if (!canvas.selections.some((s) => s.kind === 'component')) return;
      } else {
        const line = target?.closest('[data-connection],[data-connection-hit]');
        const id = line?.getAttribute('data-connection') ?? line?.getAttribute('data-connection-hit');
        if (!id) return;
        canvas.select([{ kind: 'connection', id }]);
        render();
      }
    }
    element(command === 'text' ? 'addTextAnnotation' : command).click();
  }
  board.addEventListener(
    'pointerdown',
    (event) => {
      if (
        event.button !== 2 ||
        event.pointerType !== 'mouse' ||
        !event.isPrimary ||
        event.buttons !== 2 ||
        !canvas.editable
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      nativeHandled = true;
      if (trim.active) {
        cancel();
        return;
      }
      clearPress();
      press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        owner: editor(),
        revision: editor().revision,
        dragged: false,
        index: null,
      };
      board.setPointerCapture(event.pointerId);
    },
    true,
  );
  board.addEventListener(
    'contextmenu',
    (event) => {
      if (event.isTrusted && nativeHandled && event.button === 2) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  function move(event: PointerEvent, p: Press) {
    const dx = event.clientX - p.x,
      dy = event.clientY - p.y,
      distance = Math.hypot(dx, dy);
    if (!p.dragged && distance < preferences.triggerDistance) return;
    if (
      editor() !== p.owner ||
      editor().revision !== p.revision ||
      !canvas.editable ||
      document.querySelector('dialog[open]')
    ) {
      clearPress();
      return;
    }
    if (!p.dragged) {
      p.dragged = true;
      hint.style.left = p.x + 'px';
      hint.style.top = p.y + 'px';
      hint.hidden = false;
    }
    const choice = preferences.resolve(dx, dy, p.index);
    const index = distance < preferences.innerRadius ? -1 : choice.index;
    if (p.index !== index) {
      p.index = index;
      preferences.highlight(index);
    }
    if (distance >= preferences.outerRadius) {
      clearPress();
      if (canvas.positionAtClient(event.clientX, event.clientY)) execute(choice.command, p);
    }
  }
  board.addEventListener(
    'pointermove',
    (event) => {
      if (!press || press.id !== event.pointerId) return;
      event.stopImmediatePropagation();
      if (event.buttons !== 2) {
        clearPress();
        return;
      }
      move(event, press);
    },
    true,
  );
  board.addEventListener(
    'pointerup',
    (event) => {
      if (!press || press.id !== event.pointerId) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      const p = press;
      move(event, p);
      if (!press) return;
      clearPress();
      if (
        event.button !== 2 ||
        editor() !== p.owner ||
        editor().revision !== p.revision ||
        !canvas.editable ||
        !canvas.positionAtClient(event.clientX, event.clientY) ||
        document.querySelector('dialog[open]')
      )
        return;
      if (!p.dragged) {
        const target = document.elementFromPoint(p.x, p.y);
        if (target && board.contains(target))
          target.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: p.x, clientY: p.y }),
          );
      }
    },
    true,
  );
  for (const type of ['pointercancel', 'lostpointercapture'] as const)
    board.addEventListener(type, (e) => {
      if (press?.id === e.pointerId) clearPress();
    });
  function interruptStroke() {
    clearPress();
    trim.finishStroke();
  }
  window.addEventListener('blur', interruptStroke);
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button === 2) nativeHandled = false;
      if (event.target instanceof Node && !board.contains(event.target)) {
        if (event.button === 2) cancel();
        else interruptStroke();
      }
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && (press || trim.active)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        press ||
        !canvas.editable ||
        document.body.inert ||
        document.querySelector('dialog[open],:popover-open') ||
        target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')
      )
        return;
      const key = event.key.toLowerCase();
      if (trim.active || (key !== 't' && key !== 'x')) return;
      event.preventDefault();
      execute(key === 't' ? 'text' : 'trim');
    },
    true,
  );
  return cancel;
}
