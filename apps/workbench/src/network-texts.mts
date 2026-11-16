import { planNetworkText, type NetworkDraftSession } from '@hyd/application';
import type { NetworkProject, NetworkTextAnnotation } from '@hyd/domain';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import { networkTextSymbol } from './network-text-symbol.mjs';
import { element, boardElement } from './network-dom.mjs';

interface Hooks {
  editor(): NetworkDraftSession;
  canvas: NetworkCanvas;
  apply(project: NetworkProject): boolean;
  uid(): string;
  toast(message: string): void;
}
type Edit = {
  readonly owner: NetworkDraftSession;
  readonly revision: number;
  readonly value: NetworkTextAnnotation;
  readonly replace: boolean;
};
export function createNetworkTexts(hooks: Hooks) {
  let placing: NetworkDraftSession | null = null,
    edit: Edit | null = null;
  const dialog = (() => {
    const field = element('textAnnotationDialog');
    if (!(field instanceof HTMLDialogElement)) throw new Error('Text dialog missing');
    return field;
  })();
  const content = (() => {
    const field = element('annotationText');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('Text input missing');
    return field;
  })();
  const align = (() => {
    const field = element('annotationAlign');
    if (!(field instanceof HTMLSelectElement)) throw new Error('Text alignment missing');
    return field;
  })();
  function input(id: string): HTMLInputElement {
    const field = element(id);
    if (!(field instanceof HTMLInputElement)) throw new Error('Missing text field: ' + id);
    return field;
  }
  const message = (text: string) => {
    element('annotationMessage').textContent = text;
  };
  function cancelPlacement(): void {
    placing = null;
    boardElement().style.cursor = '';
  }
  function openValue(value: NetworkTextAnnotation, replace: boolean): void {
    edit = { owner: hooks.editor(), revision: hooks.editor().revision, value, replace };
    content.value = value.text;
    input('annotationWidth').value = String(value.width);
    input('annotationFontSize').value = String(value.fontSize);
    input('annotationColor').value = value.color;
    align.value = value.align;
    input('annotationBorder').checked = value.border;
    input('annotationBackground').checked = value.background !== null;
    element('deleteTextAnnotation').toggleAttribute('hidden', !replace);
    message('');
    dialog.showModal();
    content.focus();
  }
  function open(id: string): void {
    const item = hooks.editor().document.layout.texts?.find((item) => item.id === id);
    if (item && hooks.canvas.editable && !dialog.open) openValue(item, true);
  }
  function current(): Edit | null {
    if (!edit || edit.owner !== hooks.editor() || edit.revision !== hooks.editor().revision) {
      message('工程已改变，本次编辑未应用；请取消后重新打开。');
      return null;
    }
    return edit;
  }
  function render(): void {
    if (placing && placing !== hooks.editor()) cancelPlacement();
    if (edit && edit.owner !== hooks.editor() && dialog.open) dialog.close();
  }
  function setup(): void {
    element('addTextAnnotation').addEventListener('click', () => {
      if (!hooks.canvas.editable) {
        hooks.toast('请先完成或取消当前操作，再放置文本。');
        return;
      }
      placing = hooks.editor();
      boardElement().style.cursor = 'crosshair';
      hooks.canvas.select([]);
      hooks.canvas.draw();
      hooks.toast('在画布点击放置文本；Esc取消。');
      boardElement().focus({ preventScroll: true });
    });
    boardElement().addEventListener(
      'pointerdown',
      (event) => {
        if (!placing || event.button !== 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const owner = placing,
          point = hooks.canvas.positionAtClient(event.clientX, event.clientY);
        cancelPlacement();
        if (!point || owner !== hooks.editor() || !hooks.canvas.editable) return;
        openValue(
          {
            id: hooks.uid(),
            kind: 'text',
            version: 1,
            ...point,
            width: 240,
            text: '',
            fontSize: 18,
            color: '#354b62',
            align: 'left',
            border: false,
            background: null,
          },
          false,
        );
      },
      true,
    );
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && placing) {
        event.preventDefault();
        cancelPlacement();
        hooks.toast('已取消文本放置。');
      }
    });
    window.addEventListener('blur', cancelPlacement);
    element('closeTextAnnotation').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      edit = null;
    });
    element('saveTextAnnotation').addEventListener('click', () => {
      const state = current();
      if (!state) return;
      const alignment = align.value;
      if (alignment !== 'left' && alignment !== 'center' && alignment !== 'right') {
        message('请选择有效对齐方式。');
        return;
      }
      const planned = planNetworkText(hooks.editor().document, {
        kind: 'put',
        replace: state.replace,
        value: {
          ...state.value,
          text: content.value,
          width: input('annotationWidth').valueAsNumber,
          fontSize: input('annotationFontSize').valueAsNumber,
          color: input('annotationColor').value,
          align: alignment,
          border: input('annotationBorder').checked,
          background: input('annotationBackground').checked ? '#ffffff' : null,
        },
      });
      if (!planned.ok) {
        message(planned.diagnostics.map((item) => item.message).join('；'));
        return;
      }
      if (hooks.apply(planned.value)) {
        hooks.canvas.select([{ kind: 'text', id: state.value.id }]);
        dialog.close();
        hooks.canvas.draw();
        boardElement().focus({ preventScroll: true });
      }
    });
    element('deleteTextAnnotation').addEventListener('click', () => {
      const state = current();
      if (!state || !state.replace) return;
      const planned = planNetworkText(hooks.editor().document, { kind: 'delete', id: state.value.id });
      if (!planned.ok) {
        message(planned.diagnostics.map((item) => item.message).join('；'));
        return;
      }
      if (hooks.apply(planned.value)) {
        hooks.canvas.select([]);
        dialog.close();
        hooks.canvas.draw();
      }
    });
  }
  return {
    setup,
    render,
    open,
    overlay: (project: NetworkProject) =>
      (project.layout.texts ?? [])
        .map((item) => networkTextSymbol(item, hooks.canvas.isSelected('text', item.id)))
        .join(''),
  };
}
