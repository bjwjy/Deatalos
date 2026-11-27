import type { NetworkDraftSession } from '@hyd/application';
import type { Selection } from './network-cad.mjs';
import { element as $ } from './network-dom.mjs';
interface KeyboardHooks {
  readonly board: SVGSVGElement;
  editor(): NetworkDraftSession;
  active(): boolean;
  connecting(): boolean;
  selected(): Selection | null;
  fileBusy(): boolean;
  save(saveAs?: boolean): Promise<boolean>;
  undoRedo(back: boolean): void;
  render(): void;
  select(items: Selection[]): void;
  fitAll(): void;
  removeSelected(): void;
  escape(): void;
  startConnection(): void;
}
/** Global shortcuts never consume editing, modal, composing or already handled input. */
export function setupCanvasKeyboard(hooks: KeyboardHooks): void {
  const { board } = hooks;
  document.addEventListener('keydown', (event) => {
    const element = event.target instanceof Element ? event.target : null;
    if (
      event.defaultPrevented ||
      event.isComposing ||
      element?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]') ||
      document.querySelector('dialog[open]') ||
      document.body.inert
    )
      return;
    if (event.key === 'Escape') {
      hooks.escape();
      event.preventDefault();
      return;
    }
    if (event.repeat || hooks.active() || hooks.fileBusy() || event.altKey) return;
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        void hooks.save(event.shiftKey);
        return;
      }
      if (hooks.connecting()) return;
      if (key === 'z' || key === 'y') {
        event.preventDefault();
        hooks.undoRedo(key === 'z' && !event.shiftKey);
      }
      if (key === 'a' && (element === board || board.contains(element))) {
        event.preventDefault();
        hooks.select([
          ...hooks.editor().document.design.components.map((c) => ({ kind: 'component' as const, id: c.id })),
          ...hooks.editor().document.design.nodes.map((n) => ({ kind: 'node' as const, id: n.id })),
          ...(hooks.editor().document.layout.texts ?? []).map((item) => ({ kind: 'text' as const, id: item.id })),
          ...(hooks.editor().document.controlProbes ?? []).map((item) => ({ kind: 'probe' as const, id: item.id })),
        ]);
        hooks.render();
      }
      return;
    }
    if (
      event.key.toLowerCase() === 'c' &&
      !event.shiftKey &&
      !hooks.connecting() &&
      (element === board || board.contains(element))
    ) {
      event.preventDefault();
      hooks.startConnection();
      return;
    }
    if (event.key === 'Home' && (element === board || board.contains(element))) {
      event.preventDefault();
      hooks.fitAll();
      return;
    }
    if (event.key !== 'Delete' || !hooks.selected()) return;
    event.preventDefault();
    if (hooks.connecting()) {
      $('connectHint').textContent = '连线中不能删除旧选择；请先取消连接，再选择要删除的对象。';
      return;
    }
    hooks.removeSelected();
  });
}
