import { sharedDrawingTracks, visibleTrackPath, longestTrack } from './network-shared-tracks.mjs';
import { networkDrawingScale, networkComponentPresentationBounds, networkEndpointActive } from '@hyd/domain';
import {
  parseExportArtifact,
  networkDrawingRoutes,
  type ExportArtifact,
  type NetworkExportCapture,
} from '@hyd/application';
import { diagnostic, type Result } from '@hyd/domain';
import { networkSymbol } from './network-symbols.mjs';
import { inlineInstrumentReading, inlineInstrumentY, pressureGaugeDrawing } from './network-instrument-symbols.mjs';
import {
  defaultPressureBands,
  parsePressureBands,
  pressureLegendFor,
  type PressureBands,
} from './network-pressure.mjs';
import { endpointPosition } from './network-cad.mjs';
import { projectBounds } from './network-cad.mjs';
import {
  connectionPresentation,
  routePath,
  flowArrow,
  pressureReference,
  signalDash,
  signalPresentation,
} from './network-presentation.mjs';

const xml = (value: string): string =>
  value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/gu, '\uFFFD')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);

/** Standalone v3 snapshot drawing. Geometry uses the shared registered symbol source;
 * all result annotations and metadata come from one immutable network capture. */
export function exportNetworkSvg(
  capture: NetworkExportCapture,
  labels: 'all' | 'none' = 'all',
  bands: PressureBands = defaultPressureBands,
): Result<ExportArtifact> {
  const parsedBands = parsePressureBands(bands);
  if (!parsedBands.ok) return parsedBands;
  const pressureLegend = pressureLegendFor(parsedBands.value);
  const project = capture.view.document,
    point = capture.view.point;
  const positions = new Map(project.layout.components.map((v) => [v.componentId, v]));
  const components = new Map(project.design.components.map((c) => [c.id, c]));
  const endpoint = (value: (typeof project.design.connections)[number]['from']) => {
    return endpointPosition(project, value);
  };
  const routeResults = networkDrawingRoutes(project);
  for (const routed of routeResults.values()) if (!routed.ok) return routed;
  const shared = sharedDrawingTracks(project, routeResults);
  const edges = project.design.connections.map((connection) => {
    const from = endpoint(connection.from),
      to = endpoint(connection.to);
    if (!from || !to) return null;
    const routed = routeResults.get(connection.id);
    if (!routed?.ok) return null;
    const active = networkEndpointActive(project, connection.from) && networkEndpointActive(project, connection.to);
    if (connection.kind === 'signal' || !active) {
      const signal = active ? signalPresentation(components, point, connection) : null;
      return `<path data-connection-id="${xml(connection.id)}" data-connection-kind="${connection.kind}" d="${routePath(routed.value)}" fill="none" stroke="${signal?.color ?? '#a3aab1'}" style="stroke-width:${connection.kind === 'signal' ? 1.5 : 2}" stroke-dasharray="${connection.kind === 'signal' ? signalDash : '3 5'}"/>`;
    }
    const route = routed.value,
      value = connectionPresentation(project, point, connection.id, parsedBands.value)!;
    const visible = shared.pieces.get(connection.id);
    return `<g data-connection-id="${xml(connection.id)}" data-flow="${value.direction}" data-pressure="${value.uniform ? 'uniform' : 'endpoints-only'}"><title>${xml(value.summary)}</title><path d="${visible ? visibleTrackPath(visible) : routePath(route)}" fill="none" stroke="${value.color}" stroke-width="3"${value.uniform ? '' : ' stroke-dasharray="6 4"'}/>${flowArrow(visible ? longestTrack(visible) : route, value.direction)}<circle cx="${from.x}" cy="${from.y}" r="6" fill="${value.fromColor}"/><circle cx="${to.x}" cy="${to.y}" r="6" fill="${value.toColor}"/></g>`;
  });
  if (edges.some((v) => v === null))
    return {
      ok: false,
      diagnostics: [diagnostic('SVG_GEOMETRY_UNAVAILABLE', '/layout', '连接端点缺少注册油口或节点布局。')],
    };
  const placed = project.design.components.map((component) => {
    const p = positions.get(component.id);
    if (!p) return null;
    const bounds = networkComponentPresentationBounds(component, { ...p, x: 0, y: 0 });
    const meter = bounds
      ? inlineInstrumentReading(component, point, inlineInstrumentY(component, bounds, labels === 'all'))
      : '';
    return `<g transform="translate(${p.x} ${p.y})">${networkSymbol(component, point.states, point.appliedControls, { labels: labels === 'all', details: false }, p.rotation, networkDrawingScale(component, p), p.mirrored)}${meter}</g>`;
  });
  if (placed.some((v) => v === null))
    return { ok: false, diagnostics: [diagnostic('SVG_GEOMETRY_UNAVAILABLE', '/layout', '元件缺少已注册布局。')] };
  const bounds = projectBounds(project);
  for (const routed of routeResults.values())
    if (routed.ok)
      for (const p of routed.value) {
        bounds.left = Math.min(bounds.left, p.x - 40);
        bounds.right = Math.max(bounds.right, p.x + 40);
        bounds.top = Math.min(bounds.top, p.y - 40);
        bounds.bottom = Math.max(bounds.bottom, p.y + 40);
      }
  const left = bounds.left - 20,
    top = bounds.top - 150;
  // Keep room for the existing wrapped source/pressure notes even when the
  // circuit occupies a narrow column. Layout bounds must not clip the legend.
  const right = Math.max(bounds.right + 20, left + 1440),
    bottom = bounds.bottom + 20;
  const width = right - left,
    height = bottom - top;
  // Keep explanations above the circuit, with explicit wrapping so a long
  // pressure legend cannot run outside the exported page.
  const notes = [
    pressureReference(project),
    pressureLegend,
    '灰线配端点色：仅端点测量，不推测沿程压力。名称范围：' + (labels === 'all' ? '全部元件' : '隐藏全部元件名称'),
  ];
  const wrapped = notes.flatMap((s) =>
    Array.from({ length: Math.ceil(s.length / 100) }, (_, i) => s.slice(i * 100, i * 100 + 100)),
  );
  const legend = wrapped.map((s, i) => `<text x="${left + 20}" y="${top + 80 + 19 * i}">${xml(s)}</text>`).join('');
  const text = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${Math.ceil((1000 * height) / width)}" viewBox="${left} ${top} ${width} ${height}" role="img">
<title>${xml(project.title)} · ${capture.selection === 'history' ? '历史' : '当前'}仿真结果</title>
<desc>Hopsan ${xml(point.solver.version)} · 计算步 ${point.identity.tick} · ${point.identity.timeS} s · 未知值不补零</desc>
<metadata id="network-result-snapshot">${xml(JSON.stringify({ capture, assumptions: capture.view.assumptions, presentation: { labels, pressureLegend, pressureBands: parsedBands.value } }))}</metadata>
<style>text{font-family:Segoe UI,Microsoft YaHei,sans-serif;fill:#354b62;font-size:12px}path,circle,rect{stroke-width:2}</style>
<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="white" stroke="none"/>
<text x="${left + 20}" y="${top + 28}">${xml(project.title)} · 计算步 ${point.identity.tick} / ${point.identity.timeS} s</text>
<text x="${left + 20}" y="${top + 50}">工程修订 ${point.identity.physicsRevision} · 控制序号 ${point.identity.controlSequence} · 完整来源身份见技术元数据</text>
${legend}${edges.join('')}${shared.junctions.map(({ point: p, connectionId }) => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="${connectionPresentation(project, point, connectionId, parsedBands.value)?.color ?? '#526475'}"/>`).join('')}${placed.join('')}${pressureGaugeDrawing(project, point)}
</svg>`;
  const parsed = parseExportArtifact({
    version: 1,
    snapshotId: capture.snapshotId,
    format: 'svg',
    suggestedName: '网络结果.svg',
    text,
  });
  return parsed;
}
