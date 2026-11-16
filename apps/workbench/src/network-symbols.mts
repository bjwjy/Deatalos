import {
  networkComponentPresentationBounds,
  networkValveCellWidth,
  networkPortLabelPosition,
  type NetworkRotation,
} from '@hyd/domain';
import { directionalValveSpec, networkValvePaths, networkValveFunction } from '@hyd/domain';
import { directionalCellPaths, directionalDriveSymbols } from './network-valve-symbols.mjs';
import { controllerSymbol } from './network-controller-symbols.mjs';
import {
  networkDefinition,
  networkPortActive,
  positionDisplayName,
  type NetworkComponent,
  type NetworkControl,
  type NetworkState,
} from '@hyd/domain';

const xml = (s: string): string =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/gu, '\uFFFD')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? '');
/** Owned SVG emitters use scalar numeric text anchors. Reflect positions while counter-reflecting glyphs. */
function readableMirroredText(svg: string): string {
  return svg.replace(/<text\b([^>]*)>/g, (_tag, attributes: string) => {
    const value = /\sx="([^"]+)"/.exec(attributes),
      x = value ? Number(value[1]) : 0;
    if (!Number.isFinite(x)) throw new Error('Symbol text requires a finite scalar anchor');
    const previous = /\stransform="([^"]*)"/.exec(attributes);
    const rest = attributes.replace(/\stransform="[^"]*"/, '');
    return `<text${rest} transform="translate(${2 * x} 0) scale(-1 1)${previous ? ' ' + previous[1] : ''}">`;
  });
}
// Local arrow paths avoid duplicate SVG marker IDs across instances and exports.
const arrow = (x1: number, y1: number, x2: number, y2: number): string => {
  const a = Math.atan2(y2 - y1, x2 - x1),
    c = Math.cos(a),
    s = Math.sin(a);
  return `<path data-flow-arrow="true" d="M${x1} ${y1}L${x2} ${y2}m${-7 * c + 4 * s} ${-7 * s - 4 * c}L${x2} ${y2}l${-7 * c - 4 * s} ${-7 * s + 4 * c}"/>`;
};
function pilotCheckSymbol(external: boolean): string {
  return (
    '<g data-pressure-control="pilot-check" data-drain="' +
    (external ? 'external' : 'internal') +
    '" data-free-flow="A-B">' +
    '<path d="M0 45V18M0 -14V-45M-12 6L0 16L12 6"/><circle cy="-5" r="8"/>' +
    '<path d="M-60 0H-44V24H-34" stroke-dasharray="4 3"/>' +
    '<path data-pilot-actuator="true" d="M-34 16H-16V32H-34ZM-16 24H0V9M-4 13L0 8L4 13"/>' +
    '<path fill="#354b62" stroke="none" d="M-31 20L-23 24L-31 28Z"/>' +
    (external ? '<path data-external-drain="true" d="M-16 28H60" stroke-dasharray="4 3"/>' : '') +
    '</g>'
  );
}
function pressureControlSymbol(sequence: boolean): string {
  const senseY = sequence ? -30 : 30;
  return (
    '<g data-pressure-control="' +
    (sequence ? 'sequence' : 'reducing') +
    '"><rect x="-18" y="-20" width="36" height="40"/><path d="M0 -45V-20M0 20V45M18 0H25L30 -7L37 7L44 -7L51 7L58 0"/>' +
    '<path d="M0 ' +
    senseY +
    'H-34V0H-18M42 9V30H70" stroke-dasharray="4 3"/>' +
    arrow(sequence ? -8 : 0, -14, sequence ? 8 : 0, 14) +
    arrow(31, 16, 51, -16) +
    '</g>'
  );
}
type SymbolContext = {
  readonly component: NetworkComponent;
  readonly state: NetworkState | undefined;
  readonly center: string | null;
  readonly designPosition: string | undefined;
};
function teachingCylinderSymbol({ component, state }: SymbolContext): string {
  const single = component.typeId === 'single-acting-cylinder';
  const dualRod = component.typeId === 'cushioned-double-rod-cylinder';
  const stroke = component.parameters.geometry?.strokeM;
  const x = state?.kind === 'cylinder' && stroke ? -42 + (84 * state.positionM) / stroke : -22;
  const spring = single
    ? Array.from({ length: 9 }, (_, i) => {
        const sx = x + 5 + ((59 - x) * i) / 8,
          sy = i === 0 || i === 8 ? 11 : i % 2 === 0 ? 17 : 5;
        return (i === 0 ? 'M' : 'L') + sx + ' ' + sy;
      }).join('')
    : '';
  const cushion = single
    ? ''
    : '<g data-end-cushions="true"><path d="M-64 -11H-53V11H-64ZM64 -11H53V11H64Z"/>' +
      arrow(-67, 14, -48, -15) +
      arrow(49, 14, 67, -15) +
      '</g>';
  return (
    `<g data-actuator-symbol="${component.typeId}"><rect x="-68" y="-22" width="136" height="44"/><path d="M-55 22V40${single ? '' : 'M55 22V40'}"/>` +
    cushion +
    (single ? `<path data-return-spring="true" d="${spring}"/>` : '') +
    `<g data-piston-source="${state?.kind === 'cylinder' ? 'kernel' : 'unavailable'}" transform="translate(${x} 0)"><path data-piston="true" d="M-3 -22H3V22H-3Z"/><path data-rod="true" d="M3 -4H120V4H3Z${dualRod ? 'M-3 -4H-120V4H-3Z' : ''}"/></g></g>`
  );
}
function limitedRotarySymbol({ component, state }: SymbolContext): string {
  const angle = state?.kind === 'motor' ? (state.angleRad * 180) / Math.PI : 0;
  return (
    '<g data-limited-rotary="true"><circle r="28"/><path d="M-55 28H-37V0H-28M55 28H37V0H28"/>' +
    '<path fill="#354b62" d="M-25 -7V7L-13 0ZM25 -7V7L13 0Z"/><path d="M-28 -31Q0 -53 28 -31m-7 -1l7 1 -2 -7M-32 -33l8 6M24 -27l8 -6"/>' +
    (networkPortActive(component, 'T')
      ? '<path data-rotary-protection="true" d="M-37 28V38H37V28M0 38V54" stroke-dasharray="4 3"/>'
      : '') +
    `<g data-rotor-source="${state?.kind === 'motor' ? 'kernel' : 'unavailable'}" transform="rotate(${angle})"><circle r="3"/><path d="M0 -3V-17"/></g></g>`
  );
}
const renderers: Readonly<Record<string, (context: SymbolContext) => string>> = Object.freeze({
  'single-acting-cylinder': teachingCylinderSymbol,
  'cushioned-cylinder': teachingCylinderSymbol,
  'cushioned-double-rod-cylinder': teachingCylinderSymbol,
  'limited-rotary-actuator': limitedRotarySymbol,
  'flow-meter': () =>
    '<g data-flow-meter="true"><circle r="25"/><path d="M-45 0H-25M25 0H45M-13 14L12 -13M2 -13H12V-3"/><text x="-8" y="-6" stroke="none" fill="#354b62" font-size="12">Q</text></g>',
  'return-filter': () =>
    '<g data-return-filter="true"><path d="M-45 0H-23M23 0H45M-23 0L0 -23L23 0L0 23Z"/><path d="M0 -21V21" stroke-dasharray="4 3"/></g>',
  'differential-pressure-gauge': () =>
    '<g data-differential-pressure-gauge="true"><circle r="25"/><path d="M-32 42V30L-16 19M32 42V30L16 19M-11 9L11 -11M3 -11H11V-3"/><text y="-5" x="-15" stroke="none" fill="#354b62" font-size="10">Δp</text></g>',
  'flow-divider-combiner': () =>
    '<g data-flow-divider-combiner="true"><rect x="-38" y="-24" width="76" height="48"/><path d="M-25 -45V-12L0 12L25 -12V-45M0 12V45M-25 -6L-15 -17M15 -17L25 -6M-19 1L-9 -10M9 -10L19 1"/><path d="M-25 14H-14M14 14H25" stroke-dasharray="3 2"/></g>',
  'adjustable-pressure-switch': ({ component }) =>
    component.pressureSwitchOutput?.mode === 'analog'
      ? '<g data-adjustable-pressure-switch="true" data-pressure-symbol="analog"><rect x="-32" y="-23" width="64" height="48"/><path d="M0 44V25M-22 10V-15M-22 10H22M-18 5H-10L12 -11H22M22 -7H32"/></g>'
      : '<g data-adjustable-pressure-switch="true" data-pressure-symbol="switch"><rect x="-32" y="-23" width="64" height="48"/><path d="M0 44V25M0 25V9M-12 9H12M-32 -7H-16L10 -15M15 -7H32M11 5L15 1L19 5L23 1L28 5M24 12L36 0M29 0H36V7"/></g>',
  'pilot-unloading-valve': () =>
    '<g data-pilot-unloading-valve="true"><rect x="-39" y="-25" width="78" height="50"/><path d="M-22 44V25M22 44V25M-22 18V6M-29 6H-15M22 18V6M15 6H29M-32 -8H28M20 -15L28 -8L20 -1M39 0H43L46 -6L50 6L54 0M42 11L55 -9M48 -9H55V-2"/><path d="M-57 0H-39" stroke-dasharray="4 3"/></g>',
  'synchronizing-flow-divider': () =>
    '<g data-synchronizing-flow-divider="true"><rect x="-42" y="-25" width="84" height="50"/><path d="M-25 -45V-12L0 12L25 -12V-45M0 12V45M-25 -6L-15 -17M15 -17L25 -6M-19 1L-9 -10M9 -10L19 1M-25 -20H-34V18H34V-20H25M0 18V12M-39 2L-29 -7M29 -7L39 2"/><path d="M-28 11H-14M14 11H28" stroke-dasharray="3 2"/></g>',
  'three-way-flow-control': () =>
    '<g data-three-way-flow-control="true"><rect x="-37" y="-23" width="76" height="46"/>' +
    '<path d="M-22 48V7M-22 -7V-48M23 16V48M-22 16H23M-31 -7L-22 0L-31 7M-13 -7L-22 0L-13 7M-35 11L-10 -13M39 2H44L48 -4L52 8L56 -4L61 2"/>' +
    arrow(23, 14, 23, 21) +
    '<path d="M-22 -35H23V-23" stroke-dasharray="4 3"/></g>',
  'shock-makeup-valve': () =>
    '<g data-shock-makeup-valve="true"><rect x="-61" y="-28" width="122" height="56" stroke-dasharray="5 3"/>' +
    '<path d="M-34 -48V-18H-52V18H52V-18H34V-48M-34 -18H-16V18M34 -18H16V18M0 18V48"/>' +
    arrow(-52, -11, -52, 11) +
    arrow(52, -11, 52, 11) +
    '<path d="M-48 -5l4 4 4 -4 4 4M48 -5l-4 4 -4 -4 -4 4M-22 4L-16 -2L-10 4M10 4L16 -2L22 4"/>' +
    '<circle cx="-16" cy="7" r="3"/><circle cx="16" cy="7" r="3"/></g>',
  'pressure-intensifier': () =>
    '<g data-pressure-intensifier="true"><path d="M-26 48V24M26 48V24M0 -26V-48M-41 24V-6H-17V-26H17V-6H41V24Z"/>' +
    '<path d="M-41 6H41M-17 -12H17M0 -12V24M-35 32L-25 24M25 24L35 32"/>' +
    arrow(0, -32, 0, -43) +
    '</g>',
  'dynamic-controller': ({ component }) => controllerSymbol(component.controllerColor ?? 1),
  'manual-shutoff': () =>
    '<g data-manual-shutoff="true"><path d="M-45 0H-16M16 0H45M-16 -12L16 12V-12L-16 12ZM0 0V-23M-13 -23H13"/></g>',
  'shuttle-valve': () =>
    '<g data-hydraulic-shuttle="true"><path d="M-45 0H-29M29 0H45M0 -42V-18"/><rect x="-29" y="-18" width="58" height="36"/><path d="M-21 -10L-13 0L-21 10M21 -10L13 0L21 10"/><circle r="6"/></g>',
  'two-pressure-valve': () =>
    '<g data-hydraulic-and="true"><path d="M-45 0H-29M29 0H45M0 -42V-18"/><rect x="-29" y="-18" width="58" height="36"/><path d="M-22 -8H-14V8H-22M22 -8H14V8H22"/><text text-anchor="middle" y="6" font-size="16" fill="#354b62" stroke="none">&amp;</text></g>',
  'pilot-check-close': () =>
    '<g data-pilot-close="true"><path d="M0 45V18M0 -14V-45M-12 6L0 16L12 6"/><circle cy="-5" r="8"/><path d="M60 -22H33" stroke-dasharray="4 3"/><path d="M33 -30H16V-14H33ZM16 -22H7L0 -15M0 -20V-15H5"/><path fill="#354b62" stroke="none" d="M28 -26L20 -22L28 -18Z"/></g>',
  'pressure-reducing-relieving': () =>
    '<g data-reducing-relieving="true" transform="translate(22 0)"><path d="M-31 49V20M-13 49V20M-31 -49V-20M44 0H50L55 -7L62 7L69 -7L76 0"/><path d="M-31 -34H-58V0H-44" stroke-dasharray="4 3"/><rect x="-44" y="-20" width="88" height="40"/><path d="M0 -20V20M-13 20V10M-19 10H-7M13 20V10M7 10H19"/>' +
    arrow(-31, 18, -31, -18) +
    arrow(13, -18, 31, 18) +
    arrow(52, 17, 73, -17) +
    '</g>',
  tank: () => {
    return '<path d="M0 -30V8M-25 -15V20H25V-15M-20 10H20"/>';
  },
  pump: () => '<circle r="26"/><path d="M0 -42V-26M0 26V42"/><path fill="#354b62" d="M-8 -7H8L0 -22Z"/>',
  motor: ({ state }) => {
    const angle = state?.kind === 'motor' ? (state.angleRad * 180) / Math.PI : 0;
    return `<circle r="30"/><path d="M-55 30H-38V0H-30M55 30H38V0H30"/><path fill="#354b62" d="M-27 -8V8L-13 0ZM27 -8V8L13 0Z"/><g data-rotor-source="${state?.kind === 'motor' ? 'kernel' : 'unavailable'}" transform="rotate(${angle})"><path d="M0 -11V11M-11 0H11"/></g>`;
  },
  'check-valve': () => {
    return '<g data-free-flow="A-B"><path d="M0 36V15M0 -15V-36M-13 5L0 15L13 5"/><circle cy="-3" r="8"/></g>';
  },
  'pilot-check': ({ component }) => pilotCheckSymbol(component.definition.id !== 'teaching:pilot-check-internal'),
  'pressure-reducing': () => pressureControlSymbol(false),
  'sequence-valve': () => pressureControlSymbol(true),
  counterbalance: () =>
    '<g data-load-control="counterbalance" data-free-flow="A-B" data-controlled-flow="B-A"><rect x="-18" y="-20" width="36" height="40"/><path d="M0 -50V-20M0 20V50M18 0H23L28 -7L35 7L42 -7L49 7L56 0M0 -35H63V-13M0 35H63V15M53 6L63 16L73 6"/><circle cx="63" cy="-4" r="7"/><path d="M0 -35H-34V-8H-18M-65 0H-44V8H-18" stroke-dasharray="4 3"/>' +
    arrow(0, -14, 0, 14) +
    arrow(28, 17, 48, -17) +
    '</g>',
  'pressure-compensated-flow': () =>
    '<g data-load-control="pressure-compensated-flow" data-compensated-flow="P-A"><path d="M0 -50V-30M0 -8V50M-12 9Q6 21 -12 33M12 9Q-6 21 12 33"/><rect x="-18" y="-30" width="36" height="22"/><path d="M18 -20H24L29 -26L35 -14L41 -26L47 -14L53 -20M0 3H-34V-19H-18M0 38H59V-12H18" stroke-dasharray="4 3"/>' +
    arrow(0, -26, 0, -12) +
    arrow(-23, 39, 23, 2) +
    '</g>',
  throttle: () => {
    return '<path d="M0 36V-36M-13 -12Q7 0 -13 12M13 -12Q-7 0 13 12"/>' + arrow(-22, 24, 22, -24);
  },
  'one-way-throttle': () => {
    return (
      '<g data-metered-flow="A-B" data-free-flow="B-A"><path d="M0 36V-36M-13 -12Q7 0 -13 12M13 -12Q-7 0 13 12M0 27H35V15M0 -27H35V-15M23 -6L35 -15L47 -6"/><circle cx="35" cy="4" r="8"/>' +
      arrow(-22, 24, 22, -24) +
      '</g>'
    );
  },
  relief: ({ component }) => {
    return (
      '<rect x="-18" y="-20" width="36" height="40"/><path d="M-18 0H-32V-28H0" stroke-dasharray="4 3"/><path d="M0 -36V-20M0 20V36M18 0H25L30 -7L37 7L44 -7L51 7L58 0"/>' +
      (component.definition.id === 'teaching:pilot-relief'
        ? '<path data-pilot-stage="true" d="M-32 -28H-58V8H-18M-58 8V34H0" stroke-dasharray="4 3"/><rect x="-69" y="-14" width="22" height="22"/>'
        : '') +
      arrow(0, -14, 0, 14) +
      arrow(31, 16, 51, -16)
    );
  },
  accumulator: () =>
    '<g data-accumulator="gas-bladder"><path d="M-25 -20A25 25 0 0 1 25 -20V20A25 25 0 0 1 -25 20ZM0 45V48"/><path data-gas-separator="true" d="M-25 0Q-12 -12 0 0T25 0"/><path d="M-8 -28L8 -12M8 -28L-8 -12"/></g>',
  volume: () => {
    return '<path d="M0 30V18M-22 18V-22H22V18ZM-16 -13H16M-16 0H16M-16 12H16"/>';
  },
  cylinder: ({ component, state }) => {
    const travel = component.parameters.geometry?.strokeM;
    const x =
      state?.kind === 'cylinder' && travel ? -60 + Math.max(0, Math.min(1, state.positionM / travel)) * 90 : -20;
    return `<rect x="-70" y="-22" width="110" height="44"/><path d="M-60 22V50M20 22V50"/><g data-piston-source="${state?.kind === 'cylinder' ? 'kernel' : 'unavailable'}" transform="translate(${x} 0)"><path data-piston="true" d="M-3 -22H3V22H-3Z"/><path data-rod="true" d="M3 -5H130V5H3Z"/></g>`;
  },
  valve: ({ component, state, center, designPosition }) => {
    const spec = directionalValveSpec(component.definition.id);
    if (spec) {
      const definition = networkDefinition(component.definition.id, component.definition.version);
      if (!definition) throw new Error('Directional drawing definition missing');
      const effective = state?.kind === 'valve' ? state.effectivePositionId : null;
      const displayed = state?.kind === 'valve' ? effective : designPosition;
      const width = networkValveCellWidth(component);
      const cellX = (i: number) => i * width - ((spec.slots.length - 1) * width) / 2;
      const selected = spec.slots.findIndex((slot) => slot === displayed);
      const shift = selected < 0 ? 0 : -cellX(selected);
      const portLines = definition.ports
        .map((port) => `<path d="M${port.anchor[0]} ${port.anchor[1]}V${port.anchor[1] > 0 ? 30 : -30}"/>`)
        .join('');
      const cells = spec.slots
        .map((slot, i) => {
          const paths = networkValvePaths(component, slot);
          const line = paths
            .map(([a, b]) => {
              const pa = definition.ports.find((p) => p.id === a),
                pb = definition.ports.find((p) => p.id === b);
              if (!pa || !pb) throw new Error('Directional symbol path has missing port');
              return `<g data-flow-path="${a}-${b}">${arrow(pa.anchor[0], pa.anchor[1] > 0 ? 26 : -26, pb.anchor[0], pb.anchor[1] > 0 ? 26 : -26)}</g>`;
            })
            .join('');
          const closed = definition.ports
            .filter((port) => !paths.some((pair) => pair.includes(port.id)))
            .map((port) => {
              const [x, y] = port.anchor,
                edge = y > 0 ? 30 : -30,
                stop = y > 0 ? 14 : -14;
              return `<path data-blocked-port="${port.id}" d="M${x} ${edge}V${stop}M${x - 6} ${stop}H${x + 6}"/>`;
            })
            .join('');
          return `<g data-position="${slot}" transform="translate(${cellX(i)} 0)"><rect data-valve-hit="${slot}" x="${-width / 2}" y="-30" width="${width}" height="60" style="fill:${effective === slot ? '#d3ece4' : 'transparent'};pointer-events:all"/>${component.definition.version === 2 ? directionalCellPaths(definition.ports, paths) : line + closed}</g>`;
        })
        .join('');
      return (
        portLines +
        `<g data-spool-bank="true" data-directional-positions="${spec.slots.length}" data-position-source="${state?.kind === 'valve' ? (effective ? 'kernel' : 'unavailable') : displayed ? 'design' : 'unavailable'}" data-displayed-position="${xml(displayed ?? '')}" transform="translate(${shift} 0)">${cells}${directionalDriveSymbols((spec.slots.length * width) / 2, component.valveActuation)}</g>`
      );
    }
    const effective = state?.kind === 'valve' ? state.effectivePositionId : null;
    const displayed = state?.kind === 'valve' ? effective : designPosition;
    const shift = displayed === 'extend' ? 60 : displayed === 'retract' ? -60 : 0;
    const activeX = effective === 'extend' ? -90 : effective === 'retract' ? 30 : -30;
    const closed =
      '<path data-center-path="blocked" d="M-16 -30V-13M-23 -13H-9M16 -30V-13M9 -13H23M-16 30V13M-23 13H-9M16 30V13M9 13H23"/>';
    const unloaded = '<path data-center-path="P-T" d="M-16 -30V-13M-23 -13H-9M16 -30V-13M9 -13H23M-16 30V7H16V30"/>';
    const forward = arrow(-16, 26, -16, -26) + arrow(16, -26, 16, 26);
    const reverse = arrow(-16, 26, 16, -26) + arrow(-16, -26, 16, 26);
    const pathFor = (slot: 'extend' | 'neutral' | 'retract') => {
      const value = networkValveFunction(component, slot);
      return value > 0 ? forward : value < 0 ? reverse : center === 'M' ? unloaded : closed;
    };
    return `<path d="M-16 -60V-30M16 -60V-30M-16 30V60M16 30V60"/><g data-spool-bank="true" transform="translate(${shift} 0)" data-position-source="${state?.kind === 'valve' ? (effective ? 'kernel' : 'unavailable') : displayed ? 'design' : 'unavailable'}" data-displayed-position="${xml(displayed ?? '')}"><rect ${effective ? `data-effective-position="${xml(effective)}"` : 'data-effective-unavailable="true"'} x="${activeX}" y="-30" width="60" height="60" style="fill:${effective ? '#d3ece4' : 'none'};stroke:none;pointer-events:none"/><rect x="-90" y="-30" width="180" height="60"/><path d="M-30 -30V30M30 -30V30"/><g data-position="extend" transform="translate(-60 0)"><rect data-valve-hit="extend" x="-30" y="-30" width="60" height="60" style="fill:transparent;stroke:none;pointer-events:all"/>${pathFor('extend')}</g><g data-position="neutral"><rect data-valve-hit="neutral" x="-30" y="-30" width="60" height="60" style="fill:transparent;stroke:none;pointer-events:all"/>${pathFor('neutral')}</g><g data-position="retract" transform="translate(60 0)"><rect data-valve-hit="retract" x="-30" y="-30" width="60" height="60" style="fill:transparent;stroke:none;pointer-events:all"/>${pathFor('retract')}</g>${directionalDriveSymbols(90, component.valveActuation)}</g>`;
  },
  'pressure-source': () => {
    return '<circle r="22"/><path d="M0 -30V-22"/><g stroke="none" fill="#354b62"><text text-anchor="middle" y="4">恒压</text></g>';
  },
});
export const networkSymbolTypes: readonly string[] = Object.freeze(Object.keys(renderers));
/** Shared canvas/export vectors. Geometry consumes instance state, never advances physics. */
export function networkSymbol(
  component: NetworkComponent,
  states: readonly NetworkState[] = [],
  controls: readonly NetworkControl[] = [],
  annotation: { readonly labels: boolean; readonly details: boolean } = { labels: true, details: true },
  rotation: NetworkRotation = 0,
  scale = 1,
  mirrored = false,
): string {
  const definition = networkDefinition(component.definition.id, component.definition.version);
  if (!definition) throw new Error('未注册的元件符号定义');
  const state = states.find((s) => s.componentId === component.id),
    control = controls.find((c) => c.componentId === component.id);
  const center =
    component.typeId === 'valve'
      ? definition.id.endsWith('valve-m') || definition.id === 'teaching:custom-m'
        ? 'M'
        : 'O'
      : null;
  let body: string;
  const renderer = renderers[component.typeId];
  if (!renderer) throw new Error('该元件尚无基础符号');
  body = renderer({
    component,
    state,
    center,
    designPosition: control?.kind === 'position' ? control.positionId : undefined,
  });
  if (definition.control === 'displacement')
    body += '<path data-variable-displacement="true" d="M-32 32L32 -32M20 -30L32 -32L30 -20"/>';
  if (component.typeId === 'adjustable-pressure-switch')
    body += '<path d="M32 -7H54" stroke-dasharray="4 2" stroke="#6550a5"/>';
  if (component.externalMotorControl)
    body +=
      component.externalMotorControl.kind === 'pressure'
        ? '<path d="M0 34V67" stroke-dasharray="4 2"/>'
        : '<path d="M0 34V67" stroke-dasharray="4 2" stroke="#6550a5"/>';
  const activePorts = definition.ports.filter((port) => networkPortActive(component, port.id));
  const ports = activePorts
    .map((p) => {
      const [x, y] = p.anchor;
      const terminal =
        p.domain === 'signal'
          ? `<path data-signal-port="true" d="M${x} ${y - 7}l7 7-7 7-7-7Z" fill="#fff" stroke="#6550a5"/>`
          : `<circle fill="#fff" cx="${x}" cy="${y}" r="5"/>`;
      return `<g data-port="${xml(p.id)}">${terminal}</g>`;
    })
    .join('');
  const portLabels = activePorts
    .map((port) => {
      const label = networkPortLabelPosition(
        component,
        { componentId: component.id, x: 0, y: 0, rotation, scale, ...(mirrored ? { mirrored: true as const } : {}) },
        port.id,
      );
      if (!label) throw new Error('Registered port label geometry missing');
      return `<text data-port-label="${xml(port.id)}" text-anchor="${label.anchor}" x="${label.x}" y="${label.y}" font-size="12" pointer-events="none" stroke="none" fill="#354b62">${xml(port.id)}</text>`;
    })
    .join('');
  const requested =
    control?.kind === 'position'
      ? positionDisplayName(control.positionId, component)
      : control?.kind === 'opening-area'
        ? `开口面积 ${control.areaM2} m²`
        : '';
  const actual =
    state?.kind === 'valve'
      ? positionDisplayName(state.effectivePositionId, component)
      : state?.kind === 'motor'
        ? `转角 ${state.angleRad.toFixed(3)} rad · 转速 ${state.angularSpeedRadPerS.toFixed(3)} rad/s`
        : state?.kind === 'cylinder'
          ? `位移 ${state.positionM.toFixed(4)} m`
          : '';
  // Missing runtime state is explained once by the canvas source/help, not as a per-symbol fault.
  const warning = state?.kind === 'valve' && !state.effectivePositionId ? '过渡中；有效阀位未知' : '';
  const bounds = networkComponentPresentationBounds(component, {
    componentId: component.id,
    x: 0,
    y: 0,
    rotation,
    scale,
    ...(mirrored ? { mirrored: true as const } : {}),
  });
  const nameY = Math.max(45, bounds ? bounds.bottom + 24 : 85),
    warningY = Math.min(-76, bounds ? bounds.top - 16 : -76);
  const geometry =
    `<rect data-body-hit="true" x="-35" y="-20" width="70" height="40" style="fill:transparent;stroke:none;pointer-events:all"/>` +
    body +
    ports;
  return `<g data-component-id="${xml(component.id)}" data-definition="${xml(definition.id)}"${center ? ` data-center="${center}"` : ''} fill="none" stroke="#354b62" stroke-width="1.8"><g data-drawing-scale="${scale}"${rotation ? ` data-drawing-rotation="${rotation}"` : ''}${mirrored ? ' data-drawing-mirrored="true"' : ''} transform="rotate(${rotation}) scale(${mirrored ? `${-scale} ${scale}` : scale})">${mirrored ? readableMirroredText(geometry) : geometry}</g>${portLabels}<text data-component-name="true" display="${annotation.labels ? 'inline' : 'none'}" stroke="none" fill="#354b62" y="${nameY}" text-anchor="middle">${xml(component.label)}</text><text data-symbol-warning="true" x="0" y="${warningY}" text-anchor="middle" stroke="none" fill="#a52d23">${xml(warning)}</text><text display="${annotation.details ? 'inline' : 'none'}" stroke="none" fill="#354b62" y="${nameY + 17}" text-anchor="middle">${xml(requested ? '请求：' + requested : '')}</text><text display="${annotation.details ? 'inline' : 'none'}" stroke="none" fill="#354b62" y="${nameY + 34}" text-anchor="middle">${xml(actual ? '内核：' + actual : '')}</text></g>`;
}
