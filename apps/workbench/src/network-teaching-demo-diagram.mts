export const wire = (d: string, style = '') => `<path class="wire ${style}" d="${d}"/>`;
export const arrow = (d: string, style: string) =>
  `<path class="wire arrow ${style}" d="${d}" marker-end="url(#teaching-demo-${style || 'ink'}-arrow)"/>`;
export const motion = (d: string, pace = '') => `<path class="flow-motion ${pace}" d="${d}"/>`;
export const oilRoute = (d: string, kind: 'supply' | 'return', pace?: 'slow') => wire(d, kind) + motion(d, pace);
export const label = (x: number, y: number, value: string, muted = false) =>
  `<text x="${x}" y="${y}" text-anchor="middle"${muted ? ' class="muted-label"' : ''}>${value}</text>`;
export const symbol = (name: string, x: number, y: number, rotation = 0) =>
  `<use href="#teaching-demo-${name}" x="${x - 48}" y="${y - 48}" width="96" height="96" transform="rotate(${rotation} ${x} ${y})"/>`;
export const node = (x: number, y: number) => `<circle class="teaching-node" cx="${x}" cy="${y}" r="4"/>`;
