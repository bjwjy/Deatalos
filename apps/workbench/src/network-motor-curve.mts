import {
  compileMotorDisplacementCurve,
  defaultMotorDisplacementCurve,
  motorCurvePointLimit,
  motorCurvePressureGapPa,
  motorCurvePressureMaxPa,
  motorCurveReachMax,
  motorCurveReachMin,
  motorCurveSlopeLimit,
  sampleMotorDisplacementCurve,
  type MotorCurvePoint,
  type MotorCurveTangent,
  type MotorDisplacementCurve,
} from '@hyd/domain';

const left = 54,
  right = 614,
  top = 25,
  bottom = 217;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));
const digits = (n: number) => Number(n.toPrecision(10)).toString();
type Side = 'left' | 'right';
type Location = { readonly x: number; readonly y: number };

export function bindNetworkMotorCurve(
  root: HTMLElement,
  original: MotorDisplacementCurve | undefined,
  range: { readonly min: number; readonly max: number },
  defaults: MotorDisplacementCurve = defaultMotorDisplacementCurve(range),
  external = false,
) {
  root.insertAdjacentHTML(
    'beforeend',
    `
    <label ${external ? 'hidden' : ''}><span>启用曲线给定</span><input type="checkbox" data-motor-curve-enabled></label>
    <label><span>曲线${external ? '压力' : '压差'}上限 <small>MPa</small></span><input type="number" step="any" max="70" data-motor-curve-limit></label>
    <svg class="motor-curve-plot" viewBox="0 0 640 259" role="group" aria-label="马达压差—排量曲线">
      <g data-curve-axes aria-hidden="true"></g>
      <a href="#" role="button" data-curve-target aria-label="选择曲线上的调整点">
        <path class="motor-curve-line"></path><path class="motor-curve-hit"></path>
      </a>
      <g data-curve-direction="left" hidden><line></line><a href="#" role="button" data-curve-grip="left" aria-label="左侧方向手柄">
        <circle r="13"></circle><rect x="-4" y="-4" width="8" height="8"></rect>
      </a></g>
      <g data-curve-direction="right" hidden><line></line><a href="#" role="button" data-curve-grip="right" aria-label="右侧方向手柄">
        <circle r="13"></circle><rect x="-4" y="-4" width="8" height="8"></rect>
      </a></g>
      <a href="#" role="button" data-curve-point hidden><circle r="14"></circle><circle class="motor-curve-anchor" r="5"></circle></a>
    </svg>
    <p class="muted" data-curve-reading hidden></p>
    <div data-curve-exact hidden>
      <label><span>点的${external ? '压力' : '压差'} <small>MPa</small></span><input type="number" step="any" data-curve-exact-pressure></label>
      <label><span>点的排量 <small>cm³/rev</small></span><input type="number" step="any" data-curve-exact-displacement></label>
      <button type="button" data-curve-exact-apply>确认点数值</button>
      <button type="button" data-curve-exact-cancel>取消点编辑</button>
    </div>
    <p class="muted">单击曲线选点，拖圆点或方形手柄调整，双击圆点填写数值。${external ? 'X 取压和 U 等效压力使用同一条曲线。' : '启用后按 |A−B| 压差给定。'}超出曲线范围时保持端点排量。</p>`,
  );
  const plot = root.querySelector('svg');
  const axes = root.querySelector('[data-curve-axes]');
  const line = root.querySelector('.motor-curve-line');
  const hit = root.querySelector('.motor-curve-hit');
  const enabled = root.querySelector<HTMLInputElement>('[data-motor-curve-enabled]');
  const limit = root.querySelector<HTMLInputElement>('[data-motor-curve-limit]');
  const marker = root.querySelector<SVGAElement>('[data-curve-point]');
  const target = root.querySelector<SVGAElement>('[data-curve-target]');
  const reading = root.querySelector<HTMLElement>('[data-curve-reading]');
  const exact = root.querySelector<HTMLElement>('[data-curve-exact]');
  const exactPressure = root.querySelector<HTMLInputElement>('[data-curve-exact-pressure]');
  const exactDisplacement = root.querySelector<HTMLInputElement>('[data-curve-exact-displacement]');
  if (
    !plot ||
    !axes ||
    !line ||
    !hit ||
    !enabled ||
    !limit ||
    !marker ||
    !target ||
    !reading ||
    !exact ||
    !exactPressure ||
    !exactDisplacement
  )
    throw new Error('Motor curve editor markup incomplete');
  const grips = {
    left: root.querySelector<SVGAElement>('[data-curve-grip="left"]'),
    right: root.querySelector<SVGAElement>('[data-curve-grip="right"]'),
  };
  let curve = original ?? defaults;
  let compiled = compileMotorDisplacementCurve(curve, range);
  let selected: { readonly index: number; readonly pending?: MotorCurvePoint } | null = null;
  let dirty = false;
  let suppressClick = false;
  let drag: {
    readonly id: number;
    readonly start: Location;
    readonly kind: 'point' | Side;
    readonly origin: Location;
    readonly initialReach?: number;
    moved: boolean;
  } | null = null;
  const x = (pressure: number) => left + ((right - left) * pressure) / curve.pressureLimitPa;
  const y = (displacement: number) => bottom - ((bottom - top) * (displacement - range.min)) / (range.max - range.min);
  const pressureAt = (px: number) => (curve.pressureLimitPa * (px - left)) / (right - left);
  const displacementAt = (py: number) => range.min + ((range.max - range.min) * (bottom - py)) / (bottom - top);
  function coordinates(event: MouseEvent): Location | undefined {
    const matrix = plot?.getScreenCTM();
    return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : undefined;
  }
  const pointAt = () => (selected ? (selected.pending ?? curve.points[selected.index]) : undefined);
  const tangentAt = () => (selected ? (selected.pending?.tangent ?? compiled.tangents[selected.index]) : undefined);
  function bounds() {
    if (!selected) return undefined;
    const previous = curve.points[selected.index - 1];
    const next = curve.points[selected.index + (selected.pending ? 0 : 1)];
    return {
      lo: previous ? previous.pressurePa + motorCurvePressureGapPa : 0,
      hi: next ? next.pressurePa - motorCurvePressureGapPa : curve.pressureLimitPa,
    };
  }
  function gripPosition(point: MotorCurvePoint, tangent: MotorCurveTangent, side: Side): Location {
    const px = x(point.pressurePa),
      py = y(point.displacementM3PerRev);
    const sign = side === 'right' ? 1 : -1;
    const direction =
      (-tangent.slopeM3PerRevPa * curve.pressureLimitPa * (bottom - top)) / ((range.max - range.min) * (right - left));
    const norm = Math.hypot(1, direction);
    const ux = sign / norm,
      uy = (sign * direction) / norm;
    const horizontalRoom = ux > 0 ? 630 - px : px - 10;
    const verticalRoom = uy > 0 ? 237 - py : py - 7;
    const reach = side === 'left' ? tangent.leftReach : tangent.rightReach;
    const length = Math.min(150 * reach, horizontalRoom / Math.abs(ux), verticalRoom / Math.abs(uy));
    return { x: px + length * ux, y: py + length * uy };
  }
  function paintSelection() {
    const point = pointAt(),
      tangent = tangentAt();
    marker?.toggleAttribute('hidden', !point);
    reading?.toggleAttribute('hidden', !point);
    if (point) {
      marker?.setAttribute('transform', `translate(${x(point.pressurePa)} ${y(point.displacementM3PerRev)})`);
      const value = `${digits(point.pressurePa / 1e6)} MPa · ${digits(point.displacementM3PerRev * 1e6)} cm³/rev`;
      marker?.setAttribute('aria-label', '调整点 ' + value);
      if (reading) reading.textContent = value;
    }
    for (const side of ['left', 'right'] satisfies Side[]) {
      const grip = grips[side],
        group = grip?.parentElement;
      const boundary = side === 'left' ? 0 : curve.pressureLimitPa;
      const hidden = !point || !tangent || point.pressurePa === boundary;
      group?.toggleAttribute('hidden', hidden);
      if (hidden || !point || !tangent) continue;
      const tip = gripPosition(point, tangent, side);
      grip?.setAttribute('transform', `translate(${tip.x} ${tip.y})`);
      const guide = group?.querySelector('line');
      guide?.setAttribute('x1', String(x(point.pressurePa)));
      guide?.setAttribute('y1', String(y(point.displacementM3PerRev)));
      guide?.setAttribute('x2', String(tip.x));
      guide?.setAttribute('y2', String(tip.y));
    }
  }
  function paint() {
    compiled = compileMotorDisplacementCurve(curve, range);
    const first = compiled.segments[0];
    const path = first
      ? `M ${left} ${y(first.displacement[0])} H ${x(first.pressure[0])} ` +
        compiled.segments
          .map(
            ({ pressure, displacement }) =>
              `C ${x(pressure[1])} ${y(displacement[1])} ${x(pressure[2])} ${y(displacement[2])} ${x(pressure[3])} ${y(displacement[3])}`,
          )
          .join(' ') +
        ` H ${right}`
      : '';
    line?.setAttribute('d', path);
    hit?.setAttribute('d', path);
    paintSelection();
  }
  function paintAxes() {
    if (!axes) return;
    let labels = `<text x="4" y="14">排量 / cm³/rev</text><text x="334" y="254" text-anchor="middle">${external ? '控制压力' : '|A−B| 压差'} / MPa</text>`;
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const py = bottom - (bottom - top) * fraction;
      const px = left + (right - left) * fraction;
      labels += `<line x1="${left}" x2="${right}" y1="${py}" y2="${py}"></line><text x="48" y="${py + 4}" text-anchor="end">${Number(((range.min + (range.max - range.min) * fraction) * 1e6).toPrecision(4))}</text><text x="${px}" y="236" text-anchor="middle">${digits((curve.pressureLimitPa * fraction) / 1e6)}</text>`;
    }
    axes.innerHTML = labels;
  }
  function closePoint() {
    if (exact) exact.hidden = true;
    selected = null;
    paintSelection();
  }
  function setPoint(point: MotorCurvePoint) {
    if (!selected) return;
    const { index, pending } = selected;
    const after = index + (pending ? 0 : 1);
    curve = { ...curve, points: [...curve.points.slice(0, index), point, ...curve.points.slice(after)] };
    selected = { index };
    dirty = true;
    if (limit) limit.min = String((curve.points.at(-1)?.pressurePa ?? motorCurvePressureGapPa) / 1e6);
    paint();
  }
  function movePoint(location: Location) {
    const point = pointAt(),
      bound = bounds();
    if (!point || !bound) return;
    const pressurePa = clamp(Math.round(pressureAt(location.x) / 100) * 100, bound.lo, bound.hi);
    const displacementM3PerRev = clamp(displacementAt(location.y), range.min, range.max);
    setPosition(pressurePa, displacementM3PerRev);
  }
  function setPosition(pressurePa: number, displacementM3PerRev: number) {
    const tangent = selected?.pending ? undefined : pointAt()?.tangent;
    setPoint({ pressurePa, displacementM3PerRev, ...(tangent ? { tangent } : {}) });
  }
  function moveGrip(side: Side, location: Location, origin: Location, initialReach: number) {
    const point = pointAt(),
      tangent = tangentAt();
    if (!point || !tangent) return;
    const px = x(point.pressurePa),
      py = y(point.displacementM3PerRev);
    const dx = location.x - px,
      dy = location.y - py;
    const sign = side === 'left' ? -1 : 1;
    const lengthChange = Math.hypot(dx, dy) - Math.hypot(origin.x - px, origin.y - py);
    const reach = clamp(initialReach + lengthChange / 150, motorCurveReachMin, motorCurveReachMax);
    const slope =
      (displacementAt(location.y) - point.displacementM3PerRev) /
      ((sign * Math.max(2, sign * dx) * curve.pressureLimitPa) / (right - left));
    setPoint({
      ...point,
      tangent: {
        ...tangent,
        slopeM3PerRevPa: clamp(slope, -motorCurveSlopeLimit, motorCurveSlopeLimit),
        ...(side === 'left' ? { leftReach: reach } : { rightReach: reach }),
      },
    });
  }
  function showExact() {
    const point = pointAt(),
      bound = bounds();
    if (!point || !bound || !exact || !exactPressure || !exactDisplacement) return;
    exactPressure.min = String(bound.lo / 1e6);
    exactPressure.max = String(bound.hi / 1e6);
    exactPressure.value = String(point.pressurePa / 1e6);
    exactDisplacement.min = String(range.min * 1e6);
    exactDisplacement.max = String(range.max * 1e6);
    exactDisplacement.value = String(point.displacementM3PerRev * 1e6);
    exact.hidden = false;
    exactPressure.focus();
    exactPressure.select();
  }
  function acceptExact(): boolean {
    const point = pointAt(),
      bound = bounds();
    if (!point || !bound || !exactPressure || !exactDisplacement || !exact) return false;
    if (!exactPressure.reportValidity() || !exactDisplacement.reportValidity()) return false;
    const p = exactPressure.valueAsNumber,
      d = exactDisplacement.valueAsNumber;
    if (!Number.isFinite(p) || !Number.isFinite(d)) return false;
    if (p !== point.pressurePa / 1e6 || d !== point.displacementM3PerRev * 1e6)
      setPosition(clamp(p * 1e6, bound.lo, bound.hi), clamp(d / 1e6, range.min, range.max));
    exact.hidden = true;
    marker?.focus();
    return true;
  }
  function removePoint() {
    if (!selected) return;
    if (!selected.pending && curve.points.length > 2) {
      curve = { ...curve, points: curve.points.filter((_, i) => i !== selected?.index) };
      if (limit) limit.min = String((curve.points.at(-1)?.pressurePa ?? motorCurvePressureGapPa) / 1e6);
      dirty = true;
      paint();
    }
    closePoint();
    target?.focus();
  }
  enabled.addEventListener('change', () => {
    curve = { ...curve, enabled: enabled.checked };
    dirty = true;
  });
  function acceptLimit(): boolean {
    if (!limit?.reportValidity()) return false;
    const pressureLimitPa = Math.min(motorCurvePressureMaxPa, limit.valueAsNumber * 1e6);
    if (!Number.isFinite(pressureLimitPa)) return false;
    if (pressureLimitPa !== curve.pressureLimitPa) {
      curve = { ...curve, pressureLimitPa };
      dirty = true;
      closePoint();
      paintAxes();
      paint();
    }
    return true;
  }
  limit.required = true;
  exactPressure.required = true;
  exactDisplacement.required = true;
  limit.addEventListener('change', acceptLimit);
  root.querySelector('[data-curve-exact-apply]')?.addEventListener('click', acceptExact);
  root.querySelector('[data-curve-exact-cancel]')?.addEventListener('click', () => {
    exact.hidden = true;
    marker.focus();
  });
  exact.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Enter') acceptExact();
    else {
      exact.hidden = true;
      marker.focus();
    }
  });
  target.addEventListener('click', (event) => {
    event.preventDefault();
    if (suppressClick && event.detail) return;
    const at = coordinates(event);
    const pressurePa =
      event.detail && at
        ? clamp(Math.round(pressureAt(at.x) / 100) * 100, 0, curve.pressureLimitPa)
        : (pointAt() ?? curve.points[0])?.pressurePa;
    if (pressurePa === undefined) return;
    const sample = sampleMotorDisplacementCurve(compiled.segments, pressurePa);
    if (!sample) return;
    let index = 0,
      closest = Infinity;
    for (const [i, point] of curve.points.entries()) {
      const distance = Math.abs(point.pressurePa - pressurePa);
      if (distance < closest) {
        closest = distance;
        index = i;
      }
    }
    const knot = curve.points[index];
    if (!knot) return;
    const nearby =
      Math.hypot(x(knot.pressurePa) - x(pressurePa), y(knot.displacementM3PerRev) - y(sample.displacementM3PerRev)) <
      11;
    exact.hidden = true;
    if (nearby || closest < motorCurvePressureGapPa || curve.points.length >= motorCurvePointLimit)
      selected = { index };
    else {
      const after = curve.points.findIndex((point) => point.pressurePa > pressurePa);
      selected = {
        index: after < 0 ? curve.points.length : after,
        pending: {
          pressurePa,
          displacementM3PerRev: clamp(sample.displacementM3PerRev, range.min, range.max),
          tangent: { slopeM3PerRevPa: sample.slopeM3PerRevPa, leftReach: 1 / 3, rightReach: 1 / 3 },
        },
      };
    }
    paintSelection();
    marker.focus();
  });
  marker.addEventListener('click', (event) => {
    event.preventDefault();
    if (!event.detail) showExact();
  });
  marker.addEventListener('dblclick', (event) => {
    event.preventDefault();
    if (!suppressClick) showExact();
  });
  marker.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    removePoint();
  });
  plot.addEventListener('click', (event) => {
    if (!suppressClick && event.target instanceof Element && !event.target.closest('a')) closePoint();
  });
  plot.addEventListener('pointerdown', (event) => {
    suppressClick = false;
    if (!event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return;
    const control = event.target.closest('[data-curve-point], [data-curve-grip]');
    const point = pointAt(),
      start = coordinates(event),
      tangent = tangentAt();
    if (!control || !point || !start || !tangent) return;
    const side = control.getAttribute('data-curve-grip');
    if (side === 'left' || side === 'right') {
      const initialReach = side === 'left' ? tangent.leftReach : tangent.rightReach;
      drag = {
        id: event.pointerId,
        start,
        kind: side,
        origin: gripPosition(point, tangent, side),
        initialReach,
        moved: false,
      };
    } else
      drag = {
        id: event.pointerId,
        start,
        kind: 'point',
        origin: { x: x(point.pressurePa), y: y(point.displacementM3PerRev) },
        moved: false,
      };
    control.setPointerCapture(event.pointerId);
  });
  plot.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    const position = coordinates(event);
    if (!position) return;
    const dx = position.x - drag.start.x,
      dy = position.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    exact.hidden = true;
    const next = { x: drag.origin.x + dx, y: drag.origin.y + dy };
    if (drag.kind === 'point') movePoint(next);
    else if (drag.initialReach !== undefined) moveGrip(drag.kind, next, drag.origin, drag.initialReach);
  });
  function endDrag(event: PointerEvent) {
    if (drag?.id !== event.pointerId) return;
    suppressClick = drag.moved;
    drag = null;
  }
  plot.addEventListener('pointerup', endDrag);
  plot.addEventListener('pointercancel', endDrag);
  plot.addEventListener('lostpointercapture', endDrag);
  plot.addEventListener('keydown', (event) => {
    if (!selected) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closePoint();
      target.focus();
      return;
    }
    if (event.key === 'Delete' && event.target === marker) {
      event.preventDefault();
      removePoint();
      return;
    }
    const delta = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] }[event.key];
    const point = pointAt(),
      tangent = tangentAt();
    if (!delta || !point || !tangent) return;
    const [dx = 0, dy = 0] = delta;
    if (event.target === marker) movePoint({ x: x(point.pressurePa) + dx, y: y(point.displacementM3PerRev) + dy });
    else {
      const side = event.target === grips.left ? 'left' : event.target === grips.right ? 'right' : undefined;
      if (!side) return;
      const origin = gripPosition(point, tangent, side);
      moveGrip(
        side,
        { x: origin.x + dx, y: origin.y + dy },
        origin,
        side === 'left' ? tangent.leftReach : tangent.rightReach,
      );
    }
    event.preventDefault();
  });
  for (const grip of Object.values(grips)) grip?.addEventListener('click', (event) => event.preventDefault());
  function reset(curveValue: MotorDisplacementCurve, changed: boolean) {
    curve = curveValue;
    dirty = changed;
    compiled = compileMotorDisplacementCurve(curve, range);
    if (enabled && limit) {
      enabled.checked = curve.enabled;
      limit.min = String(Math.max(motorCurvePressureGapPa, curve.points.at(-1)?.pressurePa ?? 0) / 1e6);
      limit.value = String(curve.pressureLimitPa / 1e6);
    }
    closePoint();
    paintAxes();
    paint();
  }
  reset(original ?? defaults, false);
  return {
    restoreDefaults: () => reset({ ...defaults, enabled: external ? false : curve.enabled }, true),
    value(): { readonly ok: false } | { readonly ok: true; readonly curve: MotorDisplacementCurve | undefined } {
      if (exact && !exact.hidden && !acceptExact()) return { ok: false };
      if (!acceptLimit()) return { ok: false };
      return { ok: true, curve: dirty ? curve : original };
    },
  };
}
