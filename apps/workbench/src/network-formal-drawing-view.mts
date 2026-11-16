import { type DrawingTemplate } from '@hyd/application';
import { element } from './network-dom.mjs';
import { titleBlock } from './network-drawing-sheet.mjs';

function button(text: string, action: () => void): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.textContent = text;
  control.addEventListener('click', action);
  return control;
}

export function drawingSwitch(id: string, label: string): void {
  const select = element(id);
  if (!(select instanceof HTMLSelectElement)) return;
  const control = button('', () => {
    select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
    select.dispatchEvent(new Event('input', { bubbles: true }));
  });
  control.className = 'drawing-choice';
  control.title = '切换' + label;
  const value = document.createElement('span');
  const icon = document.createElement('span');
  icon.textContent = '⇄';
  icon.setAttribute('aria-hidden', 'true');
  control.append(value, icon);
  const sync = () => {
    value.textContent = select.selectedOptions[0]?.textContent ?? '';
    control.setAttribute('aria-label', label + '：' + value.textContent);
  };
  select.hidden = true;
  select.after(control);
  select.addEventListener('input', sync);
  select.closest('dialog')?.addEventListener('toggle', sync);
  sync();
}

export function drawingViewport(viewport: HTMLElement): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'drawing-preview-toolbar';
  let svg: SVGSVGElement | undefined;
  let sheet: DOMRect | undefined;
  let fitted: DOMRect | undefined;
  let mode: 'sheet' | 'circuit' = 'sheet';
  let drag: { id: number; x: number; y: number } | undefined;
  const percent = document.createElement('output');
  function view(x: number, y: number, width: number, height: number): void {
    if (!svg || !sheet) return;
    svg.setAttribute('viewBox', [x, y, width, height].join(' '));
    percent.value = Math.round((sheet.width / width) * 100) + '%';
  }
  function fit(next: typeof mode): void {
    mode = next;
    const box = mode === 'circuit' ? fitted : sheet;
    if (box) view(box.x, box.y, box.width, box.height);
    full.setAttribute('aria-pressed', String(mode === 'sheet'));
    circuit.setAttribute('aria-pressed', String(mode === 'circuit'));
  }
  function zoom(factor: number, anchor?: DOMPoint): void {
    if (!svg || !sheet) return;
    const { x, y, width, height } = svg.viewBox.baseVal;
    const scale = Math.max(sheet.width / 16, Math.min(sheet.width * 2, width * factor)) / width;
    const at = anchor ?? new DOMPoint(x + width / 2, y + height / 2);
    view(at.x + (x - at.x) * scale, at.y + (y - at.y) * scale, width * scale, height * scale);
  }
  const full = button('整张图纸', () => fit('sheet'));
  const circuit = button('适合回路', () => fit('circuit'));
  const minus = button('−', () => zoom(1.25));
  const plus = button('+', () => zoom(0.8));
  minus.setAttribute('aria-label', '缩小预览');
  plus.setAttribute('aria-label', '放大预览');
  toolbar.append(full, circuit, minus, percent, plus);
  new MutationObserver(() => {
    const child = viewport.firstElementChild;
    const previous = svg?.viewBox.baseVal;
    const oldSheet = sheet;
    svg = child instanceof SVGSVGElement ? child : undefined;
    if (!svg) {
      sheet = undefined;
      mode = 'sheet';
      return;
    }
    const { x, y, width, height } = svg.viewBox.baseVal;
    sheet = new DOMRect(x, y, width, height);
    const group = svg.querySelector<SVGGraphicsElement>('[data-drawing-circuit]');
    const box = group?.getBBox();
    const matrix = group?.transform.baseVal.consolidate()?.matrix;
    fitted = undefined;
    if (box && matrix && (box.width || box.height)) {
      const center = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(matrix);
      const fitWidth = Math.max(box.width * matrix.a, (box.height * matrix.d * width) / height, width / 16) * 1.16;
      const fitHeight = (fitWidth * height) / width;
      fitted = new DOMRect(center.x - fitWidth / 2, center.y - fitHeight / 2, fitWidth, fitHeight);
    }
    circuit.disabled = !fitted;
    if (!fitted) mode = 'sheet';
    if (previous && oldSheet?.width === width && oldSheet.height === height)
      view(previous.x, previous.y, previous.width, previous.height);
    else fit(mode);
  }).observe(viewport, { childList: true });
  viewport.addEventListener(
    'wheel',
    (event) => {
      const matrix = svg?.getScreenCTM();
      if (!matrix) return;
      event.preventDefault();
      zoom(
        event.deltaY > 0 ? 1.13 : 1 / 1.13,
        new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()),
      );
    },
    { passive: false },
  );
  viewport.addEventListener('pointerdown', (event) => {
    if (!svg || event.button !== 0) return;
    viewport.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  viewport.addEventListener('pointermove', (event) => {
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix || drag?.id !== event.pointerId) return;
    const { x, y, width, height } = svg.viewBox.baseVal;
    view(x - (event.clientX - drag.x) / matrix.a, y - (event.clientY - drag.y) / matrix.d, width, height);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  viewport.addEventListener('lostpointercapture', () => {
    drag = undefined;
  });
  return toolbar;
}

export function bindTitleEditor(
  root: HTMLElement,
  template: () => DrawingTemplate | undefined,
  titleCells: Map<string, string>,
  changed: () => void,
): void {
  const dialog = element('formal-title-editor');
  if (!(dialog instanceof HTMLDialogElement)) return;
  const grid = element('formal-title-grid');
  element('formal-title-done').addEventListener('click', () => dialog.close());
  element('formalExport').addEventListener('close', () => {
    if (dialog.open) dialog.close();
  });
  root.addEventListener('click', (event) => {
    if (!(event.target instanceof HTMLElement) || !event.target.closest('#formal-edit-title')) return;
    const editors = new Map<string, HTMLInputElement>();
    const fields: Record<string, string> = {};
    const changes: Record<string, string>[] = [{}, {}, {}];
    for (const input of root.querySelectorAll<HTMLInputElement>('[data-formal-field], [data-formal-change]')) {
      const { formalField, formalChange, formalKey } = input.dataset;
      if (formalField) {
        editors.set(formalField, input);
        fields[formalField] = input.value;
      } else if (formalKey) {
        const index = Number(formalChange);
        const row = changes[index];
        if (!row) continue;
        editors.set(`更改${index + 1}.${formalKey}`, input);
        row[formalKey] = input.value;
      }
    }
    grid.replaceChildren();
    const selected = template();
    const overrides = Object.fromEntries(titleCells);
    const drawing = titleBlock(fields, changes, selected, undefined, overrides, (key, value, x, y, w, h, caption) => {
      const source = editors.get(key);
      const edit = document.createElement('input');
      const label = caption ?? (source?.parentElement?.firstChild?.textContent?.trim() || key);
      edit.setAttribute('aria-label', key.startsWith('更改') ? key.slice(0, 3) + ' ' + label : label);
      edit.title = label;
      edit.dataset.titleCell = key;
      if (source) edit.placeholder = label;
      edit.value = value;
      edit.maxLength = key === 'stage' ? 4 : 160;
      edit.style.left = (x / 180) * 100 + '%';
      edit.style.top = (y / 56) * 100 + '%';
      edit.style.width = (w / 180) * 100 + '%';
      edit.style.height = (h / 56) * 100 + '%';
      edit.addEventListener('input', () => {
        if (source) {
          source.value = edit.value;
          source.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          titleCells.set(key, edit.value);
          changed();
        }
      });
      grid.append(edit);
    });
    if (!drawing.ok) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 180 56');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = drawing.value;
    grid.prepend(svg);
    dialog.showModal();
  });
}
