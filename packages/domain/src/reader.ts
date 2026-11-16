import { limits, type Diagnostic, type Json, type Result } from './model.js';

export const defaultDiagnosticSuggestion = '保留原文件，按字段提示修正副本；未知物理定义需受支持的模型。';

export function diagnostic(code: string, field: string, message: string): Diagnostic {
  return {
    code,
    field,
    message,
    severity: 'error',
    suggestion: defaultDiagnosticSuggestion,
  };
}
export function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
export const identifierPattern = '^[-\\w]{1,40}$';
export const metadataNamespacePattern = '^metadata\\.[a-z][a-z0-9-]*(\\.[a-z0-9-]+)+$';

// Check JSON resource budgets before recursive readers run (also for object APIs).
export function checkJson(input: unknown): Result<true> {
  const pending: { value: unknown; depth: number; leave?: boolean }[] = [{ value: input, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    if (entry.leave) {
      if (entry.value && typeof entry.value === 'object') seen.delete(entry.value);
      continue;
    }
    if (++nodes > limits.nodes || entry.depth > limits.depth) {
      return { ok: false, diagnostics: [diagnostic('RESOURCE_LIMIT', '/', 'JSON 层数或节点数超过预算。')] };
    }
    const value = entry.value;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    if (typeof value !== 'object' || seen.has(value)) {
      return { ok: false, diagnostics: [diagnostic('FILE_INVALID', '/', '只接受有限数值和无循环的 JSON 数据。')] };
    }
    seen.add(value);
    pending.push({ value, depth: entry.depth, leave: true });
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      return { ok: false, diagnostics: [diagnostic('FILE_INVALID', '/', '不支持带自定义原型的对象。')] };
    }
    const names = Object.getOwnPropertyNames(value);
    // Avoid allocating unbounded work queues from a very wide object.
    if (nodes + pending.length + names.length > limits.nodes) {
      return { ok: false, diagnostics: [diagnostic('RESOURCE_LIMIT', '/', 'JSON 节点数超过预算。')] };
    }
    for (const key of names) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (reserved.has(key) || !descriptor || !('value' in descriptor)) {
        return { ok: false, diagnostics: [diagnostic('FILE_INVALID', '/', '不支持保留属性名或访问器。')] };
      }
      pending.push({ value: descriptor.value, depth: entry.depth + 1 });
    }
  }
  return { ok: true, value: true };
}

// Internal fallback values only let validation collect diagnostics. finish()
// never returns a partially repaired document when any error was recorded.
export class ContractReader {
  readonly diagnostics: Diagnostic[] = [];
  fail(code: string, field: string, message: string): void {
    if (this.diagnostics.length < 100) this.diagnostics.push(diagnostic(code, field, message));
  }
  object(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.fail('FILE_INVALID', field, '此字段必须是对象。');
      return {};
    }
    const object: Record<string, unknown> = Object.fromEntries(Object.entries(value));
    for (const key of Object.keys(object))
      if (!allowed.includes(key)) {
        this.fail('UNKNOWN_FIELD', `${field}/${key}`, '未识别字段，不能静默丢弃或当作已理解的物理输入。');
      }
    return object;
  }
  array(value: unknown, field: string, maximum: number): readonly unknown[] {
    if (!Array.isArray(value)) {
      this.fail('FILE_INVALID', field, '此字段必须是数组。');
      return [];
    }
    if (value.length > maximum) {
      this.fail('RESOURCE_LIMIT', field, `数组最多允许 ${maximum} 项。`);
      return [];
    }
    return value;
  }
  text(value: unknown, field: string, minimum: number, maximum: number): string {
    if (
      typeof value !== 'string' ||
      value.length < minimum ||
      value.length > maximum ||
      (minimum > 0 && !value.trim())
    ) {
      this.fail('FILE_INVALID', field, `文本长度必须为 ${minimum}–${maximum}，必填文本不能全为空白。`);
      return '';
    }
    return value;
  }
  id(value: unknown, field: string): string {
    const id = this.text(value, field, 1, 40);
    if (!new RegExp(identifierPattern).test(id) || reserved.has(id))
      this.fail('IDENTIFIER_INVALID', field, '编号必须为 1–40 位字母、数字、下划线或连字符，不能使用保留名。');
    return id;
  }
  number(value: unknown, field: string, minimum: number, maximum: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      this.fail('PARAMETER_INVALID', field, `有限数值须在 ${minimum}–${maximum} 之间，不能用缺失值或文本代替。`);
      return 0;
    }
    return value;
  }
  constant(value: unknown, expected: string | number, field: string, code = 'FILE_INVALID'): void {
    if (value !== expected) this.fail(code, field, '字段值或定义版本不受支持。');
  }
  timestamp(value: unknown, field: string): string {
    const text = this.text(value, field, 24, 24);
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text) ||
      !Number.isFinite(Date.parse(text)) ||
      new Date(text).toISOString() !== text
    ) {
      this.fail('FILE_INVALID', field, '时间须为有效的 UTC ISO 时间，含三位毫秒。');
    }
    return text;
  }
  unique(ids: readonly string[], field: string): void {
    if (new Set(ids).size !== ids.length) this.fail('DUPLICATE_ID', field, '编号重复。');
  }
  json(value: unknown, field: string): Json {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((child, i) => this.json(child, `${field}/${i}`));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, this.json(child, `${field}/${key}`)]),
      );
    this.fail('FILE_INVALID', field, '只接受 JSON 元数据。');
    return null;
  }
  extensions(value: unknown, field: string): Readonly<Record<string, Json>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.fail('FILE_INVALID', field, 'extensions 必须是元数据对象。');
      return {};
    }
    const output: Record<string, Json> = {};
    for (const [namespace, data] of Object.entries(value)) {
      if (!new RegExp(metadataNamespacePattern).test(namespace)) {
        this.fail(
          'EXTENSION_UNSUPPORTED',
          `${field}/${namespace}`,
          '仅允许 metadata.<反域名> 命名空间的非物理元数据，物理扩展尚不支持。',
        );
      } else output[namespace] = this.json(data, `${field}/${namespace}`);
    }
    return output;
  }
  finish<T>(value: T): Result<T> {
    return this.diagnostics.length
      ? { ok: false, diagnostics: this.diagnostics }
      : { ok: true, value: immutable(value) };
  }
}
