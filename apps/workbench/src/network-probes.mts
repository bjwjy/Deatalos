import {
  networkEndpointPosition,
  planNetworkProbe,
  type NetworkDraftSession,
  type NetworkProbeEdit,
} from '@hyd/application';
import {
  networkDefinition,
  networkProbeEndpoint,
  networkProbeName,
  networkProbePressure,
  networkControllerColor,
  networkControllerSlot,
  type NetworkProject,
  type NetworkEndpoint,
} from '@hyd/domain';
import type { NetworkRuntime } from './network-runtime-controller.mjs';
import type { NetworkCanvas } from './network-canvas-controller.mjs';
import { pressureProbeGauge } from './network-controller-symbols.mjs';
import { canvasLongPressMs, canvasDragThresholdPx } from './canvas-gesture.mjs';
import { element as $, boardElement, escapeHtml as esc } from './network-dom.mjs';
import { readEndpoint } from './network-canvas-targets.mjs';
import { segmentRoute } from './network-cad.mjs';
import { pressureGaugeRoute as signalRoute } from './network-instrument-symbols.mjs';
import { routePath } from './network-presentation.mjs';
import { teachingDemoButton } from './network-teaching-demo.mjs';
interface Hooks {
  editor(): NetworkDraftSession;
  canvas: NetworkCanvas;
  simulation: NetworkRuntime;
  apply(project: NetworkProject): boolean;
  uid(): string;
  toast(message: string): void;
}
type Point = { readonly x: number; readonly y: number };
const probeScale = 0.68,
  connectorY = 64 * probeScale;
