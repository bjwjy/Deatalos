/** Shorten repeated schemas within one tool. Each tool remains a standalone JSON Schema. */
export function compactToolSchema(root: Record<string, unknown>) {
  const counts = new Map<string, number>();
  const names = new Map<string, string>();
  const definitions: Record<string, unknown> = {};
  function visit(value: unknown, field: string, collect: boolean): unknown {
    if (Array.isArray(value)) return value.map((entry) => visit(entry, field, collect));
    if (!value || typeof value !== 'object') return value;
    if ('type' in value && field !== 'properties') {
      const key = JSON.stringify(value);
      if (key.length >= 90) {
        if (collect) counts.set(key, (counts.get(key) ?? 0) + 1);
        else if ((counts.get(key) ?? 0) > 1) {
          const known = names.get(key);
          if (known) return { $ref: '#/$defs/' + known };
          const name = field.replace(/[^a-zA-Z0-9_]/g, '') + '_' + names.size;
          names.set(key, name);
          definitions[name] = children(value, collect);
          return { $ref: '#/$defs/' + name };
        }
      }
    }
    return children(value, collect);
  }
  function children(value: object, collect: boolean): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field, visit(entry, field, collect)]));
  }
  children(root, true);
  const result = children(root, false);
  return names.size ? { ...result, $defs: definitions } : result;
}
