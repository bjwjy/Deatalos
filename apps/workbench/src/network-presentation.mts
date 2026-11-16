import {
  valueReasonDisplay,
  type NetworkComponent,
  type NetworkConnection,
  type NetworkProject,
  type NetworkSnapshot,
  type NetworkReading,
} from '@hyd/domain';
import { displayNetworkQuantity } from '@hyd/engineering';

type Value = NetworkReading['value'];
type Endpoint = NetworkProject['design']['connections'][number]['from'];
const missing: Value = { kind: 'unknown', reason: 'MISSING_READING' };
import {
  defaultPressureBands,
  pressureBand,
  pressurePalette,
  pressureLegendFor,
  type PressureBands,
} from './network-pressure.mjs';
export { pressureBand, pressureColors } from './network-pressure.mjs';
export const pressureLegend = pressureLegendFor(defaultPressureBands);
export const signalDash = '6 3 1 3';
export function controlVoltage(point: NetworkSnapshot | null, id: string): number | null {
  const value = point?.readings.find(
    (r) => r.quantity === 'control-voltage' && r.location.kind === 'component' && r.location.componentId === id,
  )?.value;
  return value?.kind === 'known' ? value.value : null;
}
export function controlSignalColor(mode: 'switch' | 'analog', voltage: number | null): string {
  if (voltage === null) return '#7b8490';
  if (mode === 'switch') return voltage === 10 ? '#16804b' : '#b63b46';
  // Interpolate the display color in RGB. Voltage is already a validated native result.
  const fraction = voltage / 10;
  return `rgb(${Math.round(29 + 93 * fraction)}, ${Math.round(111 - 52 * fraction)}, ${Math.round(173 - 4 * fraction)})`;
}
export function signalPresentation(
  components: ReadonlyMap<string, NetworkComponent>,
  point: NetworkSnapshot | null,
  edge: NetworkConnection,
) {
  const sender = edge.from.kind === 'port' ? components.get(edge.from.componentId) : undefined;
  const mode = sender?.pressureSwitchOutput?.mode ?? 'switch';
  const voltage = sender ? controlVoltage(point, sender.id) : null;
  return { mode, voltage, color: controlSignalColor(mode, voltage) };
}
export function pressureReference(project: NetworkProject): string {
  const ref = project.design.pressureReference;
  return `压力基准：${ref.kind === 'gauge' ? '表压' : '内核数值基准（不自行解释为绝压）'}；${ref.absoluteReferencePa === null ? '未指定绝对参考压力' : `绝对参考压力 ${ref.absoluteReferencePa} Pa`}。`;
}
export function endpointPressure(point: NetworkSnapshot | null, endpoint: Endpoint): Value {
  return (
    point?.readings.find(
      (r) =>
        r.quantity === 'pressure' &&
        (endpoint.kind === 'node'
          ? r.location.kind === 'node' && r.location.nodeId === endpoint.nodeId
          : r.location.kind === 'port' &&
            r.location.componentId === endpoint.componentId &&
            r.location.portId === endpoint.portId),
    )?.value ?? missing
  );
}
function text(value: Value, unit: string, label: string): string {
  if (value.kind !== 'known') return `未知：${valueReasonDisplay(value.reason)}`;
  const displayed = displayNetworkQuantity({
    objectKind: 'connection',
    objectId: '',
    field: '',
    label: '',
    source: 'kernel',
    formula: 'kernel',
    inputs: [],
    unit,
    value,
  });
  return displayed.value.kind === 'known'
    ? `${displayed.value.value.toPrecision(6)} ${displayed.unit}（${label} ${value.value} ${unit}）`
    : '未知';
}
export function connectionPresentation(
  project: NetworkProject,
  point: NetworkSnapshot | null,
  id: string,
  bands: PressureBands = defaultPressureBands,
) {
  const edge = project.design.connections.find((e) => e.id === id);
  if (!edge) return null;
  const from = endpointPressure(point, edge.from),
    to = endpointPressure(point, edge.to);
  const flow =
    point?.readings.find(
      (r) => r.quantity === 'flow' && r.location.kind === 'connection' && r.location.connectionId === id,
    )?.value ?? missing;
  const direction =
    flow.kind === 'known' && Number.isFinite(flow.value)
      ? flow.value > 0
        ? 'forward'
        : flow.value < 0
          ? 'reverse'
          : 'zero'
      : 'unknown';
  // Only a shared measured pressure can colour an entire connection. A physical
  // pipe's unequal endpoint readings are NOT an along-pipe pressure profile.
  const uniform = from.kind === 'known' && to.kind === 'known' && from.value === to.value;
  const colors = pressurePalette(bands);
  const directionText = {
    forward: '实际流向：起点 → 终点。',
    reverse: '实际流向：终点 → 起点。',
    zero: '零流量不代表零压力。',
    unknown: '独立流量未知，不绘制流向箭头。',
  }[direction];
  return {
    from,
    to,
    flow,
    direction,
    uniform,
    fromColor: colors[pressureBand(from, bands)],
    toColor: colors[pressureBand(to, bands)],
    color: uniform ? colors[pressureBand(from, bands)] : colors.unknown,
    summary: `起点压力 ${text(from, 'Pa', 'SI')}；终点压力 ${text(to, 'Pa', 'SI')}；起点→终点流量 ${text(flow, 'm³/s', 'SI')}。${directionText}${uniform ? '两端读数一致。' : '仅着色端点，不代表沿程分布。'}`,
  };
}
export interface DrawingPoint {
  readonly x: number;
  readonly y: number;
}
export function connectionRoute(a: DrawingPoint, b: DrawingPoint): readonly DrawingPoint[] {
  const mid = (a.x + b.x) / 2;
  return Math.abs(a.y - b.y) < 8 ? [a, b] : [a, { x: mid, y: a.y }, { x: mid, y: b.y }, b];
}
export function routePath(points: readonly DrawingPoint[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
}
/** Static capture: one arrow. Live view: three advancing arrows, never a fluid velocity claim. */
export function flowArrow(
  points: readonly DrawingPoint[],
  direction: string,
  mode: 'static' | 'animated' = 'static',
): string {
  if (direction !== 'forward' && direction !== 'reverse') return '';
  const segments = points
    .slice(1)
    .map((b, i) => ({ a: points[i]!, b, length: Math.hypot(b.x - points[i]!.x, b.y - points[i]!.y) }));
  const segment = segments.reduce<(typeof segments)[number] | null>(
    (best, s) => (!best || s.length > best.length ? s : best),
    null,
  );
  if (!segment || segment.length < 16) return '';
  const { a, b } = segment,
    sign = direction === 'forward' ? 1 : -1;
  const angle = (Math.atan2((b.y - a.y) * sign, (b.x - a.x) * sign) * 180) / Math.PI;
  if (mode === 'animated') {
    const travel = Math.min(90, segment.length - 12);
    const arrows = Array.from(
      { length: 3 },
      () =>
        `<path data-connection-arrow="${direction}" d="M-4 -5L3 0L-4 5" fill="none" stroke="#263e4c" stroke-width="2.5"/>`,
    ).join('');
    return `<g class="flow-arrow-motion" data-flow-motion="${direction}" style="--flow-start:${-travel / 2}px;--flow-end:${travel / 2}px" transform="translate(${(a.x + b.x) / 2} ${(a.y + b.y) / 2}) rotate(${angle})" pointer-events="none">${arrows}</g>`;
  }
  return `<path data-connection-arrow="${direction}" d="M-7 -5L0 0L-7 5" transform="translate(${(a.x + b.x) / 2} ${(a.y + b.y) / 2}) rotate(${angle})" fill="none" stroke="#263e4c" stroke-width="2.5" pointer-events="none"/>`;
}
