import type { NetworkDraftSession } from '@hyd/application';
import type { DisplayDiagnostic } from '@hyd/domain';
import { clampCoordinate, fitViewport, zoomAt, type Point, type Viewport } from './network-cad.mjs';
import { boardElement, element as $ } from './network-dom.mjs';

interface ViewportHooks {
  editor(): NetworkDraftSession;
  diagnostics(items: readonly DisplayDiagnostic[]): void;
  viewportChanged(): void;
}
/** Owns temporary navigation; persistence remains a view transaction of the document session. */
export function createCanvasViewport(hooks: ViewportHooks) {
  let value: Viewport = { centerX: 600, centerY: 400, zoom: 1 };
  let dimensions: Point | undefined;
  function size(): Point {
    const r = boardElement().getBoundingClientRect();
    return { x: Math.max(1, r.width), y: Math.max(1, r.height) };
  }
  function fitted(): Viewport {
    const visible = $('canvasStage').getBoundingClientRect();
    const fit = fitViewport(hooks.editor().document, { x: Math.max(1, visible.width), y: Math.max(1, visible.height) });
    const surface = boardElement().getBoundingClientRect();
    // Fit only on explicit request/load. Sidebar changes reveal or cover the
    // same surface without changing this camera or persisted engineering data.
    return {
      ...fit,
      centerX: clampCoordinate(
        fit.centerX + (surface.left + surface.width / 2 - visible.left - visible.width / 2) / fit.zoom,
      ),
      centerY: clampCoordinate(
        fit.centerY + (surface.top + surface.height / 2 - visible.top - visible.height / 2) / fit.zoom,
      ),
    };
  }
  function update(): void {
    // The canvas resize owner supplies geometry. Live pressure updates do not
    // need a synchronous layout read after every panel has written its DOM.
    dimensions ??= size();
    const box = `${value.centerX - dimensions.x / value.zoom / 2} ${value.centerY - dimensions.y / value.zoom / 2} ${dimensions.x / value.zoom} ${dimensions.y / value.zoom}`;
    if (boardElement().getAttribute('viewBox') !== box) boardElement().setAttribute('viewBox', box);
  }
  function save(): void {
    const editor = hooks.editor();
    const changed = editor.commit(
      { ...editor.document, layout: { ...editor.document.layout, viewport: { ...value } } },
      editor.revision,
      'view',
    );
    if (!changed.ok) {
      hooks.diagnostics(changed.diagnostics);
      return;
    }
    $('dirty').textContent = editor.dirty ? '未保存' : '已保存';
    hooks.viewportChanged();
  }
  return {
    get value(): Readonly<Viewport> {
      return value;
    },
    visibleCenter(): Point {
      const surface = boardElement().getBoundingClientRect(),
        visible = $('canvasStage').getBoundingClientRect();
      return {
        x: clampCoordinate(
          value.centerX + (visible.left + visible.width / 2 - surface.left - surface.width / 2) / value.zoom,
        ),
        y: clampCoordinate(
          value.centerY + (visible.top + visible.height / 2 - surface.top - surface.height / 2) / value.zoom,
        ),
      };
    },
    centerOn(point: Point): void {
      const surface = boardElement().getBoundingClientRect();
      const visible = $('canvasStage').getBoundingClientRect();
      value = {
        ...value,
        centerX: clampCoordinate(
          point.x + (surface.left + surface.width / 2 - visible.left - visible.width / 2) / value.zoom,
        ),
        centerY: clampCoordinate(
          point.y + (surface.top + surface.height / 2 - visible.top - visible.height / 2) / value.zoom,
        ),
      };
    },
    update,
    resize(width: number, height: number) {
      dimensions = { x: Math.max(1, width), y: Math.max(1, height) };
      update();
    },
    save,
    load() {
      value = hooks.editor().document.layout.viewport ?? fitted();
    },
    fit(persist = true) {
      value = fitted();
      if (persist) save();
    },
    restore(before: Viewport) {
      value = before;
    },
    pan(before: Viewport, dx: number, dy: number) {
      value = {
        ...before,
        centerX: clampCoordinate(before.centerX - dx / before.zoom),
        centerY: clampCoordinate(before.centerY - dy / before.zoom),
      };
    },
    zoom(event: WheelEvent) {
      const rect = boardElement().getBoundingClientRect();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      value = zoomAt(
        value,
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        size(),
        value.zoom * Math.exp(-Math.max(-1000, Math.min(1000, pixels)) * 0.0015),
      );
      save();
    },
  };
}