type Drag = {
  readonly startScreen: Point;
  readonly pointerId: number;
  readonly id: string;
  readonly owner: NetworkDraftSession;
  readonly revision: number;
  readonly start: Point;
  ready: boolean;
  moved: boolean;
} & (
  | { readonly kind: 'add' | 'move'; readonly offset: Point; point: Point }
  | {
      readonly kind: 'route';
      readonly original: readonly Point[];
      readonly segment: number;
      points: readonly Point[] | null;
    }
);
export function createNetworkProbes(hooks: Hooks) {
  let drag: Drag | null = null,
    timer = 0,
    connecting: string | null = null,
    cursor: Point | null = null,
    editing: string | null = null;
  let connectOwner: NetworkDraftSession | null = null,
    editOwner: NetworkDraftSession | null = null;
  const dialog = (() => {
    const d = $('probeDialog');
    if (!(d instanceof HTMLDialogElement)) throw new Error('Probe editor requires dialog');
    return d;
  })();
  const teaching = teachingDemoButton('instrument:pressure-gauge');
  function clear(): void {
    window.clearTimeout(timer);
    drag = null;
    cursor = null;
  }
  async function apply(edit: NetworkProbeEdit): Promise<void> {
    const editor = hooks.editor(),
      revision = editor.revision;
    const plan = planNetworkProbe(editor.document, edit);
    if (!plan.ok) {
      hooks.toast(plan.diagnostics.map((d) => d.message).join('；'));
      return;
    }
    const layoutOnly = edit.kind === 'move' || edit.kind === 'route';
    if (!layoutOnly) await hooks.simulation.controllerAction('sequence-stop');
    if (hooks.editor() !== editor || editor.revision !== revision) {
      hooks.toast('工程已改变，操作未应用，请重试。');
      return;
    }
    if (!layoutOnly && ['running', 'paused', 'failed'].includes(hooks.simulation.runtime?.sequence?.status ?? '')) {
      hooks.toast('自动控制尚未确认停止，操作未应用。');
      return;
    }
    if (hooks.apply(plan.value) && !layoutOnly) {
      if (edit.kind === 'delete') hooks.canvas.select([]);
      if (edit.kind === 'add' || edit.kind === 'add-near' || edit.kind === 'add-gauge')
        hooks.canvas.select([{ kind: 'probe', id: edit.id }]);
      hooks.canvas.draw();
      hooks.toast(
        edit.kind === 'add' || edit.kind === 'add-near' || edit.kind === 'add-gauge'
          ? '压力表已创建；点击下方连接口，再点液压油口或分支节点。双击压力表可配置。'
          : '压力表配置已更新；请保存工程。',
      );
    }
  }
  function open(id: string): void {
    const project = hooks.editor().document,
      probe = project.controlProbes?.find((p) => p.id === id);
    if (!probe) return;
    if (teaching && !teaching.isConnected) $('closeProbe').before(teaching);
    editing = id;
    editOwner = hooks.editor();
    $('probePrefix').textContent = '';
    const name = $('probeName'),
      nodes = $('probeNode');
    if (!(name instanceof HTMLInputElement) || !(nodes instanceof HTMLSelectElement))
      throw new Error('Probe fields missing');
    name.value = probe.name;
    const option = (value: string, label: string) => `<option value="${esc(value)}">${esc(label)}</option>`;
    const ports = project.design.components.flatMap((component) =>
      (networkDefinition(component.definition.id, component.definition.version)?.ports ?? [])
        .filter((port) => port.domain === 'hydraulic')
        .map((port) =>
          option(
            JSON.stringify({ kind: 'port', componentId: component.id, portId: port.id }),
            component.label + ' · ' + port.id + ' 口',
          ),
        ),
    );
    nodes.innerHTML =
      '<option value="">未连接</option>' +
      (ports.length ? '<optgroup label="元件油口">' + ports.join('') + '</optgroup>' : '') +
      (project.design.nodes.length
        ? '<optgroup label="分支节点">' +
          project.design.nodes.map((node) => option(node.id, node.label || node.id)).join('') +
          '</optgroup>'
        : '');
    const target = networkProbeEndpoint(project, probe);
    nodes.value = target?.kind === 'port' ? JSON.stringify(target) : (target?.nodeId ?? '');
    if (!dialog.open) dialog.showModal();
  }
  function render(): void {
    if (connectOwner !== hooks.editor()) {
      connecting = null;
      cursor = null;
    }
    if (dialog.open) {
      const p = hooks.editor().document.controlProbes?.find((p) => p.id === editing);
      if (!p || editOwner !== hooks.editor()) {
        dialog.close();
        return;
      }
      $('probePrefix').textContent = '';
    }
  }
  function overlay(project: NetworkProject): string {
    const live = hooks.simulation.runtime;
    const point =
      !hooks.simulation.invalidated &&
      live?.status === 'ready' &&
      live.documentSessionId === hooks.editor().documentSessionId &&
      live.physicsRevision === hooks.editor().physicsRevision
        ? live.point
        : null;
    let html = '';
    for (const probe of project.controlProbes ?? []) {
      const saved = project.layout.probes?.find((p) => p.probeId === probe.id);
      if (!saved) continue;
      const p = drag?.kind === 'move' && drag.id === probe.id ? drag.point : saved;
      const color = 1,
        hue = networkControllerColor(color);
      const endpoint = networkProbeEndpoint(project, probe);
      const node = endpoint ? networkEndpointPosition(project, endpoint) : null;
      const reading = networkProbePressure(project, probe.id, point),
        value = reading.kind === 'known' ? reading.value : null;
      if (node) {
        const draft = drag?.kind === 'route' && drag.id === probe.id ? drag.points : null;
        const route = signalRoute(probe.id, { x: p.x, y: p.y + connectorY }, node, draft ?? saved.signalPoints);
        html += `<path data-probe-link="${esc(probe.id)}" d="${routePath(route)}" class="probe-link" stroke="${hue}"/>`;
        if (!drag && !connecting && hooks.canvas.editable) {
          const matrix = boardElement().getScreenCTM();
          const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 0;
          if (scale > 0) {
            // Keep the invisible drag target clear of both measurement connectors.
            const clearance = 13 / scale;
            for (const [index, from] of route.entries()) {
              const to = route[index + 1];
              if (!to) break;
              const length = Math.hypot(to.x - from.x, to.y - from.y);
              const start = index === 0 ? clearance : 0;
              const end = index === route.length - 2 ? clearance : 0;
              if (length <= start + end) continue;
              const a = start / length,
                b = 1 - end / length;
              const x = to.x - from.x,
                y = to.y - from.y;
              html += `<path class="probe-link-hit" data-probe-route="${esc(probe.id)}" data-segment="${index}" d="M${from.x + x * a} ${from.y + y * a}L${from.x + x * b} ${from.y + y * b}"><title>拖动调整测压管线</title></path>`;
            }
          }
        }
      }
      const label = networkProbeName(project, probe);
      const selected = hooks.canvas.isSelected('probe', probe.id);
      const frame = `<rect x="-${Math.max(30, Math.min(32, label.length) * 6)}" y="-43" width="${Math.max(60, Math.min(32, label.length) * 12)}" height="112" fill="none" stroke="${selected ? '#b34e20' : 'none'}" stroke-width="2" stroke-dasharray="5 3" pointer-events="none"/><rect data-probe-hit x="-${Math.max(30, Math.min(32, label.length) * 6)}" y="-43" width="${Math.max(60, Math.min(32, label.length) * 12)}" height="74" fill="transparent"/>`;
      html += `<g data-probe-id="${esc(probe.id)}" data-probe-size="compact" transform="translate(${p.x} ${p.y})" class="pressure-probe"><title>${esc(label)} · ${reading.kind === 'known' ? '表压 ' + (reading.value / 1e6).toFixed(3) + ' MPa' : esc(reading.reason)}；双击配置，表盘显示范围0～10 MPa，数字显示实际值</title>${frame}<g transform="scale(${probeScale})"><path d="M0 33V60" stroke="#354b62" stroke-width="2.5"/>${pressureProbeGauge(color, value, probeScale)}</g><circle data-probe-connector="${esc(probe.id)}" cx="0" cy="${connectorY}" r="7" fill="white" stroke="${hue}" stroke-width="2"/><text text-anchor="middle" x="0" y="${-43 * probeScale}" fill="#354b62" font-size="12">${esc(label.length > 32 ? label.slice(0, 31) + '…' : label)}</text><text text-anchor="middle" x="0" y="${connectorY + 17}" fill="#617783" font-size="9">${node ? (value === null ? '暂无有效压力' : '') : probe.nodeId || probe.port ? '测点已失效' : '未连接'}</text></g>`;
      if (connecting === probe.id && cursor)
        html += `<path d="M${p.x} ${p.y + connectorY}L${cursor.x} ${cursor.y}" class="probe-link" stroke="${hue}"/>`;
    }
    if (drag?.kind === 'add' && drag.ready && drag.moved)
      html += `<g transform="translate(${drag.point.x} ${drag.point.y}) scale(${probeScale})" pointer-events="none" opacity=".7">${pressureProbeGauge(networkControllerSlot(project, drag.id), null, probeScale)}<path d="M0 33V60" stroke="#354b62"/></g>`;
    return `<g data-probe-overlay>${html}</g>`;
  }
  function setup(): void {
    const board = boardElement();
    const hit = (event: MouseEvent) => document.elementFromPoint(event.clientX, event.clientY);
    const stop = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    function moveRoute(current: Extract<Drag, { kind: 'route' }>, p: Point): void {
      const delta = { x: p.x - current.start.x, y: p.y - current.start.y };
      const a = current.original[current.segment];
      const b = current.original[current.segment + 1];
      if (!a || !b || Math.abs(a.x === b.x ? delta.x : delta.y) < 0.01) {
        current.points = null;
        return;
      }
      const route = segmentRoute(current.id, current.original, current.segment, delta);
      current.points = route.mode === 'manual' ? route.points : null;
    }
    board.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0 || drag || !hooks.canvas.editable || dialog.open) return;
        const target = hit(event);
        if (!target) return;
        if (connecting) {
          const endpoint = target.closest('[data-endpoint]')?.getAttribute('data-endpoint');
          const nodeId = target.closest('[data-node]')?.getAttribute('data-node');
          const point: NetworkEndpoint | undefined = endpoint
            ? readEndpoint(endpoint)
            : nodeId
              ? { kind: 'node', nodeId }
              : undefined;
          const probe = hooks.editor().document.controlProbes?.find((p) => p.id === connecting);
          stop(event);
          const reference = point?.kind === 'port' ? { nodeId: null, port: point } : { nodeId: point?.nodeId ?? null };
          if (point && probe && networkProbeEndpoint(hooks.editor().document, reference)) {
            connecting = null;
            cursor = null;
            hooks.canvas.draw();
            void apply({ kind: 'configure', id: probe.id, name: probe.name, ...reference });
          } else hooks.toast('请点液压油口或分支节点；按 Esc 取消压力表连线。');
          return;
        }
        const connector = target.closest('[data-probe-connector]')?.getAttribute('data-probe-connector');
        if (connector) {
          connecting = connector;
          connectOwner = hooks.editor();
          stop(event);
          hooks.toast('再点液压油口或分支节点连接压力表；Esc 取消。');
          return;
        }
        const routeHandle = target.closest('[data-probe-route]');
        const routeId = routeHandle?.getAttribute('data-probe-route');
        if (routeHandle && routeId) {
          const editor = hooks.editor();
          const project = editor.document;
          const saved = project.layout.probes?.find((p) => p.probeId === routeId);
          const probe = project.controlProbes?.find((p) => p.id === routeId);
          const endpoint = probe && networkProbeEndpoint(project, probe);
          const end = endpoint && networkEndpointPosition(project, endpoint);
          const start = hooks.canvas.positionAtClient(event.clientX, event.clientY);
          const segment = Number(routeHandle.getAttribute('data-segment'));
          if (!saved || !end || !start || !Number.isInteger(segment) || segment < 0) return;
          const original = signalRoute(routeId, { x: saved.x, y: saved.y + connectorY }, end, saved.signalPoints);
          if (!original[segment + 1]) return;
          stop(event);
          drag = {
            kind: 'route',
            id: routeId,
            owner: editor,
            revision: editor.revision,
            start,
            startScreen: { x: event.clientX, y: event.clientY },
            pointerId: event.pointerId,
            original,
            segment,
            ready: true,
            moved: false,
            points: null,
          };
          board.focus({ preventScroll: true });
          board.setPointerCapture(event.pointerId);
          return;
        }
        const handle = target.closest('[data-probe-handle]'),
          probeId =
            target.closest('[data-probe-id]')?.getAttribute('data-probe-id') ??
            target.closest('[data-probe-pick]')?.getAttribute('data-probe-pick');
        const ownerId = handle?.closest('[data-component]')?.getAttribute('data-component');
        if (!ownerId && !probeId) return;
        const p = hooks.canvas.positionAtClient(event.clientX, event.clientY);
        if (!p) return;
        stop(event);
        clear();
        if (probeId) hooks.canvas.select([{ kind: 'probe', id: probeId }]);
        board.focus({ preventScroll: true });
        const saved = hooks.editor().document.layout.probes?.find((v) => v.probeId === probeId);
        const offset = ownerId || !saved ? { x: 0, y: 0 } : { x: saved.x - p.x, y: saved.y - p.y };
        drag = {
          kind: ownerId ? 'add' : 'move',
          id: ownerId ?? probeId ?? '',
          owner: hooks.editor(),
          revision: hooks.editor().revision,
          start: p,
          startScreen: { x: event.clientX, y: event.clientY },
          pointerId: event.pointerId,
          offset,
          ready: !ownerId,
          moved: false,
          point: saved ?? p,
        };
        if (ownerId)
          timer = window.setTimeout(() => {
            if (drag && drag.owner === hooks.editor() && drag.revision === hooks.editor().revision) {
              drag.ready = true;
              hooks.canvas.draw();
            }
          }, canvasLongPressMs);
        board.setPointerCapture(event.pointerId);
      },
      true,
    );
    board.addEventListener(
      'pointermove',
      (event) => {
        if (!connecting && (!drag || drag.pointerId !== event.pointerId)) return;
        const p = hooks.canvas.positionAtClient(event.clientX, event.clientY);
        if (connecting && p) {
          cursor = p;
          hooks.canvas.draw();
        }
        if (!drag || drag.pointerId !== event.pointerId) return;
        stop(event);
        if (!p) return;
        const distance = Math.hypot(event.clientX - drag.startScreen.x, event.clientY - drag.startScreen.y);
        if (distance >= canvasDragThresholdPx) drag.moved = true;
        if (drag.kind === 'route') moveRoute(drag, p);
        else drag.point = { x: p.x + drag.offset.x, y: p.y + drag.offset.y };
        if (drag.ready && drag.moved) {
          hooks.canvas.draw();
        }
      },
      true,
    );
    board.addEventListener(
      'pointerup',
      (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const old = drag;
        stop(event);
        clear();
        if (board.hasPointerCapture(event.pointerId)) board.releasePointerCapture(event.pointerId);
        const released = hooks.canvas.positionAtClient(event.clientX, event.clientY);
        if (!released) {
          hooks.toast('未放到画布，已取消压力表拖动。');
          hooks.canvas.draw();
          return;
        }
        if (old.owner !== hooks.editor() || old.revision !== hooks.editor().revision) {
          hooks.toast('工程已改变，本次拖动已取消。');
          hooks.canvas.draw();
          return;
        }
        if (old.kind === 'route') {
          if (old.moved && hooks.canvas.editable) {
            moveRoute(old, released);
            if (old.points) void apply({ kind: 'route', id: old.id, points: old.points });
          }
        } else if (old.kind === 'add' && !old.moved)
          void apply({ kind: 'add-near', controllerId: old.id, id: hooks.uid() });
        else if (old.ready && old.moved) {
          if (old.kind === 'add')
            void apply({ kind: 'add', controllerId: old.id, id: hooks.uid(), x: old.point.x, y: old.point.y });
          else void apply({ kind: 'move', id: old.id, x: old.point.x, y: old.point.y });
        }
        hooks.canvas.draw();
      },
      true,
    );
    board.addEventListener(
      'pointercancel',
      (event) => {
        if (drag && drag.pointerId !== event.pointerId) return;
        clear();
        connecting = null;
        hooks.canvas.draw();
      },
      true,
    );
    board.addEventListener('lostpointercapture', (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      clear();
      hooks.canvas.draw();
    });
    board.addEventListener(
      'dblclick',
      (event) => {
        if (hit(event)?.closest('[data-probe-handle]')) {
          stop(event);
          return;
        }
        const target = hit(event);
        const id =
          target?.closest('[data-probe-id]')?.getAttribute('data-probe-id') ??
          target?.closest('[data-probe-pick]')?.getAttribute('data-probe-pick');
        if (id) {
          stop(event);
          open(id);
        }
      },
      true,
    );
    board.addEventListener(
      'keydown',
      (event) => {
        if (event.repeat || !['Enter', ' '].includes(event.key) || !hooks.canvas.editable || dialog.open) return;
        const handle = event.target instanceof Element ? event.target.closest('[data-probe-handle]') : null;
        const owner = handle?.closest('[data-component]')?.getAttribute('data-component');
        if (owner) {
          stop(event);
          void apply({ kind: 'add-near', controllerId: owner, id: hooks.uid() });
        }
      },
      true,
    );
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && (drag || connecting)) {
        const pointerId = drag?.pointerId;
        clear();
        connecting = null;
        if (pointerId !== undefined && board.hasPointerCapture(pointerId)) board.releasePointerCapture(pointerId);
        hooks.canvas.draw();
      }
    });
    $('closeProbe').addEventListener('click', () => dialog.close());
    $('saveProbe').addEventListener('click', () => {
      const name = $('probeName'),
        node = $('probeNode');
      if (editing && name instanceof HTMLInputElement && node instanceof HTMLSelectElement) {
        const endpoint = node.value.startsWith('{') ? readEndpoint(node.value) : undefined;
        const target = endpoint?.kind === 'port' ? { nodeId: null, port: endpoint } : { nodeId: node.value || null };
        void apply({ kind: 'configure', id: editing, name: name.value, ...target });
      }
    });
    $('deleteProbe').addEventListener('click', () => {
      if (editing) void apply({ kind: 'delete', id: editing });
    });
  }
  return { setup, overlay, render, add: (point: Point) => apply({ kind: 'add-gauge', id: hooks.uid(), ...point }) };
}
