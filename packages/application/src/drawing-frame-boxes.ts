import { checkJson, ContractReader, type Result } from '@hyd/domain';
import {
  frameBoxLimits,
  parseDrawingTemplate,
  type DrawingTableCell,
  type DrawingTemplate,
} from './drawing-template.js';

const { widthMm, heightMm, minWidthMm, minHeightMm, maxCells } = frameBoxLimits;

type Rectangle = Pick<DrawingTableCell, 'left' | 'top' | 'right' | 'bottom'>;

// Sweep bands between requested edges. Adjacent blank spans with equal width form one editable cell.
function blankRectangles(boxes: readonly Rectangle[], width: number, height: number): Rectangle[] {
  const cuts = [...new Set([0, height, ...boxes.flatMap((b) => [b.top, b.bottom])])].sort((a, b) => a - b);
  const blanks: Rectangle[] = [];
  let previous = new Map<string, number>();
  for (const [i, top] of cuts.entries()) {
    const bottom = cuts[i + 1];
    if (bottom === undefined) break;
    const occupied = boxes.filter((b) => b.top <= top && b.bottom > top).sort((a, b) => a.left - b.left);
    const current = new Map<string, number>();
    let left = 0;
    for (const interval of [...occupied, { left: width, right: width }]) {
      const right = interval.left;
      if (right > left) {
        const key = left + '/' + right;
        const index = previous.get(key) ?? blanks.length;
        blanks[index] = { left, top: blanks[index]?.top ?? top, right, bottom };
        current.set(key, index);
      }
      left = interval.right;
    }
    previous = current;
  }
  return blanks;
}

const transpose = (r: Rectangle): Rectangle => ({ left: r.top, top: r.left, right: r.bottom, bottom: r.right });

export function drawingFrameFromBoxes(input: unknown): Result<DrawingTemplate> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const reader = new ContractReader();
  const spec = reader.object(input, '', ['name', 'boxes', 'fillBlank']);
  const name = reader.text(spec.name, '/name', 1, 60);
  if (/[\u0000-\u001f\uFFFE\uFFFF]/.test(name)) reader.fail('FRAME_NAME_INVALID', '/name', '模板名称含无效字符。');
  if (spec.fillBlank !== undefined && typeof spec.fillBlank !== 'boolean')
    reader.fail('FRAME_LAYOUT_INVALID', '/fillBlank', '请明确是否允许增加空白格。');
  const boxes = reader.array(spec.boxes, '/boxes', maxCells).map((raw, index) => {
    const at = '/boxes/' + index;
    const box = reader.object(raw, at, ['xMm', 'yMm', 'widthMm', 'heightMm', 'text']);
    const coordinate = (key: string, minimum: number, maximum: number) => {
      const mm = reader.number(box[key], at + '/' + key, minimum, maximum);
      const units = Math.round(mm * 100);
      if (units / 100 !== mm) reader.fail('FRAME_PRECISION', at + '/' + key, '尺寸最多保留两位小数，单位 mm。');
      return units;
    };
    const left = coordinate('xMm', 0, widthMm);
    const top = coordinate('yMm', 0, heightMm);
    const right = left + coordinate('widthMm', minWidthMm, widthMm);
    const bottom = top + coordinate('heightMm', minHeightMm, heightMm);
    if (right > widthMm * 100 || bottom > heightMm * 100)
      reader.fail('FRAME_OUTSIDE', at, '该格超出 180 × 56 mm 标题栏。');
    const text = box.text === undefined ? '' : reader.text(box.text, at + '/text', 0, 160);
    return { id: 'c' + (index + 1), left, top, right, bottom, text };
  });
  if (!boxes.length) reader.fail('FRAME_LAYOUT_INVALID', '/boxes', '请指定至少一个格子。');
  for (const [index, box] of boxes.entries()) {
    if (
      boxes
        .slice(0, index)
        .some((b) => b.left < box.right && b.right > box.left && b.top < box.bottom && b.bottom > box.top)
    )
      reader.fail('FRAME_OVERLAP', '/boxes/' + index, '该格与前面的格子重叠。');
  }
  const checked = reader.finish(true);
  if (!checked.ok) return checked;
  const area = boxes.reduce((sum, b) => sum + (b.right - b.left) * (b.bottom - b.top), 0);
  if (area < widthMm * heightMm * 10000) {
    if (spec.fillBlank !== true) {
      reader.fail(
        'FRAME_GAP',
        '/boxes',
        '这些格子没有铺满标题栏。要保持格数请调整尺寸，允许补空白格时可传 fillBlank:true。',
      );
    } else {
      const fits = (cells: Rectangle[]) =>
        cells.length + boxes.length <= maxCells &&
        cells.every((c) => c.right - c.left >= minWidthMm * 100 && c.bottom - c.top >= minHeightMm * 100);
      let blanks = blankRectangles(boxes, widthMm * 100, heightMm * 100);
      if (!fits(blanks)) blanks = blankRectangles(boxes.map(transpose), heightMm * 100, widthMm * 100).map(transpose);
      if (!fits(blanks)) reader.fail('FRAME_GAP', '/boxes', '剩余空间无法自动分格，请明确分格或调整尺寸。');
      else boxes.push(...blanks.map((b, i) => ({ ...b, id: 'cBlank' + (i + 1), text: '' })));
    }
  }
  const table = reader.finish(boxes);
  return table.ok ? parseDrawingTemplate({ version: 1, name, fields: [], table: table.value }) : table;
}
