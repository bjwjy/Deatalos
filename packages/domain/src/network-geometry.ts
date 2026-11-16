import { networkDefinition, networkPortActive } from './network-registry.js';
import type { NetworkComponent, NetworkProject } from './network-model.js';
import { directionalValveSpec } from './network-valve.js';
import { defaultValveActuation, type ValveEndActuation } from './network-valve-actuation.js';

export type NetworkRotation = 0 | 90 | 180 | 270;
export type NetworkPlacement = NetworkProject['layout']['components'][number];
export interface NetworkDrawingBounds {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}
/** Drawing-only instance scale. Missing values retain the compact valve default. */
export function networkDrawingScale(component: NetworkComponent, placement?: { readonly scale?: number }): number {
  return (
    placement?.scale ?? (directionalValveSpec(component.definition.id) && component.definition.version === 2 ? 0.8 : 1)
  );
}
/** Shared cell pitch for canvas symbols and maximum movement geometry. */
export function networkValveCellWidth(component: NetworkComponent): number {
  return directionalValveSpec(component.definition.id)?.ports.length === 5 && component.definition.version === 2
    ? 100
    : 60;
}
/** Maximum moving bank plus actual controls; ports and physical topology never depend on valve position. */
function drawingBounds(component: NetworkComponent): NetworkDrawingBounds | undefined {
  const definition = networkDefinition(component.definition.id, component.definition.version);
  if (definition && component.externalMotorControl) return { ...definition.drawingBounds, bottom: 73 };
  if (!definition || component.typeId !== 'valve') return definition?.drawingBounds;
  const spec = directionalValveSpec(component.definition.id);
  const count = spec?.slots.length ?? 3;
  const cellWidth = networkValveCellWidth(component);
  const edge = ((2 * count - 1) * cellWidth) / 2;
  const drive = component.valveActuation ?? defaultValveActuation;
  const endWidth = (end: ValveEndActuation): number => {
    const start = end.springReturn ? 34 : 12;
    const kinds = [end.manual, end.mechanical, end.fluid].filter((kind) => kind !== 'none');
    return Math.max(start + (end.pilotStage ? 14 : 0), kinds.length ? start + (end.pilotStage ? 18 : 0) + 28 : 0);
  };
  return {
    left: -edge - endWidth(drive.left) - 3,
    right: edge + endWidth(drive.right) + 3,
    top: Math.min(-65, ...definition.ports.map((p) => p.anchor[1] - 8)),
    bottom: Math.max(65, ...definition.ports.map((p) => p.anchor[1] + 8)),
  };
}
/** Exact quarter turns in drawing coordinates (SVG y grows downward). No physical orientation change. */
export function rotateNetworkOffset(x: number, y: number, rotation: NetworkRotation = 0): { x: number; y: number } {
  switch (rotation) {
    case 90:
      return { x: -y, y: x };
    case 180:
      return { x: -x, y: -y };
    case 270:
      return { x: y, y: -x };
    default:
      return { x, y };
  }
}
/** Shared symbol/port/envelope transform. Reflection never swaps logical port identities. */
export function networkPlacementOffset(
  x: number,
  y: number,
  placement: Pick<NetworkPlacement, 'rotation' | 'mirrored'>,
): { x: number; y: number } {
  return rotateNetworkOffset(placement.mirrored ? -x : x, y, placement.rotation);
}
export function networkPortAnchor(
  component: NetworkComponent,
  placement: NetworkPlacement,
  portId: string,
): { x: number; y: number; dx: number; dy: number } | null {
  const port = networkDefinition(component.definition.id, component.definition.version)?.ports.find(
    (p) => p.id === portId,
  );
  if (!port) return null;
  const scale = networkDrawingScale(component, placement);
  // A retained inactive lead terminates next to the shared control anchor.
  // It must not look joined to the active terminal of the other domain.
  const inactiveOffset = networkPortActive(component, port.id) ? 0 : port.id === 'X' ? -15 : 15;
  const offset = networkPlacementOffset((port.anchor[0] + inactiveOffset) * scale, port.anchor[1] * scale, placement);
  const direction = networkPlacementOffset(port.anchor[2], port.anchor[3], placement);
  return { x: placement.x + offset.x, y: placement.y + offset.y, dx: direction.x, dy: direction.y };
}
/** Symmetric upright labels: left ports label left, right ports label right; central ports label outward vertically. */
export function networkPortLabelPosition(
  component: NetworkComponent,
  placement: NetworkPlacement,
  portId: string,
): { x: number; y: number; anchor: 'start' | 'end' | 'middle' } | null {
  const port = networkPortAnchor(component, placement, portId);
  if (!port) return null;
  if (port.x < placement.x) return { x: port.x - 18, y: port.y - 8, anchor: 'end' };
  if (port.x > placement.x) return { x: port.x + 18, y: port.y - 8, anchor: 'start' };
  return { x: port.x, y: port.y + (port.dy < 0 ? -18 : 28), anchor: 'middle' };
}
export function networkComponentBounds(
  component: NetworkComponent,
  placement: NetworkPlacement,
): NetworkDrawingBounds | null {
  const bounds = drawingBounds(component);
  const scale = networkDrawingScale(component, placement);
  if (!bounds) return null;
  const corners = [
    { x: bounds.left, y: bounds.top },
    { x: bounds.right, y: bounds.top },
    { x: bounds.left, y: bounds.bottom },
    { x: bounds.right, y: bounds.bottom },
  ].map((p) => networkPlacementOffset(p.x * scale, p.y * scale, placement));
  return {
    left: placement.x + Math.min(...corners.map((p) => p.x)),
    right: placement.x + Math.max(...corners.map((p) => p.x)),
    top: placement.y + Math.min(...corners.map((p) => p.y)),
    bottom: placement.y + Math.max(...corners.map((p) => p.y)),
  };
}

/** Visible body and upright oil-port lettering; routing continues to use the solid envelope above. */
export function networkComponentPresentationBounds(
  component: NetworkComponent,
  placement: NetworkPlacement,
): NetworkDrawingBounds | null {
  const body = networkComponentBounds(component, placement);
  if (!body) return null;
  const corners = [
    { x: body.left, y: body.top },
    { x: body.right, y: body.bottom },
  ];
  for (const port of networkDefinition(component.definition.id, component.definition.version)?.ports ?? []) {
    if (!networkPortActive(component, port.id)) continue;
    const label = networkPortLabelPosition(component, placement, port.id);
    if (!label) continue;
    const width = port.id.length * 8;
    const left = label.x - (label.anchor === 'end' ? width : label.anchor === 'middle' ? width / 2 : 0);
    corners.push({ x: left - 2, y: label.y - 12 }, { x: left + width + 2, y: label.y + 3 });
  }
  return {
    left: Math.min(...corners.map((p) => p.x)),
    right: Math.max(...corners.map((p) => p.x)),
    top: Math.min(...corners.map((p) => p.y)),
    bottom: Math.max(...corners.map((p) => p.y)),
  };
}
