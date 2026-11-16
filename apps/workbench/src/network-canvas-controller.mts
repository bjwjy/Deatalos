import { createCanvasRenderer, type CanvasRenderView } from './network-canvas-renderer.mjs';
import { createCanvasViewport } from './network-canvas-viewport.mjs';
import { createCanvasTargets, type BoardTarget } from './network-canvas-targets.mjs';
import { setupCanvasKeyboard } from './network-canvas-keyboard.mjs';
import { componentEditor } from './network-component-editing.mjs';
import {
  planNetworkRouteSimplification,
  planNetworkDeleteSelection,
  planNetworkBranchConnection,
  planNetworkFlowMeterInsertion,
  type NetworkConnectionAnchor,
  type NetworkRouteAnchor,
  type NetworkExportCapture,
} from '@hyd/application';
import {
  networkEndpointPort,
  isExternalMotorPressureTap,
  type NetworkProject,
  type NetworkSnapshot,
  type NetworkEndpoint,
  type NetworkConnection,
} from '@hyd/domain';

import { type DisplayDiagnostic } from '@hyd/domain';

import { type PressureBands } from './network-pressure.mjs';
import { CanvasGesture, layoutCoordinateDelta, canvasLongPressMs } from './canvas-gesture.mjs';
import {
  clampCoordinate,
  endpointPosition,
  manualRoute,
  marqueeSelection,
  segmentRoute,
  moveSelection,
  resolveRoute,
  selectionKey,
  type Point,
  type Selection,
  type Viewport,
} from './network-cad.mjs';
import { element as $, boardElement } from './network-dom.mjs';
import type { NetworkDraftSession } from '@hyd/application';
import { createCanvasBranchPoints } from './network-canvas-branch.mjs';
import type { DiagnosticTarget } from './network-diagnostic-batches.mjs';
interface CanvasHooks {
  overlay?(project: NetworkProject): string;
  editor(): NetworkDraftSession;
  capture(): NetworkExportCapture | null;
  pressureBands(): PressureBands;
  connectionRadius(): number;
  branchRevealRadius(): number;
  labels(): CanvasRenderView['labels'];
  viewportChanged(): void;
  point(): NetworkSnapshot | null;
  failed(): boolean;
  uid(prefix: string): string;
  fileBusy(): boolean;
  mutate(candidate: unknown, physical?: boolean): boolean;
  render(): void;
  sendControl(changes: unknown[]): Promise<void>;
  save(saveAs?: boolean): Promise<boolean>;
  undoRedo(back: boolean): void;
  toast(message: string): void;
  diagnostics(items: readonly DisplayDiagnostic[]): void;
  cancelPipeEdit(): void;
  propertiesChanged(): void;
  editComponent(id: string): void;
  editText(id: string): void;
  runtimeReady(): boolean;
  running(): boolean;
}
type PendingPipe = { id: string; from: NetworkEndpoint; to: NetworkEndpoint; sessionId: string; revision: number };
type Drag = { start: Point; dx: number; dy: number } & (
  | { kind: 'objects'; selection: Selection[] }
  | { kind: 'pan'; viewport: Viewport }
  | { kind: 'marquee'; additive: boolean }
  | { kind: 'path'; id: string; points: readonly Point[]; index: number; part: 'bend' | 'segment' }
);
export function createNetworkCanvas(hooks: CanvasHooks) {
  let connectionKind: 'pipe' | 'ideal' = 'ideal',
    pendingPipe: PendingPipe | null = null,
    firstEndpoint: NetworkConnectionAnchor | null = null,
    connectArmed = false;
  let connectionOwner: { editor: NetworkDraftSession; revision: number } | null = null;
  let linkCursor: Point | null = null,
    hoveredEndpoint: NetworkConnectionAnchor | null = null;
  let cancelPointer: (() => void) | null = null;
  let selected: Selection | null = null,
    selections: Selection[] = [];
  let diagnosticPort: Extract<NetworkEndpoint, { kind: 'port' }> | null = null;
  let activeBend: number | null = null;
  let drag: Drag | null = null,
    pathPreview: NetworkProject['layout']['routes'][number] | null = null;
  const gesture = new CanvasGesture<BoardTarget>();
  const view = createCanvasViewport(hooks);
  const renderer = createCanvasRenderer();
  const deriveBranchPoints = createCanvasBranchPoints(renderer.route);
  let branchPoints: readonly NetworkRouteAnchor[] = [];
  const anchorPosition = (anchor: NetworkConnectionAnchor) =>
    anchor.kind === 'route' ? anchor.point : endpointPosition(hooks.editor().document, anchor);
  let readoutConnection: string | null = null;
  let readoutPinned = false;
  function isSelected(kind: Selection['kind'], id: string): boolean {
    return selections.some((s) => s.kind === kind && s.id === id) || (selected?.kind === kind && selected.id === id);
  }
  function select(items: Selection[]): void {
    diagnosticPort = null;
    if (pendingPipe && !items.some((item) => item.kind === 'connection' && item.id === pendingPipe!.id)) {
      pendingPipe = null;
      $('connectHint').textContent = '待确认物理管已取消，未修改工程。';
    }
    if (!items.some((item) => item.kind === 'connection' && item.id === readoutConnection)) readoutConnection = null;
    selections = items;
    selected = items.at(-1) ?? null;
    activeBend = null;
  }
  function loadViewport(): void {
    view.load();
    select([]);
    connectArmed = false;
  }
  function fitAll(): void {
    view.fit();
    draw();
  }
  function currentRoute(id: string): Point[] {
    const e = hooks.editor().document.design.connections.find((e) => e.id === id);
    const a = e && endpointPosition(hooks.editor().document, e.from),
      b = e && endpointPosition(hooks.editor().document, e.to);
    const routed = renderer.route(hooks.editor().document, id);
    return routed.ok
      ? [...routed.value]
      : a && b
        ? resolveRoute(
            a,
            b,
            hooks.editor().document.layout.routes.find((r) => r.connectionId === id),
          )
        : [];
  }
  function locateDiagnostic(target: DiagnosticTarget): boolean {
    if (gesture.active || pendingPipe || firstEndpoint || connectArmed) return false;
    const project = hooks.editor().document;
    const point =
      target.kind === 'port'
        ? endpointPosition(project, target)
        : target.kind === 'component'
          ? project.layout.components.find((item) => item.componentId === target.id)
          : target.kind === 'node'
            ? endpointPosition(project, { kind: 'node', nodeId: target.id })
            : currentRoute(target.id).at(0);
    if (!point) return false;
    select([target.kind === 'port' ? { kind: 'component', id: target.componentId } : target]);
    diagnosticPort = target.kind === 'port' ? target : null;
    view.centerOn(point);
    hooks.render();
    return true;
  }
  function setRoute(route: NetworkProject['layout']['routes'][number]): void {
    activeBend = null;
    let candidate: NetworkProject = {
      ...hooks.editor().document,
      layout: {
        ...hooks.editor().document.layout,
        routes: hooks.editor().document.layout.routes.map((r) => (r.connectionId === route.connectionId ? route : r)),
      },
    };
    if (route.mode === 'manual') {
      const plan = planNetworkRouteSimplification(candidate, [route.connectionId]);
      if (!plan.ok) {
        hooks.diagnostics(plan.diagnostics);
        return;
      }
      candidate = plan.value.document;
    }
    if (hooks.mutate(candidate, false)) {
      hooks.toast('绘图路径已保存；实际管长、损失和运行保持。');
    }
  }
  function draw(): void {
    if (
      firstEndpoint &&
      connectionOwner &&
      (connectionOwner.editor !== hooks.editor() || connectionOwner.revision !== hooks.editor().revision)
    ) {
      firstEndpoint = null;
      connectionOwner = null;
      linkCursor = null;
      hoveredEndpoint = null;
    }
    view.update();
    const document = hooks.editor().document;
    const drawing =
      drag?.kind === 'objects' ? moveSelection(document, drag.selection, { x: drag.dx, y: drag.dy }) : document;
    const physicalTap =
      firstEndpoint !== null && firstEndpoint.kind !== 'route' && isExternalMotorPressureTap(document, firstEndpoint);
    branchPoints =
      (connectionKind === 'ideal' || physicalTap) && !drag
        ? deriveBranchPoints(
            document,
            view.value.zoom,
            selected?.kind === 'connection' ? selected.id : null,
            linkCursor,
            firstEndpoint !== null,
            physicalTap,
            hooks.branchRevealRadius(),
          )
        : [];
    renderer.render({
      document,
      drawing,
      viewport: view.value,
      selected,
      selections,
      activeBend,
      firstEndpoint,
      hoveredEndpoint,
      diagnosticPort,
      linkCursor,
      connectArmed,
      connectionRadius: hooks.connectionRadius(),
      labels: hooks.labels(),
      pendingPipe,
      pathPreview,
      marqueeDrag: drag?.kind === 'marquee' ? drag : null,
      point: hooks.point(),
      bands: hooks.pressureBands(),
      failed: hooks.failed(),
      running: hooks.running(),
      runtimeReady: hooks.runtimeReady(),
      captureSelection: hooks.capture()?.selection,
      overlay: hooks.overlay?.(drawing) ?? '',
      readoutPinned,
      readoutConnection,
      branchPoints,
    });
  }
  function chooseEndpoint(endpoint: NetworkConnectionAnchor) {
    const project = hooks.editor().document;
    const physicalTap =
      firstEndpoint !== null &&
      firstEndpoint.kind !== 'route' &&
      isExternalMotorPressureTap(project, firstEndpoint) &&
      endpoint.kind === 'route' &&
      project.design.connections.some((e) => e.id === endpoint.connectionId && e.kind === 'pipe');
    if (connectionKind === 'pipe' && !physicalTap && (endpoint.kind === 'route' || firstEndpoint?.kind === 'route')) {
      hooks.toast('当前管线内部接点仅支持变量马达 X 口取压。');
      return;
    }
    if (!firstEndpoint) {
      firstEndpoint = endpoint;
      connectionOwner = { editor: hooks.editor(), revision: hooks.editor().revision };
      $('connectHint').textContent = '已选起点；选择第二个端点完成连接';
      draw();
      return;
    }
    if (JSON.stringify(firstEndpoint) === JSON.stringify(endpoint)) return;
    const from = firstEndpoint;
    const sourcePort = from.kind === 'route' ? undefined : networkEndpointPort(project, from);
    const targetPort = endpoint.kind === 'route' ? undefined : networkEndpointPort(project, endpoint);
    const signal = sourcePort?.domain === 'signal' || targetPort?.domain === 'signal';
    if (
      signal &&
      (sourcePort?.domain !== 'signal' ||
        targetPort?.domain !== 'signal' ||
        sourcePort.direction === targetPort.direction)
    ) {
      hooks.toast('电压信号线须连接 OUT 与 U。');
      return;
    }
    const id = hooks.uid('edge');
    if (from.kind === 'route' || endpoint.kind === 'route') {
      const planned = planNetworkBranchConnection(hooks.editor().document, {
        from,
        to: endpoint,
        idPrefix: hooks.uid('branch'),
      });
      if (!planned.ok) {
        hooks.diagnostics(planned.diagnostics);
        hooks.toast(planned.diagnostics.map((d) => d.message).join('；'));
        return;
      }
      firstEndpoint = null;
      connectionOwner = null;
      linkCursor = null;
      hoveredEndpoint = null;
      connectArmed = false;
      if (hooks.mutate({ ...planned.value.document, updatedAt: new Date().toISOString() })) {
        select([{ kind: 'connection', id: planned.value.connectionId }]);
        const notice =
          planned.value.routing === 'basic'
            ? '分支已连接；局部整理未完成，已保留基础走线，可稍后调线。'
            : planned.value.orientationChanges.length
              ? '分支已连接并局部整理，相关元件方向已优化；一次撤销可恢复。'
              : '分支已连接并局部整理；一次撤销可恢复原线。';
        $('connectHint').textContent = notice;
        if (planned.value.routing === 'basic') hooks.toast(notice);
      }
      hooks.render();
      return;
    }
    firstEndpoint = null;
    connectionOwner = null;
    linkCursor = null;
    hoveredEndpoint = null;
    connectArmed = false;
    if (connectionKind === 'pipe' && !signal) {
      pendingPipe = {
        id,
        from,
        to: endpoint,
        sessionId: hooks.editor().documentSessionId,
        revision: hooks.editor().physicsRevision,
      };
      select([{ kind: 'connection', id }]);
      hooks.propertiesChanged();
      $('connectHint').textContent = '物理管待确认，请填写参数。';
      hooks.render();
      // Pipe editing owns this entry; the component-only menu is disabled for a connection selection.
      const dialog = $('propertiesDialog');
      if (!(dialog instanceof HTMLDialogElement)) throw new Error('Properties must be a dialog');
      if (!dialog.open) dialog.showModal();
      return;
    }
    const edge: NetworkConnection = signal
      ? sourcePort?.domain === 'signal' && sourcePort.direction === 'output'
        ? { id, kind: 'signal', from, to: endpoint }
        : { id, kind: 'signal', from: endpoint, to: from }
      : { id, kind: 'ideal', from, to: endpoint };
    const candidate = {
      ...hooks.editor().document,
      updatedAt: new Date().toISOString(),
      design: { ...hooks.editor().document.design, connections: [...hooks.editor().document.design.connections, edge] },
      layout: {
        ...hooks.editor().document.layout,
        routes: [...hooks.editor().document.layout.routes, { connectionId: edge.id, mode: 'auto' }],
      },
    };
    const created = hooks.mutate(candidate);
    $('connectHint').textContent = created
      ? signal
        ? '电压信号线已连接。'
        : '理想连接已建立，忽略管损。'
      : '连接未建立，请检查端点或诊断。';
    draw();
  }
  function removeSelected() {
    const items = selections.length ? selections : selected ? [selected] : [];
    if (!items.length || gesture.active || firstEndpoint || hooks.fileBusy()) return;
    const planned = planNetworkDeleteSelection(hooks.editor().document, items);
    if (!planned.ok) {
      hooks.diagnostics(planned.diagnostics);
      hooks.toast(planned.diagnostics.map((item) => item.message).join('；'));
      return;
    }
    if (
      hooks.mutate(
        planned.value,
        items.some((item) => item.kind !== 'probe' && item.kind !== 'text'),
      )
    ) {
      select([]);
      hooks.render();
    }
  }
  function setupDrag() {
    const board = boardElement();
    const position = (event: MouseEvent) =>
      new DOMPoint(event.clientX, event.clientY).matrixTransform(board.getScreenCTM()!.inverse());
    const { targetOf, targetAt, snapAt } = createCanvasTargets({
      editor: hooks.editor,
      connectionActive: () => firstEndpoint !== null || connectArmed,
      connectionRadius: hooks.connectionRadius,
      branchPoints: () => branchPoints,
    });
    let captured: number | null = null;
    let pressOwner: NetworkDraftSession | null = null,
      pressRevision = -1;
    let portPress: {
      endpoint: NetworkConnectionAnchor;
      x: number;
      y: number;
      direct: boolean;
      active: boolean;
    } | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    const clearHold = () => {
      clearTimeout(holdTimer);
      holdTimer = undefined;
      portPress = null;
    };
    const activateConnectionDrag = () => {
      const pending = portPress;
      if (
        !pending ||
        pending.active ||
        !gesture.active ||
        pressOwner !== hooks.editor() ||
        pressRevision !== hooks.editor().revision ||
        hooks.fileBusy()
      )
        return;
      clearTimeout(holdTimer);
      holdTimer = undefined;
      pending.active = true;
      drag = null;
      firstEndpoint = null;
      chooseEndpoint(pending.endpoint);
      linkCursor = anchorPosition(pending.endpoint);
      $('connectHint').textContent = '拖到目标油口后松开连接；Esc取消。';
      draw();
    };
    let pressShift = false;
    let releasedPath: { target: BoardTarget; x: number; y: number; wall: number } | null = null;
    let valveControlTimer: ReturnType<typeof setTimeout> | undefined;
    board.addEventListener('contextmenu', () => clearTimeout(valveControlTimer));
    const abort = () => {
      clearHold();
      firstEndpoint = null;
      connectArmed = false;
      connectionOwner = null;
      linkCursor = null;
      hoveredEndpoint = null;
      if (drag?.kind === 'pan') view.restore(drag.viewport);
      gesture.cancel();
      drag = null;
      pathPreview = null;
      releasedPath = null;
      document.documentElement.classList.remove('network-dragging');
      const pointer = captured;
      captured = null;
      if (pointer !== null && board.hasPointerCapture(pointer)) board.releasePointerCapture(pointer);
      draw();
    };
    cancelPointer = abort;
    const updateLinkHover = (event: PointerEvent) => {
      if (!firstEndpoint) return;
      const p = position(event);
      linkCursor = { x: p.x, y: p.y };
      const project = hooks.editor().document;
      const physicalTap = firstEndpoint.kind !== 'route' && isExternalMotorPressureTap(project, firstEndpoint);
      branchPoints =
        connectionKind === 'ideal' || physicalTap
          ? deriveBranchPoints(
              project,
              view.value.zoom,
              null,
              linkCursor,
              true,
              physicalTap,
              hooks.branchRevealRadius(),
            )
          : [];
      const hit = snapAt(event.clientX, event.clientY, true);
      hoveredEndpoint =
        hit?.kind === 'hit' && JSON.stringify(hit.endpoint) !== JSON.stringify(firstEndpoint) ? hit.endpoint : null;
      draw();
    };
    board.addEventListener('pointerleave', () => {
      if (firstEndpoint && !gesture.active) {
        linkCursor = null;
        hoveredEndpoint = null;
        draw();
      }
    });
    board.addEventListener('pointerdown', (event) => {
      if (![0, 1].includes(event.button) || gesture.active || hooks.fileBusy()) return;
      if (!(event.target instanceof Element)) return;
      const target = targetAt(event.target, event.clientX, event.clientY),
        start = position(event);
      if (target.kind === 'ambiguous') {
        hooks.toast('油口过近，请放大后选择。');
        return;
      }
      if (!gesture.begin(event.pointerId, target, event.clientX, event.clientY)) return;
      event.preventDefault();
      getSelection()?.removeAllRanges();
      board.focus({ preventScroll: true });
      pressShift = event.shiftKey;
      pressOwner = hooks.editor();
      pressRevision = pressOwner.revision;
      if (event.button === 1)
        drag = {
          kind: 'pan',
          start: { x: event.clientX, y: event.clientY },
          dx: 0,
          dy: 0,
          viewport: { ...view.value },
        };
      else if (!firstEndpoint) {
        if (target.kind === 'component' || target.kind === 'node' || target.kind === 'text') {
          const item: Selection = { kind: target.kind, id: target.id };
          drag = {
            kind: 'objects',
            start,
            dx: 0,
            dy: 0,
            selection: isSelected(item.kind, item.id) ? (selections.length ? [...selections] : [item]) : [item],
          };
        } else if (target.kind === 'background')
          drag = { kind: 'marquee', start, dx: 0, dy: 0, additive: event.shiftKey };
        else if (target.kind === 'path') {
          const route = hooks.editor().document.layout.routes.find((r) => r.connectionId === target.id);
          if (target.part === 'segment' || route?.mode === 'manual')
            drag = {
              kind: 'path',
              start,
              dx: 0,
              dy: 0,
              id: target.id,
              index: target.index,
              part: target.part,
              points: target.part === 'bend' && route?.mode === 'manual' ? route.points : currentRoute(target.id),
            };
        }
      }
      captured = event.pointerId;
      board.setPointerCapture(event.pointerId);
      const source =
        target.kind === 'endpoint' || target.kind === 'branch'
          ? target.endpoint
          : target.kind === 'node'
            ? target.endpoint
            : null;
      if (event.button === 0 && source) {
        portPress = {
          endpoint: source,
          x: event.clientX,
          y: event.clientY,
          direct: target.kind === 'endpoint' || target.kind === 'branch' || firstEndpoint !== null || connectArmed,
          active: false,
        };
        holdTimer = setTimeout(activateConnectionDrag, canvasLongPressMs);
      }
    });
    board.addEventListener('pointermove', (event) => {
      if (firstEndpoint && (captured !== event.pointerId || !gesture.active)) updateLinkHover(event);
      if (captured !== event.pointerId || !gesture.active) return;
      if (
        gesture.active &&
        (pressOwner !== hooks.editor() || pressRevision !== hooks.editor().revision || hooks.fileBusy())
      ) {
        abort();
        return;
      }
      if (portPress && !portPress.active) {
        const distance = Math.hypot(event.clientX - portPress.x, event.clientY - portPress.y);
        if (portPress.direct && distance >= 5) activateConnectionDrag();
        else if (distance >= 8) clearHold();
        else return; // Small hold jitter must not start moving a node.
      }
      if (portPress?.active) {
        const rect = $('canvasStage').getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        ) {
          abort();
          return;
        }
        gesture.move(event.pointerId, event.clientX, event.clientY);
        updateLinkHover(event);
        return;
      }
      if (!gesture.move(event.pointerId, event.clientX, event.clientY)) return;
      document.documentElement.classList.add('network-dragging');
      if (!drag) return;
      if (drag.kind === 'pan') {
        drag.dx = event.clientX - drag.start.x;
        drag.dy = event.clientY - drag.start.y;
        view.pan(drag.viewport, drag.dx, drag.dy);
      } else {
        const p = position(event);
        drag.dx = layoutCoordinateDelta(drag.start.x, p.x);
        drag.dy = layoutCoordinateDelta(drag.start.y, p.y);
        if (drag.kind === 'objects') {
          const members = [
            ...(hooks.editor().document.layout.texts ?? []).filter(
              (p) => drag?.kind === 'objects' && drag.selection.some((s) => s.kind === 'text' && s.id === p.id),
            ),
            ...(hooks.editor().document.layout.probes ?? []).filter(
              (p) => drag?.kind === 'objects' && drag.selection.some((s) => s.kind === 'probe' && s.id === p.probeId),
            ),
            ...hooks
              .editor()
              .document.layout.components.filter(
                (p) =>
                  drag?.kind === 'objects' &&
                  drag.selection.some((s) => s.kind === 'component' && s.id === p.componentId),
              ),
            ...hooks
              .editor()
              .document.layout.nodes.filter(
                (p) => drag?.kind === 'objects' && drag.selection.some((s) => s.kind === 'node' && s.id === p.nodeId),
              ),
          ];
          drag.dx = Math.max(...members.map((p) => -1e6 - p.x), Math.min(drag.dx, ...members.map((p) => 1e6 - p.x)));
          drag.dy = Math.max(...members.map((p) => -1e6 - p.y), Math.min(drag.dy, ...members.map((p) => 1e6 - p.y)));
        } else if (drag.kind === 'path') {
          const d = drag;
          const a = d.points[d.index],
            b = d.points[d.index + 1];
          if (d.part === 'segment' && a && b && (a.x === b.x ? d.dx === 0 : d.dy === 0)) {
            pathPreview = null;
            draw();
            return;
          }
          pathPreview =
            d.part === 'segment'
              ? segmentRoute(d.id, d.points, d.index, { x: d.dx, y: d.dy })
              : manualRoute(
                  d.id,
                  d.points.map((p, i) =>
                    i === d.index ? { x: clampCoordinate(p.x + d.dx), y: clampCoordinate(p.y + d.dy) } : p,
                  ),
                );
        }
      }
      draw();
    });
    board.addEventListener('pointerup', (event) => {
      if (captured !== event.pointerId || !gesture.active) return;
      if (
        gesture.active &&
        (pressOwner !== hooks.editor() || pressRevision !== hooks.editor().revision || hooks.fileBusy())
      ) {
        abort();
        return;
      }
      const held = portPress?.active === true;
      clearHold();
      const result = gesture.finish(event.pointerId, event.clientX, event.clientY);
      if (!result) return;
      const move = drag,
        preview = pathPreview;
      drag = null;
      pathPreview = null;
      captured = null;
      document.documentElement.classList.remove('network-dragging');
      if (board.hasPointerCapture(event.pointerId)) board.releasePointerCapture(event.pointerId);
      event.preventDefault();
      if (held) {
        const hit = snapAt(event.clientX, event.clientY, true);
        const within = $('canvasStage').getBoundingClientRect();
        if (
          event.clientX >= within.left &&
          event.clientX <= within.right &&
          event.clientY >= within.top &&
          event.clientY <= within.bottom &&
          hit?.kind === 'hit' &&
          JSON.stringify(hit.endpoint) !== JSON.stringify(firstEndpoint)
        )
          chooseEndpoint(hit.endpoint);
        else {
          firstEndpoint = null;
          connectionOwner = null;
          linkCursor = null;
          hoveredEndpoint = null;
          $('connectHint').textContent = '未选中唯一目标，已取消拖动连接。';
          draw();
        }
        releasedPath = null;
        return;
      }
      if (move?.kind === 'pan') {
        if (result.dragged) view.save();
        draw();
        return;
      }
      if (result.dragged) {
        releasedPath = null;
        if (!move || (!move.dx && !move.dy)) {
          draw();
          return;
        }
        if (move.kind === 'objects') {
          select(move.selection);
          const candidate = moveSelection(hooks.editor().document, move.selection, { x: move.dx, y: move.dy });
          const item = move.selection.length === 1 ? move.selection[0] : undefined;
          const meter =
            item?.kind === 'component' &&
            candidate.design.components.find((c) => c.id === item.id && c.typeId === 'flow-meter');
          if (meter) {
            const plan = planNetworkFlowMeterInsertion(candidate, {
              componentId: meter.id,
              connectionId: hooks.uid('meterline'),
              tolerance: 16,
            });
            if (!plan.ok) hooks.diagnostics(plan.diagnostics);
            else if (hooks.mutate(plan.value.document, plan.value.inserted) && plan.value.inserted)
              hooks.toast('流量计已串入管线，可一次撤销；双击可修改阻力参数。');
          } else hooks.mutate(candidate, false);
        } else if (move.kind === 'path' && preview) setRoute(preview);
        else if (move.kind === 'marquee') {
          const found = marqueeSelection(
            hooks.editor().document,
            move.start,
            { x: move.start.x + move.dx, y: move.start.y + move.dy },
            hooks.editor().document.design.connections.map((e) => ({ id: e.id, points: currentRoute(e.id) })),
          );
          const kind = move.dx >= 0 ? 'component' : 'connection';
          const combined = [...(move.additive ? selections.filter((s) => s.kind === kind) : []), ...found];
          select([...new Map(combined.map((s) => [selectionKey(s), s])).values()]);
          hooks.render();
        }
        return;
      }
      const target = result.target;
      if (target.kind === 'ambiguous') return;
      if (target.kind === 'branch') {
        chooseEndpoint(target.endpoint);
        return;
      }
      if (target.kind === 'background' && (firstEndpoint || connectArmed)) {
        abort();
        if (selected?.kind === 'node') select(selections.filter((item) => item.kind !== 'node'));
        hooks.render();
        $('connectHint').textContent = '已取消连接起点；可重新选择或拖动画布。';
        return;
      }
      releasedPath = { target, x: event.clientX, y: event.clientY, wall: performance.now() };
      if (target.kind === 'path') {
        activeBend = target.part === 'bend' ? target.index : null;
        draw();
        return;
      }
      if (
        (firstEndpoint || connectArmed) &&
        (target.kind === 'endpoint' || (target.kind === 'node' && target.endpoint))
      ) {
        chooseEndpoint(target.endpoint!);
        return;
      }
      if (firstEndpoint) {
        $('connectHint').textContent = '正在连接：请选择油口或分支节点，或先取消连接。';
        return;
      }
      // Short node clicks select, immediate drags move, and a short hold connects.
      // Ports also retain click-to-connect and the C shortcut.
      if (target.kind === 'endpoint') {
        chooseEndpoint(target.endpoint);
        return;
      }
      if (target.kind === 'background') select([]);
      else {
        const item: Selection = { kind: target.kind, id: target.id };
        select(
          pressShift
            ? isSelected(item.kind, item.id)
              ? selections.filter((s) => selectionKey(s) !== selectionKey(item))
              : [...selections, item]
            : [item],
        );
      }
      hooks.render();
      if (target.kind === 'connection')
        $('connectHint').textContent = '方形中点用于上下/左右调线；理想线的圆形拐点可点击或拖出分支。';
      if (!pressShift && target.kind === 'component' && target.positionId && hooks.runtimeReady()) {
        clearTimeout(valveControlTimer);
        const owner = hooks.editor(),
          revision = owner.physicsRevision;
        const send = () => {
          if (hooks.editor() === owner && owner.physicsRevision === revision && hooks.runtimeReady())
            void hooks.sendControl([{ componentId: target.id, kind: 'position', positionId: target.positionId }]);
        };
        if (hooks.running()) send();
        else valveControlTimer = setTimeout(send, 300);
      }
    });
    board.addEventListener(
      'wheel',
      (event) => {
        if (gesture.active || hooks.fileBusy()) return;
        event.preventDefault();
        // A wheel zoom commits only the camera. Keep a current connection start
        // across that view revision, without reviving an already stale owner.
        const owner = connectionOwner;
        const currentOwner = owner?.editor === hooks.editor() && owner.revision === hooks.editor().revision;
        view.zoom(event);
        if (owner && currentOwner && owner.editor === hooks.editor()) owner.revision = hooks.editor().revision;
        draw();
      },
      { passive: false },
    );
    board.addEventListener('auxclick', (e) => e.preventDefault());
    board.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    board.addEventListener('dblclick', (event) => {
      // Pointer capture retargets the native click/dblclick to the board. Resolve
      // it from the completed short press, with screen distance/time ownership.
      const target =
        releasedPath &&
        performance.now() - releasedPath.wall <= 1000 &&
        Math.hypot(event.clientX - releasedPath.x, event.clientY - releasedPath.y) < 5
          ? releasedPath.target
          : targetOf(event.target as Element);
      if (target.kind === 'text' && !firstEndpoint) {
        hooks.editText(target.id);
        event.preventDefault();
        return;
      }
      if (target.kind === 'component' && !firstEndpoint) {
        const component = hooks.editor().document.design.components.find((c) => c.id === target.id);
        if (component && componentEditor(component, hooks.runtimeReady()) === 'valve') clearTimeout(valveControlTimer);
        hooks.editComponent(target.id);
        event.preventDefault();
        return;
      }
      // Selecting an automatic line adds midpoint grips between the two clicks.
      // Those grips must not turn a readout double-click into a manual-route edit.
      const readoutId =
        target.kind === 'connection'
          ? target.id
          : target.kind === 'path' &&
              target.part === 'segment' &&
              hooks.editor().document.layout.routes.find((route) => route.connectionId === target.id)?.mode !== 'manual'
            ? target.id
            : null;
      if (readoutId && !firstEndpoint) {
        readoutConnection = readoutId;
        select([{ kind: 'connection', id: readoutId }]);
        document.documentElement.dataset.inspectorOpen = 'true';
        hooks.render();
        $('connectionReadout').scrollIntoView({ block: 'nearest' });
        event.preventDefault();
        return;
      }
      if (target.kind !== 'path' || target.part !== 'segment' || firstEndpoint) return;
      const points = currentRoute(target.id),
        p = position(event);
      points.splice(target.index + 1, 0, { x: clampCoordinate(p.x), y: clampCoordinate(p.y) });
      setRoute(manualRoute(target.id, points));
    });
    board.addEventListener('pointercancel', (event) => {
      if (captured === event.pointerId) abort();
    });
    board.addEventListener('lostpointercapture', (event) => {
      if (gesture.active && captured === event.pointerId) abort();
    });
    window.addEventListener('blur', () => {
      if (gesture.active || firstEndpoint) abort();
    });
    new ResizeObserver((entries) => {
      const entry = entries.find((item) => item.target === board);
      if (entry) view.resize(entry.contentRect.width, entry.contentRect.height);
    }).observe(board);
    setupCanvasKeyboard({
      board,
      editor: hooks.editor,
      active: () => gesture.active,
      connecting: () => firstEndpoint !== null,
      selected: () => selected,
      fileBusy: hooks.fileBusy,
      save: hooks.save,
      undoRedo: hooks.undoRedo,
      render: hooks.render,
      select,
      fitAll,
      removeSelected,
      escape() {
        if (gesture.active) abort();
        firstEndpoint = null;
        connectArmed = false;
        if (pendingPipe) hooks.cancelPipeEdit();
        select([]);
        hooks.render();
        $('connectHint').textContent = '已取消操作并清除选择；设计与运行保持。';
      },
    });
    board.addEventListener('keydown', (event) => {
      if (
        event.key !== 'Enter' ||
        event.repeat ||
        gesture.active ||
        firstEndpoint ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      )
        return;
      const target = targetOf(event.target as Element);
      if (target.kind !== 'component' || !target.positionId) return;
      event.preventDefault();
      select([{ kind: 'component', id: target.id }]);
      hooks.render();
      void hooks.sendControl([{ componentId: target.id, kind: 'position', positionId: target.positionId }]);
    });
  }
  function setConnectionPolicy(): void {
    if (pendingPipe) hooks.cancelPipeEdit();
    connectionKind = ($('connectionPolicy') as HTMLSelectElement).value === 'pipe' ? 'pipe' : 'ideal';
    firstEndpoint = null;
    connectArmed = true;
    $('connectHint').textContent = connectionKind === 'ideal' ? '理想等压，选两个端点。' : '物理管：选端点后填参数。';
    draw();
  }
  function resetConnectionPolicy(): void {
    pendingPipe = null;
    connectionKind = 'ideal';
    connectArmed = false;
    ($('connectionPolicy') as HTMLSelectElement).value = 'auto';
    $('connectHint').textContent = '理想等压，忽略管损。';
  }
  function setup() {
    setupDrag();
    $('fitAll').addEventListener('click', fitAll);
    $('manualRoute').addEventListener('click', () => {
      if (selected?.kind !== 'connection' || gesture.active || firstEndpoint) return;
      setRoute(manualRoute(selected.id, currentRoute(selected.id)));
    });
    $('autoRoute').addEventListener('click', () => {
      if (selected?.kind === 'connection' && !gesture.active && !firstEndpoint)
        setRoute({ connectionId: selected.id, mode: 'auto' });
    });
    $('mergeRoute').addEventListener('click', () => {
      if (selected?.kind !== 'connection' || gesture.active || firstEndpoint || hooks.fileBusy()) return;
      const route = hooks.editor().document.layout.routes.find((item) => item.connectionId === selected?.id);
      if (route?.mode === 'manual') setRoute(route);
    });
    $('removeBend').addEventListener('click', () => {
      if (selected?.kind !== 'connection' || activeBend === null || gesture.active || firstEndpoint) return;
      const r = hooks.editor().document.layout.routes.find((r) => r.connectionId === selected!.id);
      if (r?.mode !== 'manual') return;
      if (r.points.length === 1) {
        hooks.toast('至少保留一个手动锚点；可点击恢复自动路径。');
        return;
      }
      setRoute(
        manualRoute(
          r.connectionId,
          r.points.filter((_, i) => i !== activeBend),
        ),
      );
    });

    $('connectMode').addEventListener('click', setConnectionPolicy);
    $('connectionPolicy').addEventListener('change', setConnectionPolicy);
    $('idealMode').addEventListener('click', () => {
      ($('connectionPolicy') as HTMLSelectElement).value = 'auto';
      setConnectionPolicy();
    });
    $('cancelConnect').addEventListener('click', () => {
      cancelPointer?.();
      if (pendingPipe) hooks.cancelPipeEdit();
      $('connectHint').textContent = '已取消连接；可选择对象、拖动或重新选择起点。';
      draw();
    });
  }
  function reset(): void {
    cancelPointer?.();
    readoutConnection = null;
    boardElement().style.pointerEvents = '';
    firstEndpoint = null;
    resetConnectionPolicy();
    loadViewport();
  }
  function confirmPending(): void {
    pendingPipe = null;
  }
  function cancelPending(): boolean {
    const had = pendingPipe !== null;
    pendingPipe = null;
    if (had) select([]);
    return had;
  }
  return {
    setPipeReadoutPinned(value: boolean) {
      readoutPinned = value;
      if (!value) readoutConnection = null;
      draw();
    },
    get selections(): readonly Selection[] {
      return selections.length ? selections : selected ? [selected] : [];
    },
    get editable() {
      return !gesture.active && !firstEndpoint && !pendingPipe && !hooks.fileBusy();
    },
    pastePoint(offset: number) {
      const center = view.visibleCenter();
      return { x: center.x + offset, y: center.y + offset };
    },
    positionAtClient(x: number, y: number): Point | null {
      const board = boardElement(),
        r = board.getBoundingClientRect(),
        visible = $('canvasStage').getBoundingClientRect();
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < visible.left ||
        x > visible.right ||
        y < visible.top ||
        y > visible.bottom
      )
        return null;
      const world = {
        x: view.value.centerX + (x - r.left - r.width / 2) / view.value.zoom,
        y: view.value.centerY + (y - r.top - r.height / 2) / view.value.zoom,
      };
      return Math.abs(world.x) <= 1e6 && Math.abs(world.y) <= 1e6 ? world : null;
    },
    placement() {
      const occupied = [...hooks.editor().document.layout.components, ...(hooks.editor().document.layout.probes ?? [])],
        center = view.visibleCenter();
      for (let ring = 0; ring < 200; ring++) {
        const column = ring % 3;
        const row = Math.floor(ring / 3);
        const x = clampCoordinate(center.x + (column === 1 ? -300 : column === 2 ? 300 : 0)),
          y = clampCoordinate(center.y + (row % 2 ? -(row + 1) / 2 : row / 2) * 220);
        if (!occupied.some((item) => Math.abs(item.x - x) < 280 && Math.abs(item.y - y) < 190)) return { x, y };
      }
      return center;
    },
    setup,
    draw,
    select,
    locateDiagnostic,
    toolView: () => ({ ...view.value }),
    navigateToolView(
      action:
        | { readonly kind: 'fit' }
        | { readonly kind: 'viewport'; readonly centerX: number; readonly centerY: number; readonly zoom: number },
    ): boolean {
      if (gesture.active || pendingPipe || firstEndpoint || connectArmed) return false;
      if (action.kind === 'fit') view.fit(false);
      else view.restore({ centerX: action.centerX, centerY: action.centerY, zoom: action.zoom });
      draw();
      return true;
    },
    isSelected,
    loadViewport,
    reset,
    confirmPending,
    cancelPending,
    removeSelected,
    get selected() {
      return selected;
    },
    get pendingPipe() {
      return pendingPipe;
    },
    get dragging() {
      return drag !== null;
    },
    get gestureActive() {
      return gesture.active;
    },
    get connecting() {
      return firstEndpoint !== null;
    },
  };
}
export type NetworkCanvas = ReturnType<typeof createNetworkCanvas>;
