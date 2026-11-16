import { directionalFunctionOptions, networkDefinition, type NetworkDefinition } from '@hyd/domain';
import { defaultValveActuation, type ValveActuation, type ValveEndActuation } from '@hyd/domain';
function head(x: number, y: number, dx: number, dy: number): string {
  const length = Math.hypot(dx, dy),
    c = dx / length,
    s = dy / length;
  return `M${x - 7 * c + 4 * s} ${y - 7 * s - 4 * c}L${x} ${y}L${x - 7 * c - 4 * s} ${y - 7 * s + 4 * c}`;
}
function endSymbol(value: ValveEndActuation): string {
  let svg = value.springReturn
    ? '<path data-spring="true" d="M0 0H4L8 -8L14 8L20 -8L26 8L30 0H34"/>'
    : '<path d="M0 0H12"/>';
  const start = value.springReturn ? 34 : 12;
  if (value.pilotStage) svg += `<path data-pilot-stage="true" d="M${start + 14} -10L${start} 0L${start + 14} 10Z"/>`;
  const x = start + (value.pilotStage ? 18 : 0);
  const kinds = [value.manual, value.mechanical, value.fluid].filter((item) => item !== 'none');
  if (!kinds.length) return svg;
  svg += `<path d="M${start} 0H${x + 5}"/>`;
  if (kinds.length > 1) svg += `<path d="M${x + 5} ${-(kinds.length - 1) * 13}V${(kinds.length - 1) * 13}"/>`;
  for (const [index, kind] of kinds.entries()) {
    const y = (index - (kinds.length - 1) / 2) * 26;
    let mark = '';
    if (kind === 'solenoid') mark = '<rect x="0" y="-11" width="20" height="22"/><path d="M1 10L19 -10"/>';
    if (kind === 'hydraulic') mark = '<path d="M20 -10L0 0L20 10Z"/>';
    if (kind === 'button') mark = '<path d="M0 0H15M15 -9V9M19 -9V9"/>';
    if (kind === 'lever') mark = '<path d="M0 0L14 -14"/><circle cx="16" cy="-16" r="3"/>';
    if (kind === 'pedal') mark = '<path d="M0 0H9L18 10M11 12L23 7"/>';
    if (kind === 'plunger') mark = '<path d="M0 0H15M15 -7V7"/>';
    if (kind === 'roller') mark = '<path d="M0 0H10"/><circle cx="15" cy="0" r="5"/>';
    svg += `<g data-drive-kind="${kind}" transform="translate(${x + 5} ${y})">${mark}</g>`;
  }
  return svg;
}
export function directionalDriveSymbols(halfWidth: number, actuation: ValveActuation = defaultValveActuation): string {
  return `<g data-valve-drive="left" transform="translate(${-halfWidth} 0) scale(-1 1)">${endSymbol(actuation.left)}</g><g data-valve-drive="right" transform="translate(${halfWidth} 0)">${endSymbol(actuation.right)}</g>`;
}

/** Shared visible topology for v2 canvas, SVG export and graphical pickers. */
export function directionalCellPaths(
  ports: NetworkDefinition['ports'],
  paths: readonly (readonly [string, string])[],
): string {
  const remaining = new Set(paths.flat());
  let svg = paths.map(([a, b]) => `<g data-flow-path="${a}-${b}"></g>`).join('');
  while (remaining.size) {
    const first = [...remaining][0];
    if (!first) break;
    const group = new Set([first]);
    for (let pass = 0; pass < ports.length; pass++)
      for (const [a, b] of paths)
        if (group.has(a) || group.has(b)) {
          group.add(a);
          group.add(b);
        }
    for (const id of group) remaining.delete(id);
    const members = ports.filter((port) => group.has(port.id));
    if (members.length === 2) {
      const pair = paths.find(([a, b]) => group.has(a) && group.has(b));
      const a = ports.find((port) => port.id === pair?.[0]),
        b = ports.find((port) => port.id === pair?.[1]);
      if (!a || !b) throw new Error('Directional pair missing');
      const x1 = a.anchor[0],
        y1 = a.anchor[1] > 0 ? 26 : -26,
        x2 = b.anchor[0],
        y2 = b.anchor[1] > 0 ? 26 : -26;
      svg +=
        y1 === y2
          ? `<path data-flow-arrow="true" d="M${x1} ${y1}V0H${x2}V${y2}${head(x2, y2, 0, y2)}"/>`
          : `<path data-flow-arrow="true" d="M${x1} ${y1}L${x2} ${y2}${head(x2, y2, x2 - x1, y2 - y1)}"/>`;
    } else {
      svg += members.map((port) => `<path d="M${port.anchor[0]} ${port.anchor[1] > 0 ? 26 : -26}V0H0"/>`).join('');
      for (const x of new Set(members.map((port) => port.anchor[0])))
        svg += `<circle data-port-junction="true" cx="${x}" cy="0" r="2.2" fill="currentColor" stroke="none"/>`;
    }
  }
  svg += ports
    .filter((port) => !paths.some((pair) => pair.includes(port.id)))
    .map((port) => {
      const [x, y] = port.anchor,
        edge = y > 0 ? 30 : -30,
        stop = y > 0 ? 14 : -14;
      return `<path data-blocked-port="${port.id}" d="M${x} ${edge}V${stop}M${x - 6} ${stop}H${x + 6}"/>`;
    })
    .join('');
  return svg;
}
export function directionalFunctionPictogram(portCount: number, code: number): string {
  const definition = networkDefinition(`teaching:directional-3-${portCount}`, 2);
  const fn = directionalFunctionOptions(portCount).find((item) => item.code === code);
  if (!definition || !fn) throw new Error('Unsupported graphical valve function');
  const labels = definition.ports
    .map(
      (port) =>
        `<text x="${port.anchor[0]}" y="${port.anchor[1] > 0 ? 42 : -35}" text-anchor="middle" fill="currentColor" stroke="none" font-size="10">${port.id}</text>`,
    )
    .join('');
  const half = portCount === 5 ? 50 : 30;
  return `<svg viewBox="${-half - 16} -47 ${2 * half + 32} 94" aria-hidden="true" focusable="false"><g stroke="currentColor" stroke-width="1.8" fill="none"><rect x="${-half}" y="-30" width="${2 * half}" height="60"/>${directionalCellPaths(definition.ports, fn.paths)}${labels}</g></svg>`;
}
