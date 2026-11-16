import { ContractReader } from './reader.js';
import type { NetworkTextAnnotation } from './network-model.js';

export function readNetworkTexts(r: ContractReader, input: unknown): readonly NetworkTextAnnotation[] {
  const items = r.array(input, '/layout/texts', 60).map((value, i): NetworkTextAnnotation => {
    const f = '/layout/texts/' + i;
    const raw = r.object(value, f, [
      'id',
      'kind',
      'version',
      'x',
      'y',
      'width',
      'text',
      'fontSize',
      'color',
      'align',
      'border',
      'background',
    ]);
    r.constant(raw.kind, 'text', f + '/kind');
    r.constant(raw.version, 1, f + '/version');
    const color = r.text(raw.color, f + '/color', 7, 7);
    const text = r.text(raw.text, f + '/text', 1, 4000).replace(/\r\n?/g, '\n');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
      r.fail('TEXT_INVALID', f + '/text', '文本包含不支持的控制字符。');
    if (typeof raw.width === 'number' && typeof raw.fontSize === 'number' && raw.width < raw.fontSize * 1.05 + 12)
      r.fail('TEXT_INVALID', f + '/width', '宽度不足以容纳当前字号，请加宽文本框。');
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) r.fail('TEXT_INVALID', f + '/color', '文字颜色必须为六位十六进制色值。');
    const align = raw.align === 'center' || raw.align === 'right' ? raw.align : 'left';
    if (!['left', 'center', 'right'].includes(String(raw.align)))
      r.fail('TEXT_INVALID', f + '/align', '未知文本对齐方式。');
    if (raw.background !== null && raw.background !== '#ffffff')
      r.fail('TEXT_INVALID', f + '/background', '背景仅支持透明或白色。');
    if (typeof raw.border !== 'boolean') r.fail('TEXT_INVALID', f + '/border', '边框开关必须为布尔值。');
    return {
      id: r.id(raw.id, f + '/id'),
      kind: 'text',
      version: 1,
      x: r.number(raw.x, f + '/x', -1e6, 1e6),
      y: r.number(raw.y, f + '/y', -1e6, 1e6),
      width: r.number(raw.width, f + '/width', 60, 3000),
      text,
      fontSize: r.number(raw.fontSize, f + '/fontSize', 8, 72),
      color,
      align,
      border: raw.border === true,
      background: raw.background === '#ffffff' ? '#ffffff' : null,
    };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length)
    r.fail('TEXT_INVALID', '/layout/texts', '文本标注编号不能重复。');
  return items;
}
/** Drawing units only. Same line breaks and envelope are consumed by canvas and formal sheets. */
export function networkTextLayout(item: NetworkTextAnnotation): {
  readonly lines: readonly string[];
  readonly height: number;
} {
  const lines: string[] = [],
    available = item.width - 12;
  for (const paragraph of item.text.split('\n')) {
    let line = '',
      width = 0;
    for (const character of paragraph) {
      const advance = item.fontSize * (/^[\u0020-\u007e]$/.test(character) ? 0.65 : 1.05);
      if (line && width + advance > available) {
        lines.push(line);
        line = '';
        width = 0;
      }
      line += character;
      width += advance;
    }
    lines.push(line);
  }
  return { lines, height: lines.length * item.fontSize * 1.4 + 12 };
}
