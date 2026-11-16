import { checkJson, ContractReader, immutable, type Result } from '@hyd/domain';

/** A reusable layout contains no values from the current drawing. Array order is display order. */
export interface DrawingTemplateField {
  readonly key: string;
  readonly label: string;
  readonly visible: boolean;
}
export interface DrawingTemplate {
  readonly version: 1;
  readonly name: string;
  readonly fields: readonly DrawingTemplateField[];
}
export function parseDrawingTemplate(input: unknown): Result<DrawingTemplate> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', ['version', 'name', 'fields']);
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
  if (count < 1 || count > 24)
    r.fail('DRAWING_TEMPLATE_INVALID', '/fields', '自定义标题栏须显示1～24个字段，其他字段可隐藏。');
  return r.finish(immutable({ version: 1, name, fields }));
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
