import {
  drawingFields,
  parseDrawingTemplate,
  parseDrawingTemplateLibrary,
  type DrawingTemplate,
  type DrawingTemplateField,
} from '@hyd/application';
import { element, escapeHtml as esc } from './network-dom.mjs';

const key = 'hydraulic-drawing-templates-v1';
const defaultKey = 'deatalos-drawing-template-default-v1';
/** Owns only export-form controls and local template preferences, never engineering data. */
export function createDrawingTemplates(values: HTMLElement, changed: () => void) {
  const choice = element('formal-template-choice'),
    nameControl = element('formal-template-name'),
    preference = element('appDrawingTemplate');
  if (
    !(choice instanceof HTMLSelectElement) ||
    !(nameControl instanceof HTMLInputElement) ||
    !(preference instanceof HTMLSelectElement)
  )
    throw new Error('Template controls missing');
  const name = nameControl;
  const preferredControl = preference;
  const preferredStatus = element('appDrawingTemplateStatus');
  const rows = element('formal-template-fields'),
    status = element('formal-template-status');
  const extras = document.createElement('div');
  extras.className = 'formal-grid';
  extras.id = 'formal-custom-values';
  values.append(extras);
  let library: readonly DrawingTemplate[] = [],
    fields: readonly DrawingTemplateField[] | undefined,
    preferredName = '',
    storageBlocked = false;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed = parseDrawingTemplateLibrary(JSON.parse(raw));
      if (!parsed.ok) throw new Error('模板版本或内容无效，已保留原数据。');
      library = parsed.value;
    }
    preferredName = localStorage.getItem(defaultKey) ?? '';
  } catch (cause: unknown) {
    storageBlocked = true;
    status.textContent = '无法读取本机模板：' + String(cause).slice(0, 160);
  }
  const options = () => {
    choice.innerHTML =
      '<option value="">原180 × 56模板</option>' +
      library.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('');
    preferredControl.replaceChildren(
      new Option('原 180 × 56 模板', ''),
      ...library.map((template) => new Option(template.name, template.name)),
    );
    preferredControl.value = library.some((template) => template.name === preferredName) ? preferredName : '';
  };
  options();
  preferredControl.addEventListener('change', () => {
    preferredName = preferredControl.value;
    try {
      localStorage.setItem(defaultKey, preferredName);
      preferredStatus.textContent = '默认图框已保存到本机。';
    } catch {
      preferredStatus.textContent = '图框设置本次有效，无法保存到本机。';
    }
  });
  function render() {
    const active = fields ?? [];
    const customValues = new Map(
      [...extras.querySelectorAll<HTMLInputElement>('input')].map((e) => [e.dataset.formalField, e.value]),
    );
    rows.innerHTML = active
      .map(
        (f, i) =>
          `<div class="formal-template-row" data-template-key="${esc(f.key)}"><label><input type="checkbox" data-template-visible ${f.visible ? 'checked' : ''}>显示</label><label>字段名<input data-template-label value="${esc(f.label)}" maxlength="40"></label><button type="button" data-template-move="${i}" data-direction="-1" ${i === 0 ? 'disabled' : ''}>上移</button><button type="button" data-template-move="${i}" data-direction="1" ${i === active.length - 1 ? 'disabled' : ''}>下移</button></div>`,
      )
      .join('');
    for (const [fieldKey, label] of drawingFields) {
      const input = [...values.querySelectorAll<HTMLInputElement>('[data-formal-field]')].find(
        (e) => e.dataset.formalField === fieldKey,
      );
      const parent = input?.parentElement;
      if (!parent || !input) continue;
      const item = fields?.find((f) => f.key === fieldKey);
      parent.hidden = fields !== undefined && !item?.visible;
      if (parent.firstChild?.nodeType === Node.TEXT_NODE) parent.firstChild.textContent = item?.label ?? label ?? '';
    }
    extras.innerHTML = (fields ?? [])
      .filter((f) => !drawingFields.some(([k]) => k === f.key))
      .map(
        (f) =>
          `<label ${f.visible ? '' : 'hidden'}>${esc(f.label)}<input data-formal-field="${esc(f.key)}" maxlength="160" value="${esc(customValues.get(f.key) ?? '')}"></label>`,
      )
      .join('');
    for (const row of values.querySelectorAll<HTMLElement>('fieldset')) row.hidden = fields !== undefined;
  }
  function customize() {
    fields ??= drawingFields.flatMap(([fieldKey, label]) =>
      fieldKey && label ? [{ key: fieldKey, label, visible: true }] : [],
    );
  }
  element('formal-template-edit').addEventListener('click', () => {
    customize();
    render();
    changed();
  });
  element('formal-template-add').addEventListener('click', () => {
    customize();
    if (!fields || fields.length >= 40) {
      status.textContent = '最多保留40个字段；可显示其中24个。';
      return;
    }
    let index = 1;
    while (fields.some((f) => f.key === 'custom' + index)) index++;
    fields = [...fields, { key: 'custom' + index, label: '自定义字段', visible: true }];
    render();
    changed();
  });
  rows.addEventListener('input', (e) => {
    if (!(e.target instanceof HTMLInputElement)) return;
    const row = e.target.closest<HTMLElement>('[data-template-key]'),
      fieldKey = row?.dataset.templateKey;
    if (!row || !fieldKey || !fields) return;
    const label = row.querySelector<HTMLInputElement>('[data-template-label]'),
      visible = row.querySelector<HTMLInputElement>('[data-template-visible]');
    if (!label || !visible) return;
    fields = fields.map((f) => (f.key === fieldKey ? { ...f, label: label.value, visible: visible.checked } : f));
    // Keep the field editor focused while synchronizing the corresponding value label.
    const value = [...values.querySelectorAll<HTMLInputElement>('[data-formal-field]')].find(
      (input) => input.dataset.formalField === fieldKey,
    );
    if (value?.parentElement) {
      value.parentElement.hidden = !visible.checked;
      if (value.parentElement.firstChild?.nodeType === Node.TEXT_NODE)
        value.parentElement.firstChild.textContent = label.value;
    }
    changed();
  });
  rows.addEventListener('click', (e) => {
    if (!(e.target instanceof HTMLButtonElement) || e.target.dataset.templateMove === undefined || !fields) return;
    const index = Number(e.target.dataset.templateMove),
      target = index + Number(e.target.dataset.direction),
      updated = [...fields];
    const a = updated[index],
      b = updated[target];
    if (!a || !b) return;
    updated[index] = b;
    updated[target] = a;
    fields = updated;
    render();
    changed();
  });
  function applyTemplate(selected?: DrawingTemplate): void {
    fields = selected?.fields;
    name.value = selected?.name ?? '自定义图框';
    render();
  }
  choice.addEventListener('change', () => {
    applyTemplate(choice.value === '' ? undefined : library[Number(choice.value)]);
    changed();
  });
  element('formal-template-save').addEventListener('click', () => {
    customize();
    const parsed = parseDrawingTemplate({ version: 1, name: name.value.trim(), fields });
    if (!parsed.ok) {
      status.textContent = parsed.diagnostics.map((d) => d.message).join('；');
      return;
    }
    if (storageBlocked) {
      status.textContent = '原模板库读取失败，未覆盖；本图仍可使用临时字段设置。';
      return;
    }
    if (library.some((t) => t.name === parsed.value.name)) {
      status.textContent = '该模板名称已存在，请换一个名称保存，已有模板保留。';
      return;
    }
    const next = parseDrawingTemplateLibrary({ version: 1, templates: [...library, parsed.value] });
    if (!next.ok) {
      status.textContent = next.diagnostics.map((d) => d.message).join('；');
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify({ version: 1, templates: next.value }));
      library = next.value;
      options();
      choice.value = String(library.length - 1);
      status.textContent = '模板已保存到本机；本图填写内容未写入模板。';
    } catch (cause: unknown) {
      status.textContent = '模板未保存：' + String(cause).slice(0, 160);
    }
    render();
    changed();
  });
  return {
    current: (): DrawingTemplate | undefined =>
      fields === undefined ? undefined : { version: 1, name: name.value.trim(), fields },
    reset(usePreferred: boolean) {
      const index = usePreferred ? library.findIndex((template) => template.name === preferredName) : -1;
      choice.value = index < 0 ? '' : String(index);
      extras.textContent = '';
      applyTemplate(library[index]);
    },
  };
}
