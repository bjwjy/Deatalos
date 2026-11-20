import { sharedDrawingTracks, visibleTrackPath } from './network-shared-tracks.mjs';
import { networkDrawingScale } from '@hyd/domain';
import {
  paperDimensions,
  parseDrawingSettings,
  parseNetworkArtifact,
  networkDrawingRoutes,
  type NetworkArtifact,
  type DrawingTemplate,
} from '@hyd/application';
import { initialNetworkControls, diagnostic, parseNetworkProject, type NetworkProject, type Result } from '@hyd/domain';
import { networkSymbol } from './network-symbols.mjs';
import { networkTextSymbol } from './network-text-symbol.mjs';
import { pressureGaugeDrawing } from './network-instrument-symbols.mjs';
import { projectBounds } from './network-cad.mjs';
import { routePath, signalDash } from './network-presentation.mjs';
const xml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
/** 180 x 56 mm user-selected template. Coordinates and line widths are in physical millimetres. */
export function titleBlock(
  fields: Readonly<Record<string, string>>,
  changes: readonly Readonly<Record<string, string>>[],
  template?: DrawingTemplate,
  measureText?: (value: string) => number,
  titleCells: Readonly<Record<string, string>> = {},
  locateField?: (
    key: string,
    value: string,
    x: number,
    y: number,
    width: number,
    height: number,
    label?: string,
    fontSizePt?: number,
  ) => void,
): Result<string> {
  const paths: string[] = [],
    texts: string[] = [],
    errors: string[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number) => paths.push(`<path d="M${x1} ${y1}L${x2} ${y2}"/>`);
  function text(
    value: string,
    x: number,
    y: number,
    w: number,
    h: number,
    key: string,
    label?: string,
    styleKey = key,
  ) {
    const points = template?.fontSizes?.[styleKey];
    if (locateField) {
      locateField(key, value, x, y, w, h, label, points);
      return;
    }
    if (!value) return;
    let chosen: { size: number; lines: string[] } | null = null;
    // Prefer a readable single line for names/dates and short fixed headers.
    // Otherwise the largest two-line fit can split only the final date digit.
    const width = (s: string) =>
      measureText ? measureText(s) : [...s].reduce((n, c) => n + (/[\u0020-\u007e]/.test(c) ? 0.56 : 1), 0);
    const widthUnits = width(value);
    const fixed = typeof points === 'number' ? (points * 25.4) / 72 : undefined;
    const maximum = fixed ?? 3.5,
      minimum = fixed ?? 2.5;
    const singleSize = Math.min(maximum, (w - 1.6) / widthUnits, (h - 1) / 1.12);
    if (singleSize >= minimum) chosen = { size: singleSize, lines: [value] };
    for (let size = maximum; size >= minimum - 0.001; size -= 0.1) {
      if (chosen) break;
      const lines: string[] = [];
      let row = '';
      for (const character of value) {
        const advance = width(row + character) * size;
        if (advance > w - 1.6 && row) {
          lines.push(row);
          row = '';
        }
        row += character;
      }
      if (row) lines.push(row);
      if (
        lines.length * size * 1.12 <= h - 1 &&
        (fixed === undefined || lines.every((row) => width(row) * size <= w - 1.6))
      ) {
        chosen = { size, lines };
        break;
      }
    }
    if (!chosen) {
      errors.push(fixed === undefined ? key : (label ?? key) + '（' + points + ' pt，可调小字号或扩大格子）');
      return;
    }
    const size = chosen.size,
      blockH = chosen.lines.length * size * 1.12;
    texts.push(
      ...chosen.lines.map(
        (row, i) =>
          `<text x="${x + w / 2}" y="${y + (h - blockH) / 2 + size * 0.86 + i * size * 1.12}" font-size="${size}" text-anchor="middle">${xml(row)}</text>`,
      ),
    );
  }
  function cell(key: string, value: string, x: number, y: number, w: number, h: number, label: string, styleKey = key) {
    text(titleCells[key] ?? value, x, y, w, h, key, label, styleKey);
  }
  if (template?.table) {
    for (const c of template.table) {
      const x = c.left / 100,
        y = c.top / 100,
        w = (c.right - c.left) / 100,
        h = (c.bottom - c.top) / 100;
      if (c.left) line(x, y, x, y + h);
      if (c.top) line(x, y, x + w, y);
      if (c.field)
        text(fields[c.field] ?? '', x, y, w, h, c.field, template.fields.find((f) => f.key === c.field)?.label, c.id);
      else cell('tableText.' + c.id, c.text, x, y, w, h, '固定文字', c.id);
    }
  } else if (template) {
    const visible = template.fields.filter((f) => f.visible),
      columns = template.columns ?? 4,
      width = 180 / columns,
      heading = width * (14 / 45),
      rows = Math.ceil(visible.length / columns),
      height = 56 / rows;
    for (let x = width; x < 180; x += width) line(x, 0, x, 56);
    for (let y = height; y < 55.99; y += height) line(0, y, 180, y);
    visible.forEach((field, i) => {
      const x = (i % columns) * width,
        y = Math.floor(i / columns) * height;
      line(x + heading, y, x + heading, y + height);
      cell('templateHeading.' + field.key, field.label, x, y, heading, height, field.label + '字段名');
      text(fields[field.key] ?? '', x + heading, y, width - heading, height, field.key);
    });
    for (let i = visible.length; i < rows * columns; i++)
      cell(
        'templateSpare.' + (i - visible.length),
        '',
        (i % columns) * width,
        (rows - 1) * height,
        width,
        height,
        '模板空白格 ' + (i - visible.length + 1),
      );
  } else {
    const topWidths = [10, 10, 16, 16, 12, 16],
      keys = ['mark', 'count', 'zone', 'number', 'signature', 'date'],
      labels = ['标记', '处数', '分区', '更改文件号', '签名', '年月日'];
    let at = 0;
    for (let i = 0; i < topWidths.length; i++) {
      const width = topWidths[i];
      if (width === undefined) continue;
      if (at > 0) line(at, 0, at, 28);
      const key = keys[i];
      if (!key) continue;
      cell('changeHeading.' + key, labels[i] ?? '', at, 21, width, 7, '更改表头：' + labels[i]);
      for (let row = 0; row < 3; row++) text(changes[row]?.[key] ?? '', at, row * 7, width, 7, `更改${row + 1}.${key}`);
      at += width;
    }
    for (const y of [7, 14, 21, 28]) line(0, y, 80, y);
    for (const x of [12, 24, 40, 52, 64]) line(x, 28, x, 56);
    for (const y of [35, 42, 49]) line(0, y, 80, y);
    const left = [
        ['设计', 'design'],
        ['', 'check'],
        ['审核', 'review'],
        ['工艺', 'process'],
      ],
      right = [
        ['标准化', 'standard'],
        ['', 'spare1'],
        ['', 'spare2'],
        ['批准', 'approve'],
      ];
    for (let row = 0; row < 4; row++)
      for (const [entries, x] of [
        [left, 0],
        [right, 40],
      ] as const) {
        const entry = entries[row];
        if (!entry) continue;
        const [label, key] = entry;
        const y = 28 + row * 7;
        const role = label || (key === 'check' ? '校核' : '备用签审 ' + row);
        cell('signHeading.' + key, label ?? '', x, y, 12, 7, role + '表头');
        cell(key + 'Name', fields[key + 'Name'] ?? '', x + 12, y, 12, 7, role + '签名');
        cell(key + 'Date', fields[key + 'Date'] ?? '', x + 24, y, 16, 7, role + '日期');
      }
    line(80, 0, 80, 56);
    line(130, 0, 130, 56);
    line(80, 28, 130, 28);
    line(80, 38, 130, 38);
    line(80, 47, 180, 47);
    for (const x of [106, 118]) line(x, 28, x, 47);
    for (const x of [86.5, 93, 99.5]) line(x, 38, x, 47);
    text(fields.material ?? '', 80, 0, 50, 28, 'material');
    cell('stageHeading', '阶段标记', 80, 28, 26, 10, '阶段标记表头');
    cell('massHeading', '质量', 106, 28, 12, 10, '质量表头');
    cell('scaleHeading', '比例', 118, 28, 12, 10, '比例表头');
    if ([...(fields.stage ?? '')].length > 4) errors.push('stage（最多4个字符）');
    const stage = [...(fields.stage ?? '')];
    for (let i = 0; i < 4; i++)
      cell('stage.' + i, stage[i] ?? '', 80 + i * 6.5, 38, 6.5, 9, '阶段标记第 ' + (i + 1) + ' 格');
    text(fields.mass ?? '', 106, 38, 12, 9, 'mass');
    text(fields.scale ?? '', 118, 38, 12, 9, 'scale');
    const total = '共 ' + (fields.total ?? '') + ' 张';
    const sheet = '第 ' + (fields.sheet ?? '') + ' 张';
    if (locateField || titleCells.totalCell !== undefined || titleCells.sheetCell !== undefined) {
      line(105, 47, 105, 56);
      cell('totalCell', total, 80, 47, 25, 9, '共几张');
      cell('sheetCell', sheet, 105, 47, 25, 9, '第几张');
    } else text(total + '　 ' + sheet, 80, 47, 50, 9, 'sheet');
    line(130, 17, 180, 17);
    line(130, 35, 180, 35);
    text(fields.organization ?? '', 130, 0, 50, 17, 'organization');
    text(fields.title ?? '', 130, 17, 50, 18, 'title');
    text(fields.number ?? '', 130, 35, 50, 12, 'number');
    text(fields.projection ?? '', 130, 47, 50, 9, 'projection');
  }
  if (errors.length)
    return {
      ok: false,
      diagnostics: [
        diagnostic('TITLE_TEXT_OVERFLOW', '/fields', '以下内容超出标题栏单格，请缩短：' + errors.join('、')),
      ],
    };
  return {
    ok: true,
    value: `<g fill="none" stroke="black" stroke-width="0.25">${paths.join('')}<rect width="180" height="56" stroke-width="0.5"/></g><g fill="black" font-family="SimSun,宋体,serif">${texts.join('')}</g>`,
  };
}
export function drawingSheet(
  project: NetworkProject,
  input: unknown,
  source: {
    snapshotId: string;
    documentSessionId: string;
    revision: number;
    physicsRevision: number;
    capturedAt: string;
  },
  format: 'svg' | 'pdf' | 'png' | 'jpg',
  measure?: (markup: string) => { left: number; right: number; top: number; bottom: number },
  measureText?: (value: string) => number,
): Result<NetworkArtifact> {
  const parsedProject = parseNetworkProject(project);
  if (!parsedProject.ok) return parsedProject;
  const parsed = parseDrawingSettings(input);
  if (!parsed.ok) return parsed;
  const settings = parsed.value,
    block = titleBlock(settings.fields, settings.changes, settings.template, measureText, settings.titleCells);
  if (!block.ok) return block;
  const { widthMm: w, heightMm: h } = paperDimensions(settings.paper, settings.orientation),
    margin = settings.paper === 'A2' ? 10 : 5,
    leftMargin = settings.bindingEdge === false ? margin : 25;
  const bounds = projectBounds(parsedProject.value),
    routes = networkDrawingRoutes(parsedProject.value),
    elements: string[] = [];
  const shared = sharedDrawingTracks(parsedProject.value, routes);
  for (const connection of parsedProject.value.design.connections) {
    const route = routes.get(connection.id);
    if (!route?.ok)
      return route ?? { ok: false, diagnostics: [diagnostic('DRAWING_ROUTE_INVALID', '/drawing', '缺少绘图路径。')] };
    for (const p of route.value) {
      bounds.left = Math.min(bounds.left, p.x - 30);
      bounds.right = Math.max(bounds.right, p.x + 30);
      bounds.top = Math.min(bounds.top, p.y - 30);
      bounds.bottom = Math.max(bounds.bottom, p.y + 30);
    }
    const visible = shared.pieces.get(connection.id);
    elements.push(
      `<path data-connection-id="${xml(connection.id)}" d="${visible ? visibleTrackPath(visible) : routePath(route.value)}" fill="none" stroke="black" stroke-width="${connection.kind === 'signal' ? 1.5 : 2}"${connection.kind === 'signal' ? ` stroke-dasharray="${signalDash}"` : ''}/>`,
    );
  }
  for (const { point } of shared.junctions)
    elements.push(`<circle cx="${point.x}" cy="${point.y}" r="4" fill="black"/>`);
  const controls = initialNetworkControls(parsedProject.value);
  for (const c of parsedProject.value.design.components) {
    const p = parsedProject.value.layout.components.find((v) => v.componentId === c.id);
    if (!p) return { ok: false, diagnostics: [diagnostic('DRAWING_LAYOUT_INVALID', '/drawing', '元件缺少布局。')] };
    elements.push(
      `<g transform="translate(${p.x} ${p.y})">${networkSymbol(c, [], controls, { labels: settings.labels === 'all', details: false }, p.rotation, networkDrawingScale(c, p), p.mirrored)}</g>`,
    );
  }
  for (const node of parsedProject.value.layout.nodes)
    elements.push(`<circle cx="${node.x}" cy="${node.y}" r="4" fill="black"/>`);
  for (const text of parsedProject.value.layout.texts ?? []) elements.push(networkTextSymbol(text));
  if (parsedProject.value.controlProbes?.length) elements.push(pressureGaugeDrawing(parsedProject.value, null));
  if (measure && elements.length) {
    const actual = measure(elements.join(''));
    if (
      ![actual.left, actual.right, actual.top, actual.bottom].every(Number.isFinite) ||
      actual.right <= actual.left ||
      actual.bottom <= actual.top
    )
      return {
        ok: false,
        diagnostics: [diagnostic('DRAWING_BOUNDS_INVALID', '/drawing', '无法测量当前图形与文字，未导出。')],
      };
    Object.assign(bounds, {
      left: actual.left - 4,
      right: actual.right + 4,
      top: actual.top - 4,
      bottom: actual.bottom + 4,
    });
  }
  const availableW = w - leftMargin - margin - 10,
    availableH = h - margin * 2 - 56 - 20,
    scale =
      Math.min(availableW / (bounds.right - bounds.left), availableH / (bounds.bottom - bounds.top)) *
      settings.occupancy;
  const smallestText = Math.min(
    ...(parsedProject.value.layout.texts ?? []).map((item) => item.fontSize),
    ...(parsedProject.value.design.components.length ? [12] : []),
  );
  if (Number.isFinite(smallestText) && scale * smallestText < 1.2)
    return {
      ok: false,
      diagnostics: [diagnostic('DRAWING_TOO_DENSE', '/paper', '所选幅面下图中文字过小，请选更大幅面或提高图形占比。')],
    };
  const tx = leftMargin + 5 + (availableW - (bounds.right - bounds.left) * scale) / 2 - bounds.left * scale,
    ty = margin + 5 + (availableH - (bounds.bottom - bounds.top) * scale) / 2 - bounds.top * scale;
  const metadata = JSON.stringify({
    format: 'HydraulicDrawingSheet',
    version: 1,
    source,
    settings,
    project: parsedProject.value,
    template: settings.template ?? 'user-180x56-20261025',
    references: ['GB/T 14689-2008', 'GB/T 10609.1-2008'],
    content: 'saved design and initial valve controls; no simulation results; diagram scale is not physical dimensions',
    geometry: {
      widthMm: w,
      heightMm: h,
      titleBlock: { x: w - margin - 180, y: h - margin - 56, widthMm: 180, heightMm: 56 },
      drawingScaleMmPerWorldUnit: scale,
      contentBounds: bounds,
    },
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}"><title>${xml(parsedProject.value.title)} 原理图</title><metadata>${xml(metadata)}</metadata><rect width="${w}" height="${h}" fill="white"/><rect x="${leftMargin}" y="${margin}" width="${w - leftMargin - margin}" height="${h - margin * 2}" fill="none" stroke="black" stroke-width="0.5"/><g data-drawing-circuit="true" transform="translate(${tx} ${ty}) scale(${scale})" fill="none" stroke="black" font-family="Microsoft YaHei, sans-serif" font-size="12">${elements.join('')}</g><g transform="translate(${w - margin - 180} ${h - margin - 56})">${block.value}</g></svg>`;
  return parseNetworkArtifact({
    version: 1,
    snapshotId: source.snapshotId,
    format,
    suggestedName: '液压原理图.' + format,
    text: svg,
  });
}
