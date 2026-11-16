import {
  networkEndpointActive,
  networkDrawingScale,
  networkControllerSlot,
  networkComponentPresentationBounds,
  initialNetworkControls,
  positionDisplayName,
  type NetworkProject,
  type NetworkSnapshot,
  type NetworkEndpoint,
  type NetworkComponent,
} from '@hyd/domain';
import {
  networkDrawingRoute,
  networkDrawingRoutes,
  networkDrawingJunctions,
  type DrawingPoint,
  type NetworkConnectionAnchor,
  type NetworkRouteAnchor,
} from '@hyd/application';
import { networkSymbol } from './network-symbols.mjs';
import { inlineInstrumentReading, inlineInstrumentY } from './network-instrument-symbols.mjs';
import { pressureLegendFor, pressurePalette, type PressureBands } from './network-pressure.mjs';
import { endpointPosition, resolveRoute, type Point, type Selection, type Viewport } from './network-cad.mjs';
import {
  connectionPresentation,
  signalDash,
  signalPresentation,
  routePath,
  flowArrow,
  pressureReference,
  endpointPressure,
  pressureBand,
} from './network-presentation.mjs';
import { element as $, escapeHtml as esc, boardElement, setText } from './network-dom.mjs';
export interface CanvasRenderView {
  readonly document: NetworkProject;
  readonly drawing: NetworkProject;
  readonly viewport: Viewport;
  readonly selected: Selection | null;
  readonly selections: readonly Selection[];
  readonly activeBend: number | null;
  readonly firstEndpoint: NetworkConnectionAnchor | null;
  readonly hoveredEndpoint: NetworkConnectionAnchor | null;
  readonly branchPoints: readonly NetworkRouteAnchor[];
  readonly linkCursor: Point | null;
  readonly connectArmed: boolean;
  readonly connectionRadius: number;
  readonly diagnosticPort: Extract<NetworkEndpoint, { kind: 'port' }> | null;
  readonly labels: Readonly<Record<'components' | 'ports', 'always' | 'selected' | 'hidden'>>;
  readonly pendingPipe: { readonly from: NetworkEndpoint; readonly to: NetworkEndpoint } | null;
  readonly pathPreview: NetworkProject['layout']['routes'][number] | null;
  readonly marqueeDrag: { readonly start: Point; readonly dx: number; readonly dy: number } | null;
  readonly point: NetworkSnapshot | null;
  readonly bands: PressureBands;
  readonly failed: boolean;
  readonly running: boolean;
  readonly runtimeReady: boolean;
  readonly captureSelection: 'current' | 'history' | undefined;
  readonly overlay: string;
  readonly readoutPinned: boolean;
  readonly readoutConnection: string | null;
}
/** Presentation cache only. The caller supplies a read-only frame; no editing/session commands. */
export function createCanvasRenderer() {
  let routeDocument: NetworkProject | null = null;
  const routeCache = new Map<string, ReturnType<typeof networkDrawingRoute>>();
  const junctionCache = new WeakMap<NetworkProject, ReturnType<typeof networkDrawingJunctions>>();
  function drawingRoute(project: NetworkProject, id: string, override?: NetworkProject['layout']['routes'][number]) {
    if (routeDocument !== project) {
      routeDocument = project;
      routeCache.clear();
      for (const [key, value] of networkDrawingRoutes(project)) routeCache.set(key, value);
    }
    if (override) return networkDrawingRoute(project, id, override);
    let value = routeCache.get(id);
    if (!value) {
      value = networkDrawingRoute(project, id);
      routeCache.set(id, value);
    }
    return value;
  }
  const svgBuffer = globalThis.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  let renderedMarkup = '';
  // One latest symbol per immutable component; old engineering objects remain
  // collectable. Position transforms and live connection presentation stay separate.
  const symbols = new WeakMap<NetworkComponent, { key: string; value: string }>();
  function updateSvg(target: Element, source: Element): void {
    if (target.isEqualNode(source)) return;
    if (target.childNodes.length !== source.childNodes.length) {
      target.replaceChildren(...[...source.childNodes].map((node) => node.cloneNode(true)));
      return;
    }
    for (const [index, next] of [...source.childNodes].entries()) {
      const current = target.childNodes[index]!;
      if (current.nodeName !== next.nodeName) {
        current.replaceWith(next.cloneNode(true));
        continue;
      }
      if (current instanceof Element && next instanceof Element) {
        for (const attribute of [...current.attributes])
          if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
        for (const attribute of [...next.attributes])
          if (current.getAttribute(attribute.name) !== attribute.value)
            current.setAttribute(attribute.name, attribute.value);
        updateSvg(current, next);
      } else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    }
  }
  function pathHandles(view: CanvasRenderView): string {
    const { drawing, viewport, selected, firstEndpoint, connectArmed, pathPreview } = view;
    if (selected?.kind !== 'connection' || firstEndpoint || connectArmed) return '';
    const id = selected.id,
      preview = pathPreview?.connectionId === id ? pathPreview : undefined,
      route = preview ?? drawing.layout.routes.find((r) => r.connectionId === id);
    const e = drawing.design.connections.find((e) => e.id === id);
    if (!e) return '';
    const a = endpointPosition(drawing, e.from),
      b = endpointPosition(drawing, e.to);
    if (!a || !b) return '';
    const routed = drawingRoute(drawing, id, preview);
    const points = routed.ok ? routed.value : resolveRoute(a, b, route),
      radius = 5 / viewport.zoom;
    return points
      .slice(0, -1)
      .map((p, i) => {
        const next = points[i + 1]!;
        const vertical = p.x === next.x;
        const attributes = `data-path-id="${esc(id)}" data-part="segment" data-index="${i}"`;
        return (
          `<path class="segment-handle" ${attributes} d="M${p.x} ${p.y}L${next.x} ${next.y}"/>` +
          (Math.hypot(next.x - p.x, next.y - p.y) * viewport.zoom >= 12
            ? `<rect class="segment-grip" ${attributes} data-axis="${vertical ? 'x' : 'y'}" x="${(p.x + next.x) / 2 - radius}" y="${(p.y + next.y) / 2 - radius}" width="${radius * 2}" height="${radius * 2}" rx="${radius / 3}"><title>${vertical ? '竖直段左右拖动' : '水平段上下拖动'}；松手保存，Esc取消</title></rect>`
            : '')
        );
      })
      .join('');
  }
  function render(view: CanvasRenderView) {
    const {
      document,
      drawing,
      viewport,
      selected,
      selections,
      activeBend,
      firstEndpoint,
      hoveredEndpoint,
      linkCursor,
      pendingPipe,
      pathPreview,
      marqueeDrag,
      point,
      bands,
      failed,
      running,
      runtimeReady,
      captureSelection,
      overlay,
      readoutPinned,
      readoutConnection,
    } = view;
    const isSelected = (kind: Selection['kind'], id: string) =>
      selections.some((s) => s.kind === kind && s.id === id) || (selected?.kind === kind && selected.id === id);
    const svg = boardElement();
    if (svg.dataset.portLabels !== view.labels.ports) svg.dataset.portLabels = view.labels.ports;
    if (!drawing.design.connections.length) {
      routeDocument = drawing;
      routeCache.clear();
    }

    const positions = new Map(drawing.layout.components.map((p) => [p.componentId, p]));
    const componentsById = new Map(document.design.components.map((c) => [c.id, c]));
    const nodePositions = new Map(drawing.layout.nodes.map((p) => [p.nodeId, p]));
    const controls = point?.appliedControls ?? initialNetworkControls(document);
    const motionActive = running && runtimeReady && !failed && captureSelection !== 'history';
    const endpoint = (value: NetworkConnectionAnchor) => {
      return value.kind === 'route' ? value.point : endpointPosition(drawing, value);
    };
    const blockedRoutes: string[] = [];
    const dotNodes = new Set(document.design.nodes.filter((n) => n.label === '').map((n) => n.id));
    const endpointMarker = (end: NetworkEndpoint, p: Point, color: string): string => {
      if (end.kind === 'node' && dotNodes.has(end.nodeId)) return '';
      return `<circle class="endpoint" style="--pressure-color:${color}" data-endpoint='${esc(JSON.stringify(end))}' cx="${p.x}" cy="${p.y}" r="9"/>`;
    };
    const edges = document.design.connections
      .map((e) => {
        const a = endpoint(e.from),
          b = endpoint(e.to);
        if (!a || !b) return '';
        const avoided = drawingRoute(drawing, e.id, pathPreview?.connectionId === e.id ? pathPreview : undefined);
        if (!avoided.ok) blockedRoutes.push(e.id);
        const route: readonly DrawingPoint[] = avoided.ok
            ? avoided.value
            : resolveRoute(
                a,
                b,
                pathPreview?.connectionId === e.id
                  ? pathPreview
                  : drawing.layout.routes.find((r) => r.connectionId === e.id),
              ),
          d = routePath(route);
        const active = networkEndpointActive(document, e.from) && networkEndpointActive(document, e.to);
        if (e.kind === 'signal' || !active) {
          const kind = e.kind === 'signal' ? 'signal' : 'hydraulic';
          const signal = e.kind === 'signal' && active ? signalPresentation(componentsById, point, e) : null;
          const color = !avoided.ok ? '#c76613' : (signal?.color ?? '#a3aab1');
          const volts = signal?.voltage;
          const label = active
            ? 'OUT → U · ' + (volts == null ? '电压未知' : volts.toFixed(2) + ' V')
            : '当前控制模式停用此连线';
          return `<path class="edge-hit" data-connection-hit="${esc(e.id)}" d="${d}"/><path class="edge${isSelected('connection', e.id) ? ' selected' : ''}" style="--pressure-color:${color};stroke-dasharray:${e.kind === 'signal' ? signalDash : '3 5'};${e.kind === 'signal' ? 'stroke-width:1.5;' : ''}" data-route-status="${avoided.ok ? 'ready' : 'blocked'}" data-connection-kind="${kind}" data-connection-active="${active}" data-signal-mode="${signal?.mode ?? ''}" data-signal-voltage="${volts ?? ''}" data-connection="${esc(e.id)}" d="${d}"><title>${label}</title></path>`;
        }
        const value = connectionPresentation(document, point, e.id, bands)!;
        return `<path class="edge-hit" data-connection-hit="${esc(e.id)}" d="${d}"/><path class="edge${isSelected('connection', e.id) ? ' selected' : ''}" style="--pressure-error:${pressurePalette(bands).error};--pressure-color:${avoided.ok ? value.color : '#c76613'};${avoided.ok ? '' : 'stroke-dasharray:8 5;'}" data-route-status="${avoided.ok ? 'ready' : 'blocked'}" data-pressure="${failed ? 'error' : value.uniform ? 'uniform' : 'endpoints-only'}" data-flow="${value.direction}" data-connection="${esc(e.id)}" d="${d}"><title>${esc(avoided.ok ? value.summary : '避障受阻，显示待修补路径：' + avoided.diagnostics.map((d) => d.message).join('；'))}</title></path><g data-flow-overlay="${esc(e.id)}" pointer-events="none">${flowArrow(route, value.direction, motionActive && avoided.ok ? 'animated' : 'static')}</g>${endpointMarker(e.from, a, value.fromColor)}${endpointMarker(e.to, b, value.toColor)}`;
      })
      .join('');
    const routingMessage = blockedRoutes.length
      ? `避障受阻：${blockedRoutes.length}条管线。请调整遮挡元件或拖动线段手动修补。`
      : '';
    if ($('routingStatus').textContent !== routingMessage) $('routingStatus').textContent = routingMessage;
    const routingTitle = blockedRoutes.join('、');
    if ($('routingStatus').title !== routingTitle) $('routingStatus').title = routingTitle;
    let drawingJunctions = '';
    if (drawing === document && !pathPreview) {
      let junctions = junctionCache.get(document);
      if (!junctions) {
        junctions = networkDrawingJunctions(document);
        junctionCache.set(document, junctions);
      }
      drawingJunctions = junctions
        .map(({ point: p, connectionId }) => {
          const value = connectionPresentation(document, point, connectionId, bands);
          return value
            ? `<circle data-drawing-junction="" pointer-events="none" cx="${p.x}" cy="${p.y}" r="${4.5 / viewport.zoom}" fill="${value.color}"/>`
            : '';
        })
        .join('');
    }
    const nodes = document.design.nodes
      .map((n) => {
        const p = nodePositions.get(n.id);
        const color =
          pressurePalette(bands)[pressureBand(endpointPressure(point, { kind: 'node', nodeId: n.id }), bands)];
        return p
          ? `<g data-node="${esc(n.id)}"><circle class="node${isSelected('node', n.id) ? ' selected' : ''}" style="stroke:${color}${n.label ? '' : `;fill:${color};stroke-width:1.6;vector-effect:non-scaling-stroke`}" data-endpoint='${esc(JSON.stringify({ kind: 'node', nodeId: n.id }))}' cx="${p.x}" cy="${p.y}" r="${n.label ? 10 : 4.5 / viewport.zoom}"/>${n.label ? `<text x="${p.x + 13}" y="${p.y + 4}" fill="#087e8b">${esc(n.label)}</text>` : ''}</g>`
          : '';
      })
      .join('');
    const components = document.design.components
      .map((c) => {
        const p = positions.get(c.id);
        if (!p) return '';
        const color = c.typeId === 'dynamic-controller' ? networkControllerSlot(drawing, c.id) : undefined;
        const scale = networkDrawingScale(c, p),
          labels =
            view.labels.components === 'always' ||
            (view.labels.components === 'selected' && isSelected('component', c.id));
        const key = JSON.stringify([
          point?.states.find((state) => state.componentId === c.id),
          controls.find((control) => control.componentId === c.id),
          color,
          labels,
          p.rotation,
          p.mirrored,
          scale,
        ]);
        let cached = symbols.get(c);
        if (cached?.key !== key) {
          const value = networkSymbol(
            color === undefined ? c : { ...c, controllerColor: color },
            point?.states ?? [],
            controls,
            { labels, details: false },
            p.rotation,
            scale,
            p.mirrored,
          ).replace(
            /<g data-port="([^"]+)">/g,
            (_match, portId: string) =>
              `<g data-endpoint='${esc(JSON.stringify({ kind: 'port', componentId: c.id, portId }))}'>`,
          );
          cached = { key, value };
          symbols.set(c, cached);
        }
        const symbol = cached.value;
        const interactiveSymbol = symbol.replace(
          /<g data-position="(extend|neutral|retract)"/g,
          (_match, position: string) =>
            `<g role="button" tabindex="0" aria-label="${esc(c.label)} · ${esc(positionDisplayName(position, c))}" data-position="${position}"`,
        );
        const frame = networkComponentPresentationBounds(c, { ...p, x: 0, y: 0 });
        if (!frame) throw new Error('注册元件缺少绘图包络');
        const meter = inlineInstrumentReading(c, point, inlineInstrumentY(c, frame, labels));
        return `<g class="component${isSelected('component', c.id) ? ' selected' : ''}" data-component="${esc(c.id)}" aria-label="${esc(c.label)}" transform="translate(${p.x} ${p.y})">${interactiveSymbol}${meter}<rect class="selection-frame" x="${frame.left - 4}" y="${frame.top - 4}" width="${frame.right - frame.left + 8}" height="${frame.bottom - frame.top + 8}" fill="none" pointer-events="none"/></g>`;
      })
      .join('');
    const box = svg.viewBox.baseVal;
    const draftStart = pendingPipe && endpoint(pendingPipe.from),
      draftEnd = pendingPipe && endpoint(pendingPipe.to);
    const draftLine =
      draftStart && draftEnd
        ? `<path data-pending-pipe d="${routePath(resolveRoute(draftStart, draftEnd, undefined))}" fill="none" stroke="#b34e20" stroke-width="3" stroke-dasharray="8 5" pointer-events="none"><title>待确认物理管，尚未写入工程</title></path>`
        : '';
    const marquee =
      marqueeDrag !== null
        ? `<rect class="marquee" data-selection-kind="${marqueeDrag.dx >= 0 ? 'component' : 'connection'}" x="${Math.min(marqueeDrag.start.x, marqueeDrag.start.x + marqueeDrag.dx)}" y="${Math.min(marqueeDrag.start.y, marqueeDrag.start.y + marqueeDrag.dy)}" width="${Math.abs(marqueeDrag.dx)}" height="${Math.abs(marqueeDrag.dy)}"/>`
        : '';
    const origin = firstEndpoint && endpoint(firstEndpoint),
      target = hoveredEndpoint && endpoint(hoveredEndpoint);
    const problem = view.diagnosticPort && endpoint(view.diagnosticPort);
    const problemMarker =
      problem && view.diagnosticPort
        ? `<circle data-diagnostic-port="${esc(view.diagnosticPort.portId)}" class="diagnostic-port-marker" cx="${problem.x}" cy="${problem.y}" r="${12 / viewport.zoom}" pointer-events="none"/>`
        : '';
    const connectionRadius = view.connectionRadius / viewport.zoom;
    const ring = (point: Point, state: 'origin' | 'target') =>
      `<g data-port-selection="${state}" transform="translate(${point.x} ${point.y})" pointer-events="none" aria-hidden="true"><circle class="port-selected-ring" r="${connectionRadius}"/><circle class="port-selected-pulse" r="${connectionRadius * 1.25}"/></g>`;
    const linking = origin
      ? `${linkCursor ? `<path data-connection-preview d="M${origin.x} ${origin.y}L${target?.x ?? linkCursor.x} ${target?.y ?? linkCursor.y}"/>` : ''}${ring(origin, 'origin')}${target ? ring(target, 'target') : ''}`
      : '';
    const branchHandles = view.branchPoints
      .map(
        (anchor) =>
          `<g data-branch-connection="${esc(anchor.connectionId)}" data-branch-x="${anchor.point.x}" data-branch-y="${anchor.point.y}" transform="translate(${anchor.point.x} ${anchor.point.y})"><circle class="branch-connect-hit" r="${connectionRadius}"/><circle class="branch-connect-point" r="${4.5 / viewport.zoom}"/><title>从拐点接出分支；点击或拖到目标</title></g>`,
      )
      .join('');
    const markup = `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="transparent"/>${edges}${drawingJunctions}${draftLine}${nodes}${components}${overlay}<g data-edit-overlay>${pathHandles(view)}${branchHandles}${marquee}${linking}${problemMarker}</g>`;
    if (markup !== renderedMarkup) {
      svgBuffer.innerHTML = markup;
      updateSvg(svg, svgBuffer);
      renderedMarkup = markup;
    }
    setText($('selectionCount'), selections.length || selected ? `已选 ${selections.length || 1} 项` : '');
    for (const id of ['manualRoute', 'autoRoute', 'mergeRoute']) {
      const command = $(id);
      if (!(command instanceof HTMLButtonElement)) throw new Error('Route command must be a button');
      const disabled =
        selected?.kind !== 'connection' ||
        !document.design.connections.some((edge) => edge.id === selected?.id) ||
        (id === 'mergeRoute' &&
          !document.layout.routes.some((route) => route.connectionId === selected?.id && route.mode === 'manual'));
      if (command.disabled !== disabled) command.disabled = disabled;
    }
    ($('removeBend') as HTMLButtonElement).disabled = activeBend === null;
    setText($('pressureLegend'), pressureReference(document) + pressureLegendFor(bands));
    setText(
      $('drawingSource'),
      point
        ? `${captureSelection === 'history' ? '历史快照' : '当前有效结果'} · ${point.identity.timeS.toFixed(3)} s · 第 ${point.identity.tick} 步${point.initialization === 'transient' ? ' · 瞬态，未认证稳态' : ''}`
        : failed
          ? '错误隔离：没有当前有效压力/流向，请检查诊断后明确重新初始化。'
          : '未初始化：压力与流向未知，缸/马达几何仅作示意。',
    );
    const connection =
      selected?.kind === 'connection' && (readoutPinned || readoutConnection === selected.id)
        ? connectionPresentation(document, point, selected.id, bands)
        : null;
    $('connectionReadout').hidden = !readoutPinned && !connection;
    $('connectionReadout').dataset.simulationSessionId = point?.identity.simulationSessionId ?? '';
    $('connectionReadout').dataset.tick = point ? String(point.identity.tick) : '';
    setText(
      $('connectionResults'),
      connection
        ? `${point ? (captureSelection === 'history' ? '历史记录' : '当前运行') + ' · ' + point.identity.timeS.toPrecision(5) + ' s。' : '未初始化。'}${connection.summary}`
        : readoutPinned
          ? '选择管路读取两端压力与有符号流量。'
          : '双击管路可读取两端压力与有符号流量。',
    );
    const selectedComponentId = selected?.kind === 'component' ? selected.id : null;
    const selectedComponent = document.design.components.find((item) => item.id === selectedComponentId);
    const state = point?.states.find((s) => s.componentId === selectedComponentId);
    const control = point?.appliedControls.find((s) => s.componentId === selectedComponentId);
    setText(
      $('selectedState'),
      state
        ? (captureSelection === 'history' ? '所选历史状态 · ' : '当前状态 · ') +
            (state.kind === 'valve'
              ? `内核阀位：${state.effectivePositionId ? positionDisplayName(state.effectivePositionId, selectedComponent) : '过渡中，尚无有效阀位'}；请求：${control?.kind === 'position' ? positionDisplayName(control.positionId, selectedComponent) : '未知'}`
              : state.kind === 'cylinder'
                ? `内核位移 ${state.positionM} m；实际速度 ${state.velocityMPerS} m/s`
                : state.kind === 'accumulator'
                  ? `存油量 ${state.oilVolumeM3} m³；气体绝压 ${state.gasPressureAbsolutePa} Pa；压缩功 ${state.compressionEnergyJ} J`
                  : `内核转角 ${state.angleRad} rad；实际转速 ${state.angularSpeedRadPerS} rad/s`)
        : '',
    );
  }
  return { render, route: drawingRoute };
}
