import {
  captureNetworkSelection,
  planNetworkDeleteSelection,
  networkRotateSelection,
  networkFlipSelection,
  planNetworkPaste,
  type NetworkDraftSession,
} from '@hyd/application';
import type { DisplayDiagnostic } from '@hyd/domain';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import { readSelectionClipboard, writeSelectionClipboard } from './network-service-client.mjs';
import { boardElement, element } from './network-dom.mjs';
interface EditingHooks {
  editor(): NetworkDraftSession;
  canvas: NetworkCanvas;
  fileBusy(): boolean;
  mutate(candidate: unknown, physical?: boolean): boolean;
  render(): void;
  uid(prefix: string): string;
  toast(message: string): void;
  diagnostics(items: readonly DisplayDiagnostic[]): void;
}
/** Async clipboard intent is pinned to the original draft/revision/selection; history remains in the draft. */
export function createNetworkEditing(hooks: EditingHooks) {
  let busy = false,
    generation = 0,
    pasteOffset = 0,
    clipboardIdentity = '';
  const available = () => !busy && !hooks.fileBusy() && hooks.canvas.editable;
  const selectionStamp = () => JSON.stringify(hooks.canvas.selections);
  function render(): void {
    const selection = hooks.canvas.selections;
    for (const id of ['copySelected', 'cutSelected'])
      element(id).toggleAttribute('disabled', !available() || !selection.some((s) => s.kind !== 'connection'));
    element('pasteSelected').toggleAttribute('disabled', !available());
    element('rotateSelected').toggleAttribute(
      'disabled',
      !available() || !selection.some((s) => s.kind === 'component'),
    );
  }
  async function copy(cut: boolean): Promise<void> {
    if (!available()) return;
    const owner = hooks.editor(),
      revision = owner.revision,
      stamp = selectionStamp(),
      selection = [...hooks.canvas.selections];
    const captured = captureNetworkSelection(owner.document, selection);
    if (!captured.ok) {
      hooks.diagnostics(captured.diagnostics);
      return;
    }
    const intent = ++generation;
    busy = true;
    render();
    try {
      const written = await writeSelectionClipboard(captured.value);
      if (!written.ok) {
        hooks.diagnostics(written.diagnostics);
        return;
      }
      if (intent !== generation) return;
      const notice = captured.value.omittedConnections
        ? `；${captured.value.omittedConnections}条外部连接未带入剪贴板`
        : '';
      if (cut) {
        if (
          hooks.editor() !== owner ||
          owner.revision !== revision ||
          selectionStamp() !== stamp ||
          hooks.fileBusy() ||
          !hooks.canvas.editable
        ) {
          hooks.toast('已复制，但工程或选择已改变，未剪切任何对象。');
          return;
        }
        const deletion = planNetworkDeleteSelection(owner.document, selection);
        if (!deletion.ok) {
          hooks.diagnostics(deletion.diagnostics);
          hooks.toast('已复制；压力表仍被控制条件引用，未剪切任何对象。');
          return;
        }
        if (
          !hooks.mutate(
            deletion.value,
            selection.some((item) => item.kind !== 'text' && item.kind !== 'probe'),
          )
        )
          return;
        hooks.canvas.select([]);
        hooks.render();
      }
      const gaugesOnly = selection.every((item) => item.kind === 'probe');
      hooks.toast((cut ? '已剪切' : '已复制') + (gaugesOnly ? '所选压力表' : '所选对象及内部连线') + notice + '。');
    } finally {
      busy = false;
      render();
    }
  }
  async function canPaste(): Promise<boolean> {
    if (!available()) return false;
    const owner = hooks.editor(),
      revision = owner.revision;
    const read = await readSelectionClipboard();
    return read.ok && available() && hooks.editor() === owner && owner.revision === revision;
  }
  async function paste(): Promise<void> {
    if (!available()) return;
    const owner = hooks.editor(),
      revision = owner.revision,
      intent = ++generation;
    busy = true;
    render();
    try {
      const read = await readSelectionClipboard();
      if (!read.ok) {
        hooks.diagnostics(read.diagnostics);
        return;
      }
      if (intent !== generation) return;
      if (hooks.editor() !== owner || owner.revision !== revision || hooks.fileBusy() || !hooks.canvas.editable) {
        hooks.toast('工程或编辑状态已改变，未采用迟到的粘贴。');
        return;
      }
      const identity = JSON.stringify(read.value);
      const offset = identity === clipboardIdentity ? pasteOffset : 0;
      const source = read.value.document;
      const plan = planNetworkPaste(owner.document, read.value, hooks.canvas.pastePoint(offset), {
        components: source.design.components.map(() => hooks.uid('component')),
        nodes: source.design.nodes.map(() => hooks.uid('node')),
        connections: source.design.connections.map(() => hooks.uid('edge')),
        texts: (source.layout.texts ?? []).map(() => hooks.uid('text')),
        probes: (source.controlProbes ?? []).map(() => hooks.uid('gauge')),
      });
      if (!plan.ok) {
        hooks.diagnostics(plan.diagnostics);
        return;
      }
      if (
        !hooks.mutate(
          plan.value.document,
          plan.value.selection.some((item) => item.kind !== 'text' && item.kind !== 'probe'),
        )
      )
        return;
      clipboardIdentity = identity;
      pasteOffset = offset + 24;
      hooks.canvas.select([...plan.value.selection]);
      hooks.render();
      boardElement().focus({ preventScroll: true });
      hooks.toast(
        plan.value.selection.every((item) => item.kind === 'probe')
          ? '已粘贴压力表，请重新连接测点。'
          : '已粘贴为新对象；保留参数、初始条件及内部连线，使用目标工程油液和压力参考。',
      );
    } finally {
      busy = false;
      render();
    }
  }
  function rotate(direction: 'clockwise' | 'counterclockwise' = 'clockwise'): void {
    if (!available()) return;
    const rotated = networkRotateSelection(hooks.editor().document, hooks.canvas.selections, direction);
    if (!rotated.ok) {
      hooks.diagnostics(rotated.diagnostics);
      return;
    }
    if (hooks.mutate(rotated.value, false))
      hooks.toast(`已${direction === 'clockwise' ? '顺' : '逆'}时针旋转90°；油口与连线跟随，物理参数和运行保持。`);
  }
  function flip(): void {
    if (!available()) return;
    const flipped = networkFlipSelection(hooks.editor().document, hooks.canvas.selections);
    if (!flipped.ok) {
      hooks.diagnostics(flipped.diagnostics);
      return;
    }
    if (hooks.mutate(flipped.value, false)) hooks.toast('已左右翻转；油口身份、物理参数和运行保持。');
  }
  function setup(): void {
    element('copySelected').addEventListener('click', () => void copy(false));
    element('cutSelected').addEventListener('click', () => void copy(true));
    element('pasteSelected').addEventListener('click', () => void paste());
    element('rotateSelected').addEventListener('click', () => rotate());
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      if (
        event.isComposing ||
        !(target instanceof Element) ||
        target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]') ||
        document.querySelector('dialog[open]') ||
        document.body.inert
      )
        return;
      if (event.key === 'Escape') {
        generation++;
        return;
      }
      if (event.defaultPrevented) return;
      const board = boardElement();
      if (target !== board && !board.contains(target)) return;
      if (event.repeat || event.altKey) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && ['c', 'x', 'v'].includes(key)) {
        event.preventDefault();
        if (key === 'v') void paste();
        else void copy(key === 'x');
      } else if (event.key === ' ' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        rotate();
      }
    });
  }
  return { setup, render, copy, paste, canPaste, rotate, flip };
}
