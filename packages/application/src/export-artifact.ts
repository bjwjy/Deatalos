import { checkJson, diagnostic, type Result } from '@hyd/domain';

export const exportLimits = Object.freeze({ bytes: 4_000_000, ipcBytes: 8_100_000 });
export interface ExportArtifact {
  readonly version: 1;
  readonly snapshotId: string;
  readonly format: 'svg' | 'csv';
  readonly suggestedName: string;
  readonly text: string;
}

/** A bounded export payload, never a filesystem path or executable operation. */
export function parseExportArtifact(input: unknown): Result<ExportArtifact> {
  const fail = (message: string): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic('EXPORT_ARTIFACT_INVALID', '/export', message)],
  });
  const checked = checkJson(input);
  if (!checked.ok) return checked;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('导出内容必须为对象。');
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(input));
  if (
    Object.keys(record).some((k) => !['version', 'snapshotId', 'format', 'suggestedName', 'text'].includes(k)) ||
    record.version !== 1 ||
    typeof record.snapshotId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(record.snapshotId) ||
    (record.format !== 'csv' && record.format !== 'svg') ||
    typeof record.suggestedName !== 'string' ||
    !record.suggestedName ||
    record.suggestedName.length > 100 ||
    /[\\/:*?"<>|\u0000-\u001f]/.test(record.suggestedName) ||
    !record.suggestedName.toLowerCase().endsWith('.' + record.format) ||
    typeof record.text !== 'string'
  )
    return fail('导出格式、版本、名称或快照身份无效。');
  if (utf8Bytes(record.text) > exportLimits.bytes)
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'EXPORT_SIZE_LIMIT',
          '/export',
          `导出为${utf8Bytes(record.text)}字节，超过4MB预算，未写文件；请缩减输入元数据或记录。`,
        ),
      ],
    };
  if (record.format === 'csv' && !record.text.startsWith('\uFEFF"section","object_id","tick","time_s"'))
    return fail('CSV必须使用约定的UTF-8与长表头。');
  if (
    record.format === 'svg' &&
    (!record.text.startsWith('<svg ') ||
      !record.text.endsWith('</svg>') ||
      /<!DOCTYPE|<!ENTITY|<\?|<\s*(?:script|foreignObject|image|use|a|iframe)\b/i.test(record.text))
  )
    return fail('SVG导出不接受脚本、外部对象、实体或链接元素。');
  // Additional platform-boundary restriction. The generator emits no href or URL but local markers.
  if (record.format === 'svg') {
    const elements = new Set([
      'svg',
      'title',
      'desc',
      'metadata',
      'style',
      'defs',
      'marker',
      'path',
      'rect',
      'g',
      'text',
      'circle',
    ]);
    for (const match of record.text.matchAll(/<[^>]+>/g)) {
      const tag = match[0].replace(/"[^"]*"|'[^']*'/g, '""');
      const name = /^<\/?([a-zA-Z][\w:-]*)/.exec(tag)?.[1];
      if (!name || !elements.has(name)) return fail('SVG元素不在基础矢量导出白名单。');
      if (/\s(?:on\w+|(?:xlink:)?href)\s*=/i.test(tag)) return fail('SVG不允许事件或外链属性。');
      for (const attribute of match[0].matchAll(
        /\s(?:fill|stroke|filter|clip-path|mask|marker-start|marker-mid|marker-end)\s*=\s*["']([^"']*)["']/gi,
      )) {
        if (/url\(\s*[^#]/i.test(attribute[1] ?? '')) return fail('SVG图形属性不允许外部资源。');
      }
    }
    const styles = [...record.text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
      .map((m) => m[1] ?? '')
      .concat([...record.text.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1] ?? ''));
    if (styles.some((style) => /url\(\s*[^#]|@import|@font-face/i.test(style))) return fail('SVG不得请求远程资源。');
  }
  return {
    ok: true,
    value: Object.freeze({
      version: 1,
      snapshotId: record.snapshotId,
      format: record.format,
      suggestedName: record.suggestedName,
      text: record.text,
    }),
  };
}

export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
