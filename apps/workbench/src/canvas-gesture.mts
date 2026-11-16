/** Pointer movement is measured in screen CSS pixels so zoom cannot turn a click into a drag.
 * Crossing the threshold is irreversible until release, including an out-and-back gesture. */
export function layoutCoordinateDelta(before: number, after: number): number {
  const delta = after - before;
  // SVG inverse transforms may return 229.99999999999997 for an exact return
  // to 230. This bound removes representation noise only, not a screen-pixel
  // threshold or any physical/model tolerance.
  return Math.abs(delta) <= 8 * Number.EPSILON * Math.max(1, Math.abs(before), Math.abs(after)) ? 0 : delta;
}
export const canvasLongPressMs = 150;
export const canvasDragThresholdPx = 5;
export class CanvasGesture<T> {
  private press: { pointerId: number; target: T; x: number; y: number; dragged: boolean } | null = null;
  constructor(private readonly thresholdPx = canvasDragThresholdPx) {}
  get active(): boolean {
    return this.press !== null;
  }
  begin(pointerId: number, target: T, x: number, y: number): boolean {
    if (this.press) return false;
    this.press = { pointerId, target, x, y, dragged: false };
    return true;
  }
  move(pointerId: number, x: number, y: number): boolean {
    const p = this.press;
    if (!p || p.pointerId !== pointerId) return false;
    p.dragged ||= Math.hypot(x - p.x, y - p.y) >= this.thresholdPx;
    return p.dragged;
  }
  finish(pointerId: number, x: number, y: number): { target: T; dragged: boolean } | null {
    const p = this.press;
    if (!p || p.pointerId !== pointerId) return null;
    this.move(pointerId, x, y);
    this.press = null;
    return { target: p.target, dragged: p.dragged };
  }
  cancel(): void {
    this.press = null;
  }
}
