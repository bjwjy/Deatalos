import {
  drawingFields,
  parseDrawingTemplate,
  type DrawingTemplate,
  type DrawingTemplateField,
  type DrawingTableCell,
} from '@hyd/application';
import { element } from './network-dom.mjs';
import { titleBlock } from './network-drawing-sheet.mjs';

import { bindFrameTable } from './network-frame-table-editor.mjs';

declare global {
  interface Window {
    frameFiles: {
      open(): Promise<{ template: DrawingTemplate } | { error: string } | null>;
      save(template: DrawingTemplate): Promise<{ name: string } | { error: string } | null>;
    };
  }
}

interface DrawingEdits {
  fields: Record<string, string>;
  cells: Record<string, string>;
}
interface DesignerHost {
  current(): DrawingTemplate | undefined;
  content(draft: DrawingTemplate): { fields: Record<string, string>; cells: Record<string, string> };
  sheet(draft: DrawingTemplate, edits: DrawingEdits): { svg: string } | { error: string };
  commit(draft: DrawingTemplate, save: boolean, edits: DrawingEdits): string | undefined;
}

export function bindFrameDesigner(host: DesignerHost) {
  const dialog = element('frame-designer') as HTMLDialogElement;
  const control = (id: string) => element('frame-' + id);
  const select = (id: string) => control(id) as HTMLSelectElement;
  const input = (id: string) => control(id) as HTMLInputElement;
  const button = (id: string) => control(id) as HTMLButtonElement;
  const fields = select('field'),
    columns = select('columns'),
    label = input('label'),
    visible = input('visible'),
    name = input('name');
  const status = control('status'),
    note = control('preview-note');
  let draft: DrawingTemplate,
    selected = '',
    whole = false,
    labelCheckpoint = false;
  let edits: DrawingEdits = { fields: {}, cells: {} };
  const history: { draft: DrawingTemplate; selected: string; edits: DrawingEdits; name: string }[] = [];
  const legacyIds = new Map<string, string>(),
    sources = new Map<string, string>();
  let cachedDraft: DrawingTemplate | undefined,
    projection: DrawingTableCell[] = [];
  function layout() {
    if (draft.table) return draft.table;
    if (cachedDraft === draft) return projection;
    projection = [];
    cachedDraft = draft;
    titleBlock({}, [], draft, undefined, {}, (key, value, x, y, w, h) => {
      let id = legacyIds.get(key);
      if (!id) {
        id = 'c' + crypto.randomUUID();
        legacyIds.set(key, id);
        sources.set(id, key);
      }
      const bound = draft.fields.some((f) => f.key === key);
      projection.push({
        id,
        left: Math.round(x * 100),
        right: Math.round((x + w) * 100),
        top: Math.round(y * 100),
        bottom: Math.round((y + h) * 100),
        text: bound ? '' : value,
        ...(bound ? { field: key } : {}),
      });
    });
    return projection;
  }
  function content(template: DrawingTemplate) {
    const base = host.content(template);
    return { fields: { ...base.fields, ...edits.fields }, cells: { ...base.cells, ...edits.cells } };
  }
  const future: typeof history = [];
  const tableEditor = bindFrameTable({
    draft: () => draft,
    content,
    layout,
    source: (id) => (draft.table ? undefined : sources.get(id)),
    selected(key) {
      if (!draft.table && key && draft.fields.some((f) => f.key === key)) {
        selected = key;
        render(false);
      }
    },
    writeValue(key, value) {
      checkpoint();
      edits = { ...edits, fields: { ...edits.fields, [key]: value } };
      render();
    },
    writeLegacy(key, value) {
      if (key.startsWith('templateHeading.')) {
        const label = value.trim();
        if (!label) {
          status.textContent = '字段名称不能为空。';
          return;
        }
        selected = key.slice('templateHeading.'.length);
        checkpoint();
        const cells = { ...edits.cells };
        delete cells[key];
        edits = { ...edits, cells };
        draft = { ...draft, fields: draft.fields.map((f) => (f.key === selected ? { ...f, label } : f)) };
      } else {
        checkpoint();
        edits = { ...edits, cells: { ...edits.cells, [key]: value } };
      }
      render();
    },
    message: (message) => {
      status.textContent = message;
    },
    setFontSize(keys, points) {
      if (keys.every((key) => draft.fontSizes?.[key] === points)) return;
      checkpoint();
      const sizes = { ...draft.fontSizes };
      for (const key of keys) {
        if (points === undefined) delete sizes[key];
        else sizes[key] = points;
      }
      draft = { ...draft, fontSizes: sizes };
      render();
    },
    update(table, record = true) {
      if (record) checkpoint();
      const fixed = { ...edits.cells };
      if (!draft.table) {
        const old = content(draft).cells;
        for (const c of table) {
          const source = sources.get(c.id);
          if (!c.field && source && old[source] !== undefined) fixed['tableText.' + c.id] = old[source]!;
        }
      } else {
        for (const c of table) {
          const before = draft.table.find((b) => b.id === c.id);
          if (before && (before.text !== c.text || before.field !== c.field)) delete fixed['tableText.' + c.id];
        }
      }
      edits = { ...edits, cells: fixed };
      const fontSizes: Record<string, number> = {};
      for (const cell of table) {
        const key = draft.table ? cell.id : sources.get(cell.id);
        const size = key && draft.fontSizes?.[key];
        if (typeof size === 'number') fontSizes[cell.id] = size;
      }
      draft = { ...draft, table, fontSizes };
      whole = false;
      render();
    },
    showDetail() {
      whole = false;
      render();
    },
  });
  const metrics = document.createElement('canvas').getContext('2d');
  if (metrics) metrics.font = '100px SimSun,宋体,serif';
  const measure = metrics ? (value: string) => metrics.measureText(value).width / 100 : undefined;

  function preview() {
    control('block').hidden = whole;
    control('sheet').hidden = !whole;
    button('detail').setAttribute('aria-pressed', String(!whole));
    button('page').setAttribute('aria-pressed', String(whole));
    if (whole) {
      const result = host.sheet(draft, edits);
      control('sheet').innerHTML = 'svg' in result ? result.svg : '';
      note.textContent = 'error' in result ? result.error : '整张图纸按当前纸张、装订边和本图内容预览。';
      return;
    }
    tableEditor.paint(measure);
  }

  function render(redraw = true) {
    control('legacy-controls').hidden = !!draft.table;
    element('table-inspector').hidden = !draft.table;
    element('table-convert').hidden = !!draft.table;
    button('undo').disabled = !history.length;
    button('redo').disabled = !future.length;
    if (draft.table) {
      tableEditor.inspect();
      preview();
      return;
    }
    const item = draft.fields.find((f) => f.key === selected);
    if (!item) return;
    fields.replaceChildren(
      ...draft.fields.map((f) => new Option((f.label || '未命名字段') + (f.visible ? '' : '（已隐藏）'), f.key)),
    );
    fields.value = selected;
    columns.value = String(draft.columns ?? 4);
    if (label.value !== item.label) label.value = item.label;
    visible.checked = item.visible;
    const index = draft.fields.indexOf(item);
    button('prev').disabled = index === 0;
    button('next').disabled = index === draft.fields.length - 1;
    button('undo').disabled = !history.length;
    button('add').disabled = draft.fields.length >= 40;
    if (redraw) {
      tableEditor.syncField(selected);
      tableEditor.inspect();
      preview();
    }
  }
  const snapshot = () => ({ draft, selected, edits, name: name.value });
  function checkpoint() {
    future.length = 0;
    history.push(snapshot());
    if (history.length > 80) history.shift();
    status.textContent = '';
  }
  function changeField(patch: Partial<DrawingTemplateField>) {
    draft = { ...draft, fields: draft.fields.map((f) => (f.key === selected ? { ...f, ...patch } : f)) };
    render();
  }
  function pick(key: string) {
    selected = key;
    tableEditor.syncField(key, true);
    status.textContent = '';
    render();
  }
  fields.addEventListener('change', () => pick(fields.value));
  label.addEventListener('focus', () => {
    labelCheckpoint = false;
  });
  label.addEventListener('input', () => {
    if (!labelCheckpoint) {
      checkpoint();
      labelCheckpoint = true;
    }
    changeField({ label: label.value });
  });
  visible.addEventListener('change', () => {
    const count = draft.fields.filter((f) => f.visible).length;
    if ((!visible.checked && count === 1) || (visible.checked && count >= 24)) {
      visible.checked = !visible.checked;
      status.textContent = '标题栏需显示 1 到 24 个字段。';
      return;
    }
    checkpoint();
    changeField({ visible: visible.checked });
  });
  columns.addEventListener('change', () => {
    checkpoint();
    draft = { ...draft, columns: columns.value === '2' ? 2 : columns.value === '3' ? 3 : 4 };
    render();
  });
  for (const [id, direction] of [
    ['prev', -1],
    ['next', 1],
  ] as const) {
    button(id).addEventListener('click', () => {
      const order = [...draft.fields],
        index = order.findIndex((f) => f.key === selected),
        item = order[index];
      if (!item || !order[index + direction]) return;
      checkpoint();
      order.splice(index, 1);
      order.splice(index + direction, 0, item);
      draft = { ...draft, fields: order };
      render();
    });
  }
  button('add').addEventListener('click', () => {
    if (draft.fields.length >= 40) return;
    checkpoint();
    let i = 1;
    while (draft.fields.some((f) => f.key === 'custom' + i)) i++;
    selected = 'custom' + i;
    const show = draft.fields.filter((f) => f.visible).length < 24;
    draft = { ...draft, fields: [...draft.fields, { key: selected, label: '自定义字段', visible: show }] };
    render();
    label.focus();
    label.select();
    if (!show) status.textContent = '已添加为隐藏字段。先隐藏一个现有字段，即可显示新字段。';
  });
  button('undo').addEventListener('click', () => {
    const entry = history.pop();
    if (!entry) return;
    future.push(snapshot());
    tableEditor.cancel();
    draft = entry.draft;
    selected = entry.selected;
    edits = entry.edits;
    name.value = entry.name;
    status.textContent = '';
    render();
  });
  button('redo').addEventListener('click', () => {
    const entry = future.pop();
    if (!entry) return;
    history.push(snapshot());
    tableEditor.cancel();
    draft = entry.draft;
    selected = entry.selected;
    edits = entry.edits;
    name.value = entry.name;
    render();
  });
  for (const id of ['detail', 'page'])
    button(id).addEventListener('click', () => {
      tableEditor.cancel();
      whole = id === 'page';
      preview();
    });
  let fileSession = 0;
  dialog.addEventListener('close', () => {
    fileSession++;
  });
  for (const action of ['import', 'export'] as const) {
    button(action).addEventListener('click', async () => {
      const session = fileSession;
      button('import').disabled = button('export').disabled = true;
      try {
        const reply =
          action === 'import'
            ? await window.frameFiles.open()
            : await window.frameFiles.save({ ...draft, name: name.value.trim() || '自定义图框' });
        if (!reply || !dialog.open || session !== fileSession) return;
        if ('error' in reply) {
          status.textContent = reply.error;
        } else if ('template' in reply) {
          checkpoint();
          tableEditor.reset();
          draft = reply.template;
          edits = { fields: edits.fields, cells: {} };
          selected = (draft.fields.find((f) => f.visible) ?? draft.fields[0])?.key ?? '';
          name.value = draft.name;
          whole = false;
          render();
          status.textContent = '已导入“' + draft.name + '”，可继续编辑或应用到本图。';
        } else {
          status.textContent = '已导出：' + reply.name;
        }
      } catch {
        if (session === fileSession) status.textContent = '无法读写图框文件，请重新选择文件。';
      } finally {
        button('import').disabled = button('export').disabled = false;
      }
    });
  }
  function finish(save: boolean) {
    const candidate = { ...draft, name: name.value.trim() || (save ? '' : '本图自定义版式') };
    const parsed = parseDrawingTemplate(candidate);
    if (!parsed.ok) {
      status.textContent = parsed.diagnostics.map((d) => d.message).join('；');
      return;
    }
    const problem = host.commit(parsed.value, save, edits);
    if (problem) {
      status.textContent = problem;
      return;
    }
    dialog.close();
  }
  button('store').addEventListener('click', () => finish(true));
  button('apply').addEventListener('click', () => finish(false));
  button('cancel').addEventListener('click', () => dialog.close());
  element('formalExport').addEventListener('close', () => {
    if (dialog.open) dialog.close();
  });
  control('designer-open').addEventListener('click', () => {
    tableEditor.reset();
    edits = { fields: {}, cells: {} };
    legacyIds.clear();
    sources.clear();
    cachedDraft = undefined;
    future.length = 0;
    const current = host.current();
    draft = current ?? {
      version: 1,
      name: '自定义图框',
      fields: drawingFields.flatMap(([key, label]) => (key && label ? [{ key, label, visible: true }] : [])),
    };
    selected = (draft.fields.find((f) => f.visible) ?? draft.fields[0])?.key ?? '';
    name.value = draft.name;
    whole = false;
    history.length = 0;
    status.textContent = '';
    dialog.showModal();
    render();
  });
}
