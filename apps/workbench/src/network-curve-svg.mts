import {
  parseExportArtifact,
  paperDimensions,
  type PaperSize,
  type CurvePlan,
  type NetworkExportCapture,
  type CurveFigureSettings,
  type ExportArtifact,
} from '@hyd/application';
import type { Result } from '@hyd/domain';
import { layoutCurveMark } from './network-curve-annotations.mjs';
export interface CurvePlot {
  readonly samples: CurvePlan['samples'];
  readonly indices: readonly number[];
  readonly label: string;
  readonly unit: string;
  readonly metadata: string;
  readonly keys: CurvePlan['request']['keys'];
}
export interface CurveViewport {
  readonly width: number;
  readonly height: number;
  readonly compact?: boolean;
  readonly scope?: CurveScopeRange;
}
export interface CurveScopeRange {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}
export const scopeColors = ['#ffe864', '#91d7f6'] as const;
export function fitCurveScope(primary: CurvePlot, comparison?: CurvePlot): CurveScopeRange {
  let xMin = Infinity,
    xMax = -Infinity,
    yMin = 0,
    yMax = 0;
  for (const plot of comparison ? [primary, comparison] : [primary]) {
    for (const sample of plot.samples) {
      xMin = Math.min(xMin, sample.timeS);
      xMax = Math.max(xMax, sample.timeS);
      if (sample.value === null) continue;
      yMin = Math.min(yMin, sample.value);
      yMax = Math.max(yMax, sample.value);
    }
  }
  if (!Number.isFinite(xMin)) return { xMin: 0, xMax: 1, yMin: -1, yMax: 1 };
  const margin = (yMax - yMin) * 0.1;
  return {
    // Show a nearby time origin without stretching late retained windows back to zero.
    xMin: xMin >= 0 && xMin <= (xMax - xMin) * 0.1 ? 0 : xMin,
    xMax: xMax > xMin ? xMax : xMin + 0.01,
    yMin: margin === 0 ? -1 : yMin < 0 ? yMin - margin : 0,
    yMax: margin === 0 ? 1 : yMax > 0 ? yMax + margin : 0,
  };
}
export interface CurveFigureOptions {
  readonly primaryLabel?: string;
  readonly comparison?: { readonly plot: CurvePlot; readonly label: string; readonly snapshotId: string };
  readonly hover?: { readonly series: 0 | 1; readonly sampleIndex: number };
}
const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const short = (n: number) => Number(n.toPrecision(6)).toString();
function ticks(min: number, max: number, count = 5, inside = false): number[] {
  const base = 10 ** Math.floor(Math.log10((max - min) / count)),
    f = (max - min) / count / base,
    step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * base,
    result: number[] = [];
  const start = inside ? Math.ceil(min / step - 1e-8) : Math.floor(min / step);
  const stop = inside ? Math.floor(max / step + 1e-8) : Math.ceil(max / step);
  for (let i = start; i <= stop; i++) result.push(Number((i * step).toPrecision(12)));
  return result;
}
/** Physical zero remains visible. No line is invented before the first real recorded time. */
export function curveGeometry(
  plot: CurvePlot,
  settings: CurveFigureSettings,
  viewport?: CurveViewport,
  comparison?: CurvePlot,
) {
  const scope = viewport?.scope;
  const all = scope ? [] : comparison ? [...plot.samples, ...comparison.samples] : plot.samples;
  const values = all.flatMap((p) => (p.value === null ? [] : [p.value]));
  const min = Math.min(0, ...values),
    max = Math.max(0, ...values);
  const end = Math.max(plot.samples.at(-1)?.timeS ?? 0, comparison?.samples.at(-1)?.timeS ?? 0);
  const xt =
    scope && viewport
      ? ticks(scope.xMin, scope.xMax, Math.max(3, viewport.width / 76), true)
      : ticks(0, end > 0 ? end : 0.01);
  const yt =
    scope && viewport
      ? ticks(scope.yMin, scope.yMax, Math.max(3, viewport.height / 63), true)
      : ticks(min === max ? -1 : min, min === max ? 1 : max);
  const headroomValue = scope?.yMax ?? yt.at(-1) ?? 1;
  if (!scope && !viewport?.compact && yt.length >= 2)
    yt.push(Number((headroomValue + (yt[1]! - yt[0]!)).toPrecision(12)));
  const xMin = scope?.xMin ?? xt[0] ?? 0,
    xMax = scope?.xMax ?? xt.at(-1) ?? 1,
    yMin = scope?.yMin ?? yt[0] ?? -1,
    yMax = scope?.yMax ?? yt.at(-1) ?? 1,
    labelLength = Math.max(1, ...yt.map((v) => short(v).length)),
    left = scope ? 64 : viewport ? 22 + labelLength * (viewport.compact ? 6 : 7) : 145,
    right =
      scope && viewport
        ? viewport.width - 36
        : viewport
          ? viewport.width - Math.max(12, short(xMax).length * 3 + 4)
          : 1145,
    top = viewport
      ? scope
        ? 28
        : viewport.compact
          ? 28
          : 34
      : Math.max(1, Math.ceil([...settings.title].length / 40)) * 24 + 66,
    bottom = viewport ? viewport.height - 30 : settings.showExplanation ? 630 : 680;
  return {
    left,
    right,
    top,
    bottom,
    xTicks: xt,
    yTicks: yt,
    xMin,
    xMax,
    yMin,
    yMax,
    headroomBottom: bottom - ((headroomValue - yMin) / (yMax - yMin)) * (bottom - top),
    x: (t: number) => left + ((t - xMin) / (xMax - xMin)) * (right - left),
    y: (v: number) => bottom - ((v - yMin) / (yMax - yMin)) * (bottom - top),
  };
}
/** Shared presentation for current/loaded data, live preview and SVG/PDF source. */
export function curveFigureSvg(
  plot: CurvePlot,
  settings: CurveFigureSettings,
  snapshotId: string,
  viewport?: CurveViewport,
  options: CurveFigureOptions = {},
): Result<ExportArtifact> {
  const g = curveGeometry(plot, settings, viewport, options.comparison?.plot),
    page = paperDimensions(settings.paper, 'landscape');
  const titleChars = [...settings.title];
  const screenTitleLimit = viewport ? Math.max(8, Math.floor((g.right - g.left - 52) / 14)) : titleChars.length;
  const screenTitle =
    titleChars.length > screenTitleLimit ? titleChars.slice(0, screenTitleLimit - 1).join('') + '…' : settings.title;
  const title = viewport
    ? `<text x="${g.left}" y="16" font-size="${viewport.compact ? 11 : 13}">${esc(plot.unit)}</text>${
        viewport.compact
          ? ''
          : `<text x="${(g.left + g.right) / 2}" y="19" text-anchor="middle" font-size="14">${esc(screenTitle)}</text>`
      }`
    : Array.from(
        { length: Math.max(1, Math.ceil(titleChars.length / 40)) },
        (_, i) =>
          `<text x="600" y="${32 + i * 24}" text-anchor="middle" font-size="22">${esc(titleChars.slice(i * 40, (i + 1) * 40).join(''))}</text>`,
      ).join('');
  const scope = viewport?.scope;
  const gridStroke = (value: number) => (scope ? (value === 0 ? '#646464' : '#454545') : '#e0e6e9');
  const grid = [
    ...g.xTicks.map(
      (t) =>
        `<path d="M${g.x(t)} ${g.top}V${g.bottom}" stroke="${gridStroke(t)}"/><text data-curve-tick="x" x="${g.x(t)}" y="${g.bottom + (viewport ? 15 : 27)}" text-anchor="middle">${short(t)}</text>`,
    ),
    ...g.yTicks.map(
      (v) =>
        `<path d="M${g.left} ${g.y(v)}H${g.right}" stroke="${gridStroke(v)}"/><text data-curve-tick="y" x="${g.left - (viewport ? 7 : 15)}" y="${g.y(v) + (viewport ? 4 : 5)}" text-anchor="end">${short(v)}</text>`,
    ),
  ].join('');
  const series = options.comparison ? [plot, options.comparison.plot] : [plot];
  const colors = scope ? scopeColors : ['#276d83', '#9a623e'];
  const segments: [{ x: number; y: number }, { x: number; y: number }][] = [];
  const paths = series
    .map((entry, i) => {
      const selected = new Set(entry.indices);
      let path = '';
      let previous: { x: number; y: number } | undefined;
      for (const p of entry.samples) {
        if (p.value === null) {
          previous = undefined;
          continue;
        }
        if ((!viewport || viewport.compact) && !selected.has(p.index)) continue;
        const point = { x: g.x(p.timeS), y: g.y(p.value) };
        if (previous) segments.push([previous, point]);
        path += `${previous ? 'L' : 'M'}${point.x} ${point.y} `;
        previous = point;
      }
      return `<path data-curve-path="${i}" d="${path}" fill="none" stroke="${colors[i]}" stroke-width="${scope ? 1.7 : 2}" stroke-dasharray="${i ? '7 4' : 'none'}"/>`;
    })
    .join('');
  const dots = viewport
    ? ''
    : series
        .map((entry, i) => {
          const selected = new Set(entry.indices);
          return entry.samples
            .map((p) =>
              p.value === null
                ? ''
                : `<circle data-sample-index="${p.index}" cx="${g.x(p.timeS)}" cy="${g.y(p.value)}" r="${selected.has(p.index) ? 2.5 : 1.5}" fill="${colors[i]}" fill-opacity="${selected.has(p.index) ? 1 : 0.25}"/>`,
            )
            .join('');
        })
        .join('');
  const occupied: Parameters<typeof layoutCurveMark>[3] = [];
  function annotation(
    entry: CurvePlot,
    seriesIndex: number,
    sampleIndex: number,
    key?: CurvePlot['keys'][number],
  ): string {
    const p = entry.samples.find((point) => point.index === sampleIndex);
    if (!p || p.value === null) return '';
    const color = colors[seriesIndex] ?? colors[0]!;
    const point = { x: g.x(p.timeS), y: g.y(p.value) };
    if (scope && (point.x < g.left || point.x > g.right || point.y < g.top || point.y > g.bottom)) return '';
    let lines = [`时间 ${short(p.timeS)} s`, `${short(p.value)} ${entry.unit}`];
    lines.push(...(key?.label.match(/.{1,16}/gu) ?? []));
    let placed = layoutCurveMark(
      { point, color, lines, ...(key ? { offsetX: key.offsetX, offsetY: key.offsetY } : {}) },
      g,
      segments,
      occupied,
    );
    if (!placed && !key) {
      lines = [`${short(p.value)} ${entry.unit}`];
      placed = layoutCurveMark({ point, color, lines }, g, segments, occupied);
    }
    const { x, y } = point;
    const marker = key
      ? `<path d="M${x} ${y - 6}L${x + 6} ${y}L${x} ${y + 6}L${x - 6} ${y}Z" fill="${color}" stroke="#fff" stroke-width="1.5"/>`
      : `<path d="M${x} ${g.top}V${g.bottom}" fill="none" stroke="#98a3af" stroke-dasharray="4 5"/><circle cx="${x}" cy="${y}" r="4.5" fill="#fff" stroke="#65717e" stroke-width="1.5"/>`;
    const guide = placed?.guide
      ? `<path d="M${x} ${y}L${placed.guide.x} ${placed.guide.y}" fill="none" stroke="${color}" stroke-opacity=".7"/>`
      : '';
    const box = placed?.box;
    const label = box
      ? `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="7" fill="#fff" stroke="${color}"/>${lines.map((line, i) => `<text x="${box.x + 9}" y="${box.y + 15 + i * 16}" fill="#243943" font-size="12">${esc(line)}</text>`).join('')}`
      : '';
    return `<g data-key-index="${sampleIndex}" data-key-series="${seriesIndex}" data-annotation="${box ? 'placed' : 'marker'}">${guide}${label}${marker}</g>`;
  }
  const fixed = series
    .map((entry, i) => entry.keys.map((key) => annotation(entry, i, key.sampleIndex, key)).join(''))
    .join('');
  const hoverSeries = options.hover && series[options.hover.series];
  const hover =
    hoverSeries && options.hover && !hoverSeries.keys.some((key) => key.sampleIndex === options.hover?.sampleIndex)
      ? annotation(hoverSeries, options.hover.series, options.hover.sampleIndex)
      : '';
  const legend =
    !viewport && options.comparison
      ? `<text x="${g.left}" y="${g.top - 12}" font-size="13" fill="${colors[0]}">${esc(options.primaryLabel ?? '主曲线')}（实线）</text><text x="${g.left + 385}" y="${g.top - 12}" font-size="13" fill="${colors[1]}">${esc(options.comparison.label)}（虚线）</text>`
      : '';

  const metadata = viewport
    ? esc(JSON.stringify({ snapshotId, comparisonSnapshotId: options.comparison?.snapshotId }))
    : esc(
        JSON.stringify({
          ...JSON.parse(plot.metadata),
          figure: { ...settings, indices: plot.indices, keys: plot.keys },
          ...(options.comparison
            ? {
                comparison: {
                  snapshotId: options.comparison.snapshotId,
                  source: JSON.parse(options.comparison.plot.metadata),
                  indices: options.comparison.plot.indices,
                  keys: options.comparison.plot.keys,
                },
              }
            : {}),
          paper: { size: settings.paper, orientation: 'landscape', ...page },
        }),
      );
  const note =
    settings.showExplanation && !viewport
      ? `<text x="${g.left}" y="710" font-size="13">${esc(`保留样本 ${plot.samples.length} 个，出图 ${plot.indices.length} 个。未知区间断开；未补造样本或改变求解精度。`)}</text><text x="${g.left}" y="734" font-size="12">${esc('来源 ' + snapshotId + '；完整数值、单位、标注及模型来源见文件元数据。')}</text>`
      : '';
  const axes = viewport
    ? `<text x="${g.right}" y="${g.bottom + 26}" text-anchor="end" font-size="10">时间 (s)</text>`
    : `<text x="${(g.left + g.right) / 2}" y="${g.bottom + 58}" text-anchor="middle" font-size="17">时间 t (s)</text><text x="34" y="${(g.top + g.bottom) / 2}" text-anchor="middle" font-size="17" transform="rotate(-90 34 ${(g.top + g.bottom) / 2})">${esc(plot.label + ' (' + plot.unit + ')')}</text>`;
  const dimensions = viewport
    ? `width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}"`
    : `width="${page.widthMm}mm" height="${page.heightMm}mm" viewBox="0 0 1200 760"`;
  const bounds = `x="${g.left}" y="${g.top}" width="${g.right - g.left}" height="${g.bottom - g.top}"`;
  const scopeFrame = scope ? `<rect data-curve-scope-frame="" ${bounds} fill="#131313" stroke="#b4b4b4"/>` : '';
  const marks = (values: readonly number[], min: number, max: number) => {
    const step = values.length > 1 ? (values[1]! - values[0]!) / 5 : (max - min) / 20;
    const output: { value: number; length: number }[] = [];
    for (let i = Math.ceil(min / step); i <= Math.floor(max / step); i++)
      output.push({ value: i * step, length: i % 5 === 0 ? 6 : 3 });
    return output;
  };
  const scopeTicks = scope
    ? `<path fill="none" stroke="#b4b4b4" d="${marks(g.xTicks, g.xMin, g.xMax)
        .map(({ value, length }) => `M${g.x(value)} ${g.top}v${length}M${g.x(value)} ${g.bottom}v-${length}`)
        .join('')}${marks(g.yTicks, g.yMin, g.yMax)
        .map(({ value, length }) => `M${g.left} ${g.y(value)}h${length}M${g.right} ${g.y(value)}h-${length}`)
        .join('')}"/>`
    : '';
  const zero = scope
    ? ''
    : `<path data-axis="zero" d="M${g.x(0)} ${g.top}V${g.bottom}M${g.left} ${g.y(0)}H${g.right}" fill="none" stroke="#405965" stroke-width="1.5"/>`;
  const trace = scope
    ? `<svg ${bounds} viewBox="${g.left} ${g.top} ${g.right - g.left} ${g.bottom - g.top}" overflow="hidden">${paths}${fixed}${hover}</svg>`
    : paths + dots + fixed + hover;
  const text = `<svg xmlns="http://www.w3.org/2000/svg" ${dimensions}><title>${esc(settings.title)}</title><metadata>${metadata}</metadata><rect width="${viewport?.width ?? 1200}" height="${viewport?.height ?? 760}" fill="${scope ? '#212121' : 'white'}"/><g font-family="Microsoft YaHei, Arial, sans-serif" font-size="${viewport ? 11 : 15}" fill="${scope ? '#e2e2e2' : '#243943'}">${title}${scopeFrame}${grid}${scopeTicks}${zero}${axes}${legend}${trace}${note}</g></svg>`;
  return parseExportArtifact({ version: 1, snapshotId, format: 'svg', suggestedName: '曲线图.svg', text });
}
export function exportCurveSvg(
  capture: NetworkExportCapture,
  plan: CurvePlan,
  paper: PaperSize = 'A4',
  settings?: CurveFigureSettings,
  viewport?: CurveViewport,
): Result<ExportArtifact> {
  return curveFigureSvg(
    { ...plan, keys: plan.request.keys },
    settings ?? { paper, title: plan.request.target.objectId + ' · ' + plan.label, showExplanation: true },
    capture.snapshotId,
    viewport,
  );
}
