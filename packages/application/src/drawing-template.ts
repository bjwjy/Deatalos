import { checkJson, ContractReader, immutable, type Result } from '@hyd/domain';

/** A reusable layout contains no values from the current drawing. Array order is display order. */
export interface DrawingTemplateField {
  readonly key: string;
  readonly label: string;
  readonly visible: boolean;
}
export const frameBoxLimits = { widthMm: 180, heightMm: 56, minWidthMm: 4, minHeightMm: 3, maxCells: 128 } as const;
/** Cell edges are integer hundredths of a millimetre within the 180 × 56 mm title block. */
export interface DrawingTableCell {
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly text: string;
  readonly field?: string;
}
export interface DrawingTemplate {
  readonly table?: readonly DrawingTableCell[];
  readonly fontSizes?: Readonly<Record<string, number>>;
  readonly version: 1;
  readonly name: string;
  readonly columns?: 2 | 3 | 4;
  readonly fields: readonly DrawingTemplateField[];
}
export function parseDrawingTemplate(input: unknown): Result<DrawingTemplate> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', ['version', 'name', 'fields', 'columns', 'table', 'fontSizes']);
  r.constant(o.version, 1, '/version');
  const name = r.text(o.name, '/name', 1, 60);
  const keys = new Set<string>();
  const fields = r.array(o.fields, '/fields', 40).map((raw, i) => {
    const p = '/fields/' + i,
      f = r.object(raw, p, ['key', 'label', 'visible']);
    const key = r.text(f.key, p + '/key', 1, 48),
      label = r.text(f.label, p + '/label', 1, 40);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) || keys.has(key))
      r.fail('DRAWING_TEMPLATE_INVALID', p + '/key', '字段标识无效或重复。');
    keys.add(key);
    if (/[\u0000-\u001f\uFFFE\uFFFF]/.test(label + name))
      r.fail('DRAWING_TEMPLATE_INVALID', p, '模板文字不能含控制字符。');
    if (typeof f.visible !== 'boolean') r.fail('DRAWING_TEMPLATE_INVALID', p + '/visible', '请选择字段显隐。');
    return { key, label, visible: f.visible === true };
  });
  const count = fields.filter((f) => f.visible).length;
  if (o.table === undefined && (count < 1 || count > 24))
    r.fail('DRAWING_TEMPLATE_INVALID', '/fields', '自定义标题栏须显示1～24个字段，其他字段可隐藏。');
  const ids = new Set<string>();
  const table =
    o.table === undefined
      ? undefined
      : r.array(o.table, '/table', frameBoxLimits.maxCells).map((raw, i) => {
          const path = '/table/' + i;
          const cell = r.object(raw, path, ['id', 'left', 'top', 'right', 'bottom', 'text', 'field']);
          const coord = (key: string, max: number) => r.number(cell[key], path + '/' + key, 0, max);
          const left = coord('left', frameBoxLimits.widthMm * 100),
            right = coord('right', frameBoxLimits.widthMm * 100),
            top = coord('top', frameBoxLimits.heightMm * 100),
            bottom = coord('bottom', frameBoxLimits.heightMm * 100);
          const id = r.text(cell.id, path + '/id', 1, 48),
            text = r.text(cell.text, path + '/text', 0, 160);
          const field = cell.field === undefined ? undefined : r.text(cell.field, path + '/field', 1, 48);
          if (
            ![left, right, top, bottom].every(Number.isInteger) ||
            right - left < frameBoxLimits.minWidthMm * 100 ||
            bottom - top < frameBoxLimits.minHeightMm * 100 ||
            !/^c[a-zA-Z0-9_-]+$/.test(id) ||
            ids.has(id) ||
            (field !== undefined && (!keys.has(field) || text !== '')) ||
            /[\u0000-\u001f\uFFFE\uFFFF]/.test(text)
          )
            r.fail('DRAWING_TEMPLATE_INVALID', path, '表格单元格的尺寸、标识或内容无效。');
          ids.add(id);
          return { id, left, right, top, bottom, text, ...(field ? { field } : {}) };
        });
  if (
    table &&
    (table.reduce((area, c) => area + (c.right - c.left) * (c.bottom - c.top), 0) !==
      frameBoxLimits.widthMm * frameBoxLimits.heightMm * 10000 ||
      table.some((c, i) =>
        table.slice(0, i).some((b) => c.left < b.right && c.right > b.left && c.top < b.bottom && c.bottom > b.top),
      ))
  )
    r.fail('DRAWING_TEMPLATE_INVALID', '/table', '单元格须无重叠地铺满标题栏。');
  const fontSizes: Record<string, number> = {};
  if (o.fontSizes !== undefined) {
    const allowed = table
      ? table.map((c) => c.id)
      : [
          ...fields.flatMap((f) => [f.key, 'templateHeading.' + f.key]),
          'templateSpare.0',
          'templateSpare.1',
          'templateSpare.2',
        ];
    const sizes = r.object(o.fontSizes, '/fontSizes', allowed);
    for (const [key, value] of Object.entries(sizes)) fontSizes[key] = r.number(value, '/fontSizes/' + key, 4, 72);
  }
  const columns = o.columns;
  if (columns !== undefined && columns !== 2 && columns !== 3 && columns !== 4)
    r.fail('DRAWING_TEMPLATE_INVALID', '/columns', '标题栏请选择二、三或四列。');
  return r.finish(
    immutable({
      version: 1,
      name,
      fields,
      ...(Object.keys(fontSizes).length ? { fontSizes } : {}),
      ...(table ? { table } : {}),
      ...(columns === 2 || columns === 3 || columns === 4 ? { columns } : {}),
    }),
  );
}

export function drawingFrameFile(template: DrawingTemplate) {
  return { format: 'Deatalos.HydFrame', version: 1, template } as const;
}

/** Portable .hydframe files share the same validated layout as the local library. */
export function parseFrameFile(input: unknown): Result<DrawingTemplate> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const reader = new ContractReader();
  const file = reader.object(input, '', ['format', 'version', 'template']);
  reader.constant(file.format, 'Deatalos.HydFrame', '/format');
  reader.constant(file.version, 1, '/version');
  const header = reader.finish(true);
  return header.ok ? parseDrawingTemplate(file.template) : header;
}

export function parseDrawingTemplateLibrary(input: unknown): Result<readonly DrawingTemplate[]> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', ['version', 'templates']);
  r.constant(o.version, 1, '/version');
  const templates: DrawingTemplate[] = [];
  for (const [i, raw] of r.array(o.templates, '/templates', 30).entries()) {
    const parsed = parseDrawingTemplate(raw);
    if (!parsed.ok) {
      for (const d of parsed.diagnostics) r.fail(d.code, '/templates/' + i + d.field, d.message);
      continue;
    }
    if (templates.some((t) => t.name === parsed.value.name))
      r.fail('DRAWING_TEMPLATE_INVALID', '/templates/' + i, '模板名称不能重复。');
    templates.push(parsed.value);
  }
  return r.finish(immutable(templates));
}
