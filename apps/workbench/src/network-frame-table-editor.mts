import type { DrawingTableCell as Cell, DrawingTemplate } from '@hyd/application';
import { element } from './network-dom.mjs';
import { titleBlock } from './network-drawing-sheet.mjs';
import {
  frame,
  splitRect,
  bounds,
  rectangular,
  sizeCell,
  verticalMergeGroup,
  divider,
  changeBand,
  type Axis,
} from './network-frame-table-geometry.mjs';

interface TableHost {
  draft(): DrawingTemplate;
  layout(): readonly Cell[];
  source(id: string): string | undefined;
  selected(key: string | undefined): void;
  writeValue(key: string, value: string): void;
  writeLegacy(key: string, value: string): void;
  content(draft: DrawingTemplate): { fields: Record<string, string>; cells: Record<string, string> };
  update(cells: readonly Cell[], record?: boolean): void;
  setFontSize(keys: readonly string[], points: number | undefined): void;
  message(message: string): void;
  showDetail(): void;
}
export function bindFrameTable(host: TableHost) {
  const el = (id: string) => element('table-' + id);
  const input = (id: string) => el(id) as HTMLInputElement;
  const btn = (id: string) => el(id) as HTMLButtonElement;
  const choice = (id: string) => el(id) as HTMLSelectElement;
  const targets = element('frame-targets'),
    lines = element('frame-lines'),
    note = element('frame-preview-note');
  const cells = host.layout;
  function displayed(c: Cell) {
    const content = host.content(host.draft());
    return c.field
      ? (content.fields[c.field] ?? '')
      : (content.cells[host.source(c.id) ?? 'tableText.' + c.id] ?? c.text);
  }
  let ids: string[] = [],
    picker: 'insert' | 'split' = 'insert',
    typing = false;
  const selected = () => cells().filter((c) => ids.includes(c.id));
  const first = () => cells().find((c) => c.id === ids[0]);
  const find = (id: string) => cells().find((c) => c.id === id);
  const key = (c: Cell) =>
    c.field ? (host.draft().fields.find((f) => f.key === c.field)?.label ?? c.field) : c.text || '空白';
  const message = (s: string) => host.message(s);
  function closePicker() {
    el('picker').hidden = true;
    btn('insert').setAttribute('aria-expanded', 'false');
  }
  function cancel() {
    window.clearTimeout(fontTimer);
    window.clearTimeout(pendingSize?.timer);
    pendingSize = undefined;
    closePicker();
    typing = false;
    el('keep-panel').hidden = true;
    gestureEnd();
    closeMenu();
  }
  function reset() {
    cancel();
    ids = [];
    targets.removeAttribute('data-table-active');
  }
  function replace(table: readonly Cell[], next: string[], record = true) {
    ids = next;
    el('keep-panel').hidden = true;
    host.update(table, record);
  }
  function select(next: string[]) {
    ids = next;
    el('keep-panel').hidden = true;
    typing = false;
    const c = first();
    const source = c && host.source(c.id);
    host.selected(c?.field ?? source?.replace(/^templateHeading\./, ''));
    inspect();
    highlight();
  }
  function highlight() {
    for (const hit of targets.querySelectorAll<HTMLButtonElement>('[data-table-cell]'))
      hit.setAttribute('aria-pressed', String(ids.includes(hit.dataset.tableCell!)));
  }
  const font = input('font-size');
  const presets = choice('font-presets');
  presets.addEventListener('change', () => {
    font.value = presets.value;
    commitFont();
  });
  const fontKey = (c: Cell) => host.source(c.id) ?? c.id;
  let fontTimer: number | undefined;
  function commitFont() {
    window.clearTimeout(fontTimer);
    const raw = font.value.trim(),
      points = raw === '' || raw === '自动' ? undefined : Number(raw);
    if (points !== undefined && (!Number.isFinite(points) || points < 4 || points > 72)) {
      message('请输入 4 到 72 pt 的字号，或选择“自动”。');
      inspect();
      return;
    }
    if (ids.length) host.setFontSize(selected().map(fontKey), points);
    inspect();
  }
  font.addEventListener('input', () => {
    window.clearTimeout(fontTimer);
    const value = Number(font.value);
    if (font.value === '自动' || (value >= 4 && value <= 72)) fontTimer = window.setTimeout(commitFont, 320);
  });
  font.addEventListener('change', commitFont);
  font.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      commitFont();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      inspect();
      font.blur();
    }
  });
  function inspect() {
    window.clearTimeout(fontTimer);
    ids = ids.filter((id) => find(id));
    const c = first();
    const single = ids.length === 1;
    el('selection').textContent = single ? '单元格属性' : ids.length ? '已选 ' + ids.length + ' 格' : '请选择单元格';
    const draft = host.draft();
    const sizes = new Set(selected().map((c) => draft.fontSizes?.[fontKey(c)]));
    font.disabled = !ids.length;
    font.placeholder = sizes.size > 1 ? '多个字号' : '自动';
    font.value =
      sizes.size === 1 && c && typeof draft.fontSizes?.[fontKey(c)] === 'number'
        ? String(draft.fontSizes[fontKey(c)])
        : '';
    presets.disabled = font.disabled;
    presets.value = sizes.size > 1 ? '' : font.value || '自动';
    el('text-label').textContent = single && c?.field ? '本图字段值' : '固定文字';
    const text = input('text');
    text.disabled = !single || !!c?.field;
    const value = !single || !c ? '' : c.field ? (host.content(draft).fields[c.field] ?? '') : c.text;
    if (text.value !== value) text.value = value;
    for (const [id, value] of [
      ['width', c && single ? String((c.right - c.left) / 100) : ''],
      ['height', c && single ? String((c.bottom - c.top) / 100) : ''],
    ] as const) {
      input(id).value = String(value);
      input(id).disabled = !single;
    }
    btn('merge').disabled = !rectangular(selected());
    btn('split').disabled = !single;
    for (const id of ['row', 'col', 'del-row', 'del-col']) btn(id).disabled = !single;
  }
  function paint(measure?: (value: string) => number) {
    targets.dataset.tableActive = '';
    const draft = host.draft(),
      content = host.content(draft);
    const drawing = titleBlock(content.fields, [], draft, measure, content.cells);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 180 56');
    if (drawing.ok) svg.innerHTML = drawing.value;
    lines.replaceChildren(svg);
    const frag = document.createDocumentFragment();
    for (const c of cells()) {
      const hit = document.createElement('button');
      hit.type = 'button';
      hit.dataset.tableCell = c.id;
      const source = host.source(c.id);
      if (source?.startsWith('templateHeading.')) hit.dataset.frameKey = source.slice('templateHeading.'.length);
      if (c.field) hit.dataset.frameValue = c.field;
      hit.title = key(c);
      hit.setAttribute('aria-label', key(c));
      hit.style.left = c.left / 180 + '%';
      hit.style.top = c.top / 56 + '%';
      hit.style.width = (c.right - c.left) / 180 + '%';
      hit.style.height = (c.bottom - c.top) / 56 + '%';
      if (!drawing.ok) {
        hit.style.border = '1px solid #89959b';
        hit.textContent = key(c);
      }
      frag.append(hit);
    }
    targets.replaceChildren(frag);
    highlight();
    note.textContent = drawing.ok
      ? '双击格内填写，长按格子后拖动可交换内容，长按边线后拖动可调尺寸。Ctrl 点选多格，右键合并或拆分。'
      : drawing.diagnostics.map((d) => d.message).join('；');
  }
  function activatePicker(mode: 'insert' | 'split') {
    const open = !el('picker').hidden && picker === mode;
    closePicker();
    if (open) return;
    picker = mode;
    host.showDetail();
    el('picker').hidden = false;
    btn('insert').setAttribute('aria-expanded', String(mode === 'insert'));
    input('rows').value = mode === 'split' ? '1' : '3';
    input('cols').value = mode === 'split' ? '2' : '4';
    btn('create').textContent = mode === 'split' ? '拆分' : '插入';
    paintPicker(Number(input('rows').value), Number(input('cols').value));
  }
  function paintPicker(r: number, k: number) {
    el('picker-caption').textContent =
      (picker === 'split' ? '拆分单元格' : '插入表格') + ' · ' + r + ' 行 × ' + k + ' 列';
    for (const b of el('grid').querySelectorAll<HTMLButtonElement>('button'))
      b.classList.toggle('in-range', Number(b.dataset.row) <= r && Number(b.dataset.col) <= k);
  }
  function create(r: number, k: number) {
    const active = first(),
      split = picker === 'split';
    if (split && !active) return;
    const next = splitRect(split && active ? active : frame, r, k, split ? active : undefined);
    if (!next[0] || (split && cells().length + next.length - 1 > 128)) {
      message('单元格至少宽 4 mm、高 3 mm，整表最多 128 格。');
      return;
    }
    closePicker();
    replace(split ? cells().flatMap((c) => (c === active ? next : [c])) : next, [next[0].id]);
  }
  for (let r = 1; r <= 6; r++)
    for (let k = 1; k <= 8; k++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.row = String(r);
      b.dataset.col = String(k);
      b.setAttribute('aria-label', r + ' 行 ' + k + ' 列');
      b.title = b.getAttribute('aria-label')!;
      const hover = () => {
        input('rows').value = String(r);
        input('cols').value = String(k);
        paintPicker(r, k);
      };
      b.addEventListener('pointerenter', hover);
      b.addEventListener('focus', hover);
      b.addEventListener('click', () => create(r, k));
      el('grid').append(b);
    }
  for (const id of ['rows', 'cols'])
    input(id).addEventListener('input', () => paintPicker(input('rows').valueAsNumber, input('cols').valueAsNumber));
  btn('insert').onclick = () => activatePicker('insert');
  btn('split').onclick = () => activatePicker('split');
  btn('create').onclick = () => create(input('rows').valueAsNumber, input('cols').valueAsNumber);
  btn('convert').onclick = () => {
    const converted = cells();
    if (converted[0]) {
      closePicker();
      replace(converted, [converted[0].id]);
    }
  };
  function merge(keep: string) {
    const group = selected(),
      kept = find(keep);
    if (!kept || !ids.includes(keep) || !rectangular(group)) return;
    const merged = { ...kept, ...bounds(group) };
    replace([...cells().filter((c) => !ids.includes(c.id)), merged], [merged.id]);
  }
  function requestMerge() {
    const content = host.content(host.draft());
    const filled = selected().filter(
      (c) => c.field || c.text || content.cells[host.source(c.id) ?? 'tableText.' + c.id],
    );
    if (filled.length < 2) {
      const keep = filled[0] ?? first();
      if (keep) merge(keep.id);
      return;
    }
    choice('keep').replaceChildren(
      ...filled.map(
        (c) => new Option(key(c) + '（' + (c.left / 100).toFixed(1) + ', ' + (c.top / 100).toFixed(1) + ' mm）', c.id),
      ),
    );
    el('inspector').hidden = false;
    el('keep-panel').hidden = false;
    choice('keep').focus();
  }
  btn('merge').onclick = requestMerge;
  btn('merge-confirm').onclick = () => merge(choice('keep').value);
  function swap(a: string, b: string) {
    const c = find(a),
      d = find(b);
    if (!c || !d || c === d) return;
    // Keep content identities with the text/field, including per-drawing overrides.
    const rect = (v: Cell) => ({ left: v.left, right: v.right, top: v.top, bottom: v.bottom });
    replace(
      cells().map((v) => (v === c ? { ...c, ...rect(d) } : v === d ? { ...d, ...rect(c) } : v)),
      [c.id],
    );
    message('已交换两个单元格的内容。');
  }
  input('text').onfocus = () => {
    typing = false;
  };
  input('text').oninput = () => {
    const c = first();
    if (!c || c.field) return;
    replace(
      cells().map((v) => (v === c ? { ...v, text: input('text').value } : v)),
      [c.id],
      !typing,
    );
    typing = true;
  };
  let pendingSize: { cellId: string; timer: number } | undefined;
  let sizeCheckpoint = false;
  function applySize(final: boolean) {
    const edit = pendingSize;
    if (!edit) return;
    window.clearTimeout(edit.timer);
    const c = first();
    if (!c || ids.length !== 1 || c.id !== edit.cellId) {
      pendingSize = undefined;
      return;
    }
    const w = input('width'),
      h = input('height');
    const width = Math.round(w.valueAsNumber * 100),
      height = Math.round(h.valueAsNumber * 100);
    if (width === c.right - c.left && height === c.bottom - c.top) {
      pendingSize = undefined;
      return;
    }
    const valid = w.value && h.value && w.validity.valid && h.validity.valid;
    const next = valid ? sizeCell(cells(), c, width, height) : undefined;
    if (!next) {
      if (valid || final)
        message(valid ? '空间不足。请缩小输入尺寸，或先合并相邻单元格。' : '请输入有效的格宽和格高。');
      if (final) {
        pendingSize = undefined;
        inspect();
      }
      return;
    }
    pendingSize = undefined;
    replace(next, [c.id], !sizeCheckpoint);
    sizeCheckpoint = true;
    message('');
  }
  for (const axis of ['width', 'height']) {
    const control = input(axis);
    control.addEventListener('focus', () => {
      sizeCheckpoint = false;
    });
    control.addEventListener('input', () => {
      const c = first();
      if (!c) return;
      window.clearTimeout(pendingSize?.timer);
      pendingSize = { cellId: c.id, timer: window.setTimeout(() => applySize(false), 250) };
    });
    control.addEventListener('blur', () => applySize(true));
    control.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applySize(true);
      }
    });
  }
  for (const [id, axis, insert] of [
    ['row', 'y', true],
    ['col', 'x', true],
    ['del-row', 'y', false],
    ['del-col', 'x', false],
  ] as const)
    btn(id).onclick = () => {
      const c = first();
      if (!c) return;
      const next = changeBand(cells(), c, axis, insert, true);
      if (!next) {
        message('这个位置没有足够空间，或已是最后一行或一列。');
        return;
      }
      replace(next, [c.id]);
    };

  const menu = el('menu'),
    dialog = element('frame-designer');
  let menuCell = '';
  function closeMenu(restore = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (restore)
      targets.querySelector<HTMLButtonElement>('[data-table-cell="' + menuCell + '"]')?.focus({ preventScroll: true });
  }
  function openMenu(cell: Cell, x: number, y: number) {
    gestureEnd();
    closePicker();
    applySize(true);
    if (!ids.includes(cell.id)) select([cell.id]);
    menuCell = cell.id;
    for (const item of menu.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      const action = item.dataset.action;
      const history = action === 'undo' || action === 'redo';
      item.hidden =
        !history &&
        (ids.length > 1
          ? action !== 'merge' && action !== 'single' && action !== 'font'
          : action === 'single' || action === 'merge');
      if (action === 'up' || action === 'down')
        item.disabled = ids.length !== 1 || !verticalMergeGroup(cells(), cell, action === 'up').length;
      if (action === 'size') item.disabled = ids.length !== 1;
    }
    for (const group of menu.querySelectorAll<HTMLElement>('.table-menu-group'))
      group.hidden = !group.querySelector('button:not([hidden])');
    menu.hidden = false;
    menu.style.left = '0px';
    menu.style.top = '0px';
    const box = menu.getBoundingClientRect(),
      d = dialog.getBoundingClientRect();
    menu.style.left = Math.max(d.left + 4, Math.min(x, d.right - box.width - 4)) - box.left + 'px';
    menu.style.top = Math.max(d.top + 4, Math.min(y, d.bottom - box.height - 4)) - box.top + 'px';
    menu.querySelector<HTMLButtonElement>('button:enabled:not([hidden])')?.focus({ preventScroll: true });
  }
  targets.addEventListener('contextmenu', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    if (gesture && event instanceof PointerEvent && event.pointerType === 'touch') return;
    targets.querySelector<HTMLInputElement>('input.table-inline-text')?.blur();
    if (document.activeElement === font) font.blur();
    const c = cellAt(point(event));
    if (c) openMenu(c, event.clientX, event.clientY);
  });
  targets.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || !(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
    const hit = e.target instanceof HTMLButtonElement ? e.target : null;
    const c = hit && find(hit.dataset.tableCell ?? '');
    if (!c || !hit) return;
    e.preventDefault();
    const b = hit.getBoundingClientRect();
    openMenu(c, b.left + b.width / 2, b.top + b.height / 2);
  });
  menu.addEventListener(
    'click',
    (e) => {
      const item = e.target instanceof HTMLElement ? e.target.closest<HTMLButtonElement>('[data-action]') : null;
      const c = find(menuCell);
      if (!item || item.disabled) return;
      const action = item.dataset.action!;

      closeMenu(true);
      if (!c) return;
      if (action === 'single') select([c.id]);
      else if (action === 'up' || action === 'down') {
        const group = verticalMergeGroup(cells(), c, action === 'up');
        if (group.length) {
          select(group.map((v) => v.id));
          requestMerge();
        }
      } else if (action === 'font') {
        font.focus();
        font.select();
      } else if (action === 'size') {
        el('inspector').hidden = false;
        input('width').focus();
        input('width').select();
      }
    },
    true,
  );
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (e.key === 'Tab') {
      closeMenu(true);
      return;
    }
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:enabled:not([hidden])')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (['Home', 'End', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      items[
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? items.length - 1
            : (i + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      ]?.focus();
    }
  });
  dialog.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target instanceof Node && !menu.contains(e.target)) closeMenu();
    },
    true,
  );
  dialog.addEventListener(
    'scroll',
    (e) => {
      if (!(e.target instanceof Node && menu.contains(e.target))) closeMenu();
    },
    true,
  );
  window.addEventListener('resize', () => closeMenu());
  dialog.addEventListener('close', cancel);

  type Edge = NonNullable<ReturnType<typeof divider>>;
  type Drag = {
    pointer: number;
    x: number;
    y: number;
    start: Cell;
    kind: 'select' | 'swap' | 'edge';
    ctrl: boolean;
    armed: boolean;
    aborted: boolean;
    timer?: number;
    edge?: Edge;
    moved: boolean;
    before: string[];
    origin: ReturnType<typeof point>;
    lastPoint: ReturnType<typeof point>;
  };
  let gesture: Drag | undefined;
  const guide = document.createElement('i');
  guide.className = 'table-edge-guide';
  guide.setAttribute('aria-hidden', 'true');
  function point(e: MouseEvent) {
    const b = targets.getBoundingClientRect();
    return {
      x: ((e.clientX - b.left) / b.width) * 18000,
      y: ((e.clientY - b.top) / b.height) * 5600,
      dx: 18000 / b.width,
      dy: 5600 / b.height,
    };
  }
  function cellAt(p: { x: number; y: number }) {
    return cells().find((c) => c.left <= p.x && c.right > p.x && c.top <= p.y && c.bottom > p.y);
  }
  function near(c: Cell, p: ReturnType<typeof point>, all: boolean) {
    const edges: { axis: Axis; at: number; distance: number }[] = [
      { axis: 'x', at: c.left, distance: (p.x - c.left) / p.dx },
      { axis: 'x', at: c.right, distance: (c.right - p.x) / p.dx },
      { axis: 'y', at: c.top, distance: (p.y - c.top) / p.dy },
      { axis: 'y', at: c.bottom, distance: (c.bottom - p.y) / p.dy },
    ];
    // Leave a selectable centre even in the narrowest zoomed-out cells.
    const radiusX = Math.min(6, (c.right - c.left) / p.dx / 4);
    const radiusY = Math.min(6, (c.bottom - c.top) / p.dy / 4);
    const hit = edges
      .filter(
        (v) => v.at > 0 && v.at < (v.axis === 'x' ? 18000 : 5600) && v.distance <= (v.axis === 'x' ? radiusX : radiusY),
      )
      .sort((a, b) => a.distance - b.distance)[0];
    return hit ? divider(cells(), c, hit.axis, hit.at, all) : null;
  }
  function gestureEnd() {
    const old = gesture;
    gesture = undefined;
    if (old) window.clearTimeout(old.timer);
    targets.removeAttribute('data-holding');
    for (const hit of targets.querySelectorAll('.swap-target')) hit.classList.remove('swap-target');
    if (old && targets.hasPointerCapture(old.pointer)) targets.releasePointerCapture(old.pointer);
    guide.remove();
    targets.style.cursor = '';
  }
  function dragRange(a: Cell, b: Cell) {
    const box = bounds([a, b]);
    return cells()
      .filter((c) => c.left >= box.left && c.right <= box.right && c.top >= box.top && c.bottom <= box.bottom)
      .map((c) => c.id);
  }
  targets.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || gesture) return;
    if (document.activeElement === font) font.blur();
    targets.querySelector<HTMLInputElement>('input.table-inline-text')?.blur();
    applySize(true);
    const p = point(e),
      start = cellAt(p);
    if (!start) return;
    e.preventDefault();
    closeMenu();
    const ctrl = e.ctrlKey || e.metaKey,
      edge = ctrl ? null : near(start, p, e.shiftKey);
    const g: Drag = {
      pointer: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      start,
      kind: ctrl || (!edge && e.shiftKey) ? 'select' : edge ? 'edge' : 'swap',
      ...(edge ? { edge } : {}),
      moved: false,
      armed: false,
      aborted: false,
      ctrl,
      before: [...ids],
      origin: p,
      lastPoint: p,
    };
    gesture = g;
    if (g.kind !== 'select')
      g.timer = window.setTimeout(() => {
        if (gesture !== g || g.aborted) return;
        g.armed = true;
        select([start.id]);
        targets.dataset.holding = '';
        targets.style.cursor = edge ? (edge.axis === 'x' ? 'col-resize' : 'row-resize') : 'grabbing';
        if (edge && drawEdge(g, g.lastPoint)) g.moved = true;
      }, 140);
    targets.setPointerCapture(e.pointerId);
  });
  targets.addEventListener('pointermove', (e) => {
    const p = point(e),
      c = cellAt(p),
      g = gesture;
    if (!g) {
      const edge = c ? near(c, p, e.shiftKey) : null;
      targets.style.cursor = edge ? (edge.axis === 'x' ? 'col-resize' : 'row-resize') : 'default';
      return;
    }
    if (g.pointer !== e.pointerId || g.aborted) return;
    g.lastPoint = p;
    if (g.edge) {
      if (g.armed && drawEdge(g, p)) g.moved = true;
      return;
    }
    if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < (g.armed ? 4 : 7)) return;
    if (!g.armed) {
      g.aborted = true;
      window.clearTimeout(g.timer);
      return;
    }
    g.moved = true;
    if (g.kind === 'swap') {
      for (const hit of targets.querySelectorAll<HTMLElement>('[data-table-cell]'))
        hit.classList.toggle('swap-target', hit.dataset.tableCell === c?.id && c !== g.start);
      return;
    }
  });
  function edgePosition(g: Drag, p: ReturnType<typeof point>, edge: Edge) {
    return edge.at + (edge.axis === 'x' ? p.x - g.origin.x : p.y - g.origin.y);
  }
  function drawEdge(g: Drag, p: ReturnType<typeof point>) {
    const edge = g.edge!;
    const x = edge.axis === 'x';
    const proposed = edgePosition(g, p, edge);
    if (!g.moved && Math.abs(proposed - edge.at) < 3 * (x ? p.dx : p.dy)) return false;
    const updated = edge.move(proposed).find((v) => v.id === g.start.id)!;
    const pos = x
      ? g.start.left === edge.at
        ? updated.left
        : updated.right
      : g.start.top === edge.at
        ? updated.top
        : updated.bottom;
    Object.assign(guide.style, {
      left: (x ? pos : edge.start) / 180 + '%',
      top: (x ? edge.start : pos) / 56 + '%',
      width: x ? '2px' : (edge.end - edge.start) / 180 + '%',
      height: x ? (edge.end - edge.start) / 56 + '%' : '2px',
    });
    targets.append(guide);
    return true;
  }
  targets.addEventListener('pointerup', (e) => {
    const g = gesture;
    if (!g || g.pointer !== e.pointerId) return;
    const p = point(e),
      end = cellAt(p);
    gestureEnd();
    if (g.aborted || (!end && g.kind !== 'edge')) return;
    if (g.moved && g.armed) {
      if (g.kind === 'swap' && end) swap(g.start.id, end.id);
      else if (g.edge) replace(g.edge.move(edgePosition(g, p, g.edge)), [g.start.id]);
      return;
    }
    if (!end || end !== g.start || Math.hypot(e.clientX - g.x, e.clientY - g.y) >= 4) return;
    if (g.ctrl) select(g.before.includes(end.id) ? g.before.filter((id) => id !== end.id) : [...g.before, end.id]);
    else if (e.shiftKey && first()) select(dragRange(first()!, end));
    else if (g.kind !== 'edge') select([end.id]);
  });
  targets.addEventListener('lostpointercapture', () => {
    if (gesture) {
      const before = gesture.before;
      gestureEnd();
      select(before);
    }
  });
  targets.addEventListener('dblclick', (e) => {
    const c = first();
    if (!c || ids.length !== 1 || targets.querySelector('input')) return;
    const p = point(e);
    if (cellAt(p) !== c || near(c, p, false) || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const edit = document.createElement('input');
    edit.type = 'text';
    edit.maxLength = 160;
    const source = host.source(c.id),
      initial = displayed(c);
    edit.value = initial;
    edit.maxLength = source?.startsWith('templateHeading.') ? 40 : 160;
    edit.setAttribute('aria-label', '编辑单元格文字');
    edit.className = 'table-inline-text';
    const pt = host.draft().fontSizes?.[fontKey(c)];
    if (typeof pt === 'number') edit.style.fontSize = (((pt * 25.4) / 72) * targets.clientWidth) / 180 + 'px';
    Object.assign(edit.style, {
      left: c.left / 180 + '%',
      top: c.top / 56 + '%',
      width: (c.right - c.left) / 180 + '%',
      height: (c.bottom - c.top) / 56 + '%',
    });
    edit.addEventListener('pointerdown', (event) => {
      if (!near(c, point(event), event.shiftKey)) event.stopPropagation();
    });
    edit.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        edit.value = initial;
        edit.blur();
      }
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        edit.blur();
      }
    });
    edit.addEventListener(
      'blur',
      () => {
        const value = edit.value;
        edit.remove();
        if (find(c.id) !== c || value === initial) return;
        if (c.field) host.writeValue(c.field, value);
        else if (source) host.writeLegacy(source, value);
        else
          replace(
            cells().map((v) => (v === c ? { ...v, text: value } : v)),
            [c.id],
          );
      },
      { once: true },
    );
    targets.append(edit);
    edit.focus();
    edit.select();
  });
  targets.addEventListener('click', (e) => {
    if (e.detail !== 0 || !(e.target instanceof HTMLElement)) return;
    const id = e.target.dataset.tableCell;
    if (!id) return;
    if (e.ctrlKey || e.metaKey) select(ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id]);
    else select([id]);
  });
  element('frame-designer').addEventListener('cancel', (e) => {
    if (!el('menu').hidden || gesture || !el('picker').hidden || !el('keep-panel').hidden) {
      e.preventDefault();
      const before = gesture?.before;
      cancel();
      if (before) select(before);
      message('');
    }
  });
  function syncField(key: string, force = false) {
    if (
      !force &&
      (ids.length > 1 ||
        ids.some((id) => {
          const c = find(id);
          return c && (c.field === key || host.source(id) === 'templateHeading.' + key);
        }))
    )
      return;
    const c = cells().find((c) => host.source(c.id) === 'templateHeading.' + key);
    ids = c ? [c.id] : [];
  }
  return { reset, cancel, inspect, paint, syncField };
}
