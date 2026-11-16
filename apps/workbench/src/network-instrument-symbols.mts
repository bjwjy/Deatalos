import {
  networkProbeEndpoint,
  networkProbeName,
  networkProbePressure,
  type NetworkComponent,
  type NetworkDrawingBounds,
  type NetworkProject,
  type NetworkSnapshot,
} from '@hyd/domain';
import { networkEndpointPosition } from '@hyd/application';
import { pressureProbeGauge } from './network-controller-symbols.mjs';
import { escapeHtml } from './network-dom.mjs';
import { resolveRoute, type Point } from './network-cad.mjs';
import { controlSignalColor, controlVoltage, routePath } from './network-presentation.mjs';

export function pressureGaugeRoute(id: string, start: Point, end: Point, points?: readonly Point[]): readonly Point[] {
  if (points) return resolveRoute(start, end, { connectionId: id, mode: 'manual', points });
  // Leave the bottom measurement connector downward even when the tap is above the dial.
  const middle = end.y >= start.y + 24 ? (start.y + end.y) / 2 : start.y + 18;
  const detour = end.y < start.y && Math.abs(end.x - start.x) < 30;
  const side = start.x + (end.x < start.x ? -36 : 36);
  const route = detour
    ? [start, { x: start.x, y: middle }, { x: side, y: middle }, { x: side, y: end.y }, end]
    : [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end];
  return route.filter((point, i, route) => i === 0 || point.x !== route[i - 1]?.x || point.y !== route[i - 1]?.y);
}
/** Only a valid same-source port reading is displayed. A missing result remains unknown. */
export function flowMeterReading(componentId: string, point: NetworkSnapshot | null): string {
  const reading = point?.readings.find(
    (r) =>
      r.quantity === 'flow' &&
      r.unit === 'm³/s' &&
      r.location.kind === 'port' &&
      r.location.componentId === componentId &&
      r.location.portId === 'A',
  );
  return reading?.value.kind === 'known' && Number.isFinite(reading.value.value)
    ? (reading.value.value * 60000).toFixed(2) + ' L/min'
    : '— L/min';
}

export function inlineInstrumentReading(component: NetworkComponent, point: NetworkSnapshot | null, y: number): string {
  const attribute = 'text-anchor="middle" fill="#354b62" font-size="12"';
  if (component.typeId === 'flow-meter')
    return `<text data-flow-meter-reading="true" y="${y}" ${attribute}>${flowMeterReading(component.id, point)}</text>`;
  const pressureSwitch = component.typeId === 'adjustable-pressure-switch';
  const voltage = controlVoltage(point, component.id);
  const voltageText = voltage === null ? '— V' : voltage.toFixed(2) + ' V';
  if (component.externalMotorControl) {
    const kind = component.externalMotorControl.kind;
    const actual = point?.readings.find(
      (r) =>
        r.location.kind === 'component' && r.location.componentId === component.id && r.quantity === 'displacement',
    )?.value;
    const amount = actual?.kind === 'known' ? (actual.value * 1e6).toFixed(2) + ' cm³/rev' : '— cm³/rev';
    const pressure = point?.readings.find(
      (r) =>
        r.location.kind === 'port' &&
        r.location.portId === 'X' &&
        r.location.componentId === component.id &&
        r.quantity === 'pressure',
    )?.value;
    const input =
      kind === 'pressure'
        ? 'X · ' + (pressure?.kind === 'known' ? (pressure.value / 1e6).toFixed(2) + ' MPa' : '— MPa')
        : 'U · ' + voltageText;
    return `<text data-external-motor-reading="${kind}" y="${y}" ${attribute}>${input} · ${amount}</text>`;
  }
  if (pressureSwitch && component.pressureSwitchOutput?.mode === 'analog') {
    const pressure = point?.readings.find(
      (r) =>
        r.location.kind === 'port' &&
        r.location.portId === 'H' &&
        r.location.componentId === component.id &&
        r.quantity === 'pressure',
    )?.value;
    const input = pressure?.kind === 'known' ? (pressure.value / 1e6).toFixed(2) + ' MPa' : '— MPa';
    return `<text data-pressure-switch-voltage="analog" y="${y}" ${attribute}>${input} → <tspan fill="${controlSignalColor('analog', voltage)}">${voltageText}${voltage === null ? '' : ' · ' + (voltage * 10).toFixed(0) + '%'}</tspan></text>`;
  }
  if (pressureSwitch || component.typeId === 'pilot-unloading-valve') {
    const quantity = pressureSwitch ? 'pressure-switch-state' : 'unloading-state';
    const value = point?.readings.find(
      (r) => r.quantity === quantity && r.location.kind === 'component' && r.location.componentId === component.id,
    )?.value;
    const labels = pressureSwitch ? ['触点断开', '触点闭合'] : ['关闭', '卸荷'];
    const display = value?.kind === 'known' ? (labels[value.value] ?? '—') : '—';
    return `<text y="${y}" ${attribute}><tspan data-${quantity}="true">${display}</tspan>${pressureSwitch ? `<tspan data-pressure-switch-voltage="switch" fill="${controlSignalColor('switch', voltage)}"> · ${voltageText}</tspan>` : ''}</text>`;
  }
  if (component.typeId !== 'differential-pressure-gauge') return '';
  const value = point?.readings.find(
    (r) =>
      r.quantity === 'differential-pressure' &&
      r.location.kind === 'component' &&
      r.location.componentId === component.id,
  )?.value;
  const display = value?.kind === 'known' ? (value.value / 1000).toFixed(2) : '—';
  return `<text data-differential-pressure-reading="true" y="${y}" ${attribute}>Δp ${display} kPa</text>`;
}
export function inlineInstrumentY(component: NetworkComponent, bounds: NetworkDrawingBounds, labels: boolean): number {
  if (component.externalMotorControl || component.typeId === 'adjustable-pressure-switch') return bounds.top - 14;
  return Math.max(45, bounds.bottom + 24) + (labels ? 18 : 0);
}

/** Formal drawings and the live canvas use the same gauge glyph, target and routing rules. */
export function pressureGaugeDrawing(project: NetworkProject, point: NetworkSnapshot | null): string {
  return (project.controlProbes ?? [])
    .map((probe) => {
      const p = project.layout.probes?.find((v) => v.probeId === probe.id);
      if (!p) return '';
      const endpoint = networkProbeEndpoint(project, probe);
      const target = endpoint ? networkEndpointPosition(project, endpoint) : null;
      const reading = networkProbePressure(project, probe.id, point);
      const path = target
        ? '<path d="' +
          routePath(pressureGaugeRoute(probe.id, { x: p.x, y: p.y + 43.52 }, target, p.signalPoints)) +
          '" fill="none" stroke="#354b62" stroke-width="2"/>'
        : '';
      return (
        path +
        `<g data-pressure-gauge="${escapeHtml(probe.id)}" transform="translate(${p.x} ${p.y})"><text text-anchor="middle" y="-34">${escapeHtml(networkProbeName(project, probe))}</text><g transform="scale(.68)">${pressureProbeGauge(1, reading.kind === 'known' ? reading.value : null, 0.68)}<path d="M0 33V64" stroke="#354b62" fill="none"/></g></g>`
      );
    })
    .join('');
}
