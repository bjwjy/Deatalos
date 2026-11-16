import { networkTextLayout, type NetworkTextAnnotation } from '@hyd/domain';
import { escapeHtml as esc } from './network-dom.mjs';
/** Pure SVG projection, shared by interactive canvas and formal export. */
export function networkTextSymbol(item: NetworkTextAnnotation, selected = false): string {
  const layout = networkTextLayout(item),
    anchor = item.align === 'left' ? 'start' : item.align === 'right' ? 'end' : 'middle';
  const x = item.align === 'left' ? 6 : item.align === 'right' ? item.width - 6 : item.width / 2;
  return `<g data-text-id="${esc(item.id)}" class="drawing-text${selected ? ' selected' : ''}" transform="translate(${item.x} ${item.y})"><rect data-body-hit="" x="0" y="0" width="${item.width}" height="${layout.height}" fill="${item.background ?? 'transparent'}" stroke="${item.border ? item.color : 'none'}" stroke-width="1"/>${layout.lines.map((line, i) => `<text xml:space="preserve" text-anchor="${anchor}" font-family="Arial,Microsoft YaHei,sans-serif" font-size="${item.fontSize}" fill="${item.color}" stroke="none" x="${x}" y="${6 + item.fontSize + i * item.fontSize * 1.4}">${esc(line || ' ')}</text>`).join('')}${selected ? `<rect data-text-selection="" x="-4" y="-4" width="${item.width + 8}" height="${layout.height + 8}" fill="none" stroke="#b34e20" stroke-width="2" stroke-dasharray="5 3" pointer-events="none"/>` : ''}</g>`;
}
