// Decorative geometry from the approved three-plane planet prototype.
const ns = 'http://www.w3.org/2000/svg';
const scenes = new Set<{ active: boolean; draw(time: number): void }>();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let frame = 0;
const trailSegments = 24;
const trailStep = 0.03;
type Vector = readonly [number, number, number];
type Plane = {
  readonly name: string;
  readonly u: Vector;
  readonly v: Vector;
  readonly period: number;
  readonly phase: number;
};
const planes: readonly Plane[] = [
  { name: 'xy', u: [1, 0, 0], v: [0, 1, 0], period: 3.2, phase: 0 },
  { name: 'xz', u: [1, 0, 0], v: [0, 0, 1], period: 3.9, phase: 2.1 },
  { name: 'yz', u: [0, 1, 0], v: [0, 0, 1], period: 3.45, phase: 4.2 },
];
const radians = (angle: number) => (angle * Math.PI) / 180;
function camera([x, y, z]: Vector): Vector {
  const yaw = radians(-45),
    pitch = Math.atan(1 / Math.sqrt(2)),
    roll = radians(-15);
  const a = x * Math.cos(yaw) + z * Math.sin(yaw);
  const b = -x * Math.sin(yaw) + z * Math.cos(yaw);
  const c = y * Math.cos(pitch) - b * Math.sin(pitch);
  const d = y * Math.sin(pitch) + b * Math.cos(pitch);
  return [a * Math.cos(roll) - c * Math.sin(roll), a * Math.sin(roll) + c * Math.cos(roll), d];
}
function world(plane: Plane, angle: number): Vector {
  const radius = 15.5 + Math.sin(angle * 3 + plane.phase) + 0.35 * Math.cos(angle * 5 - plane.phase);
  const u = radius * Math.cos(angle),
    v = radius * 0.9 * Math.sin(angle);
  return [plane.u[0] * u + plane.v[0] * v, plane.u[1] * u + plane.v[1] * v, plane.u[2] * u + plane.v[2] * v];
}
function point(plane: Plane, time: number) {
  const angle = (time / plane.period) * Math.PI * 2 + plane.phase;
  const [x, y, z] = camera(world(plane, angle));
  const scale = 140 / (140 - z);
  return { x: x * scale, y: y * scale, z, scale };
}
function normal(plane: Plane) {
  const [a, b] = [plane.u, plane.v];
  return camera([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
}
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string | number>>,
  parent: Element,
) {
  const element = document.createElementNS(ns, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  parent.append(element);
  return element;
}
function layer(element: HTMLElement, side: 'rear' | 'front') {
  const image = svg(
    'svg',
    { class: 'planet-orbits ' + side, viewBox: '-26 -23 52 46', 'aria-hidden': 'true' },
    element,
  );
  return planes.map((plane, index) => {
    const group = svg(
      'g',
      {
        class: 'planet-orbit-track',
        style: '--satellite-color: var(--planet-' + ['a', 'b', 'c'][index] + ')',
        'data-plane': plane.name,
        'data-normal': normal(plane)
          .map((value) => value.toFixed(8))
          .join(','),
      },
      image,
    );
    const trails = Array.from({ length: trailSegments }, (_, segment) =>
      svg(
        'line',
        {
          class: 'planet-trail',
          'stroke-opacity': 0.8 * (1 - segment / trailSegments) ** 1.2,
          'stroke-width': 0.2 + 1.15 * (1 - segment / trailSegments),
        },
        group,
      ),
    );
    const head = svg('g', { class: 'planet-satellite', 'data-satellite': index }, group);
    svg(
      'circle',
      {
        r: index === 1 ? 1.25 : 1.1,
        fill: 'var(--satellite-color)',
        stroke: '#ffffff66',
        'stroke-width': '.3',
      },
      head,
    );
    return { head, trails, side };
  });
}
export function createPlanetOrbits(element: HTMLElement) {
  const rear = layer(element, 'rear'),
    front = layer(element, 'front');
  const scene = {
    active: false,
    draw(time: number) {
      for (const [index, plane] of planes.entries()) {
        const head = point(plane, time);
        for (const item of [rear[index], front[index]]) {
          if (!item) continue;
          const isFront = item.side === 'front';
          item.head.setAttribute(
            'transform',
            'translate(' + head.x.toFixed(2) + ' ' + head.y.toFixed(2) + ') scale(' + head.scale.toFixed(3) + ')',
          );
          item.head.dataset.depth = head.z.toFixed(3);
          item.head.style.opacity = String(head.z >= 0 === isFront ? 1 : 0);
          for (const [segment, line] of item.trails.entries()) {
            const a = point(plane, time - segment * trailStep),
              b = point(plane, time - (segment + 1) * trailStep);
            line.setAttribute('x1', a.x.toFixed(2));
            line.setAttribute('y1', a.y.toFixed(2));
            line.setAttribute('x2', b.x.toFixed(2));
            line.setAttribute('y2', b.y.toFixed(2));
            line.style.opacity = String(a.z + b.z >= 0 === isFront && !reduced.matches ? 1 : 0);
          }
        }
      }
    },
  };
  scenes.add(scene);
  scene.draw(reduced.matches ? 0 : performance.now() / 1000);
  return {
    setActive(value: boolean) {
      scene.active = value;
      reconcile();
    },
    dispose() {
      scenes.delete(scene);
      reconcile();
    },
  };
}
function tick(time: number) {
  frame = 0;
  for (const scene of scenes) if (scene.active) scene.draw(time / 1000);
  reconcile();
}
function reconcile() {
  const running = !document.hidden && !reduced.matches && [...scenes].some((scene) => scene.active);
  if (running && !frame) frame = requestAnimationFrame(tick);
  if (!running && frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}
reduced.addEventListener('change', () => {
  if (reduced.matches) for (const scene of scenes) if (scene.active) scene.draw(0);
  reconcile();
});
document.addEventListener('visibilitychange', reconcile);
