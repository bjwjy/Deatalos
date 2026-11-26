import {
  checkJson,
  checkNetworkParameterRules,
  ContractReader,
  diagnostic,
  networkCreationDefinitions,
  networkCreationParameters,
  networkInitialFor,
  parseNetworkProject,
  physicalPipeModel,
  networkPhysicalDesign,
  readNetworkSequence,
  readMotorDisplacementCurve,
  type MotorDisplacementCurve,
  type NetworkComponent,
  type NetworkSequence,
  type NetworkProject,
  type NetworkEndpoint,
  type NetworkRoute,
  type Result,
} from '@hyd/domain';
import { canonical } from './content.js';
import { planNetworkLayout, type NetworkLayoutRequest } from './network-layout.js';
import { networkDrawingRoute } from './network-routing.js';
import { networkToolParameterRows } from './network-tool-parameters.js';
import {
  captureNetworkSelection,
  networkFlipSelection,
  networkMoveSelection,
  networkRotateSelection,
  planNetworkDeleteSelection,
  planNetworkPaste,
  type NetworkSelection,
  type NetworkPasteIds,
} from './network-editing.js';
import { planNetworkText, type NetworkTextEdit } from './network-texts.js';
import { planNetworkProbe, type NetworkProbeEdit } from './network-probes.js';
import { planNetworkSequence } from './network-sequence.js';
import { planNetworkBranchConnection, type NetworkConnectionAnchor } from './network-branch-connection.js';

export const networkToolCommandLimit = 120;

type NetworkToolProbeEdit =
  | Exclude<NetworkProbeEdit, { readonly kind: 'configure' }>
  | {
      readonly kind: 'configure';
      readonly id: string;
      readonly name: string;
      readonly target: NetworkEndpoint | { readonly kind: 'disconnected' };
    };
type ToolPressureRange = { readonly lowPa: number; readonly highPa: number };
type ToolMotorControl =
  | { readonly mode: 'manual' | 'curve'; readonly curve: MotorDisplacementCurve | null }
  | {
      readonly mode: 'external-pressure';
      readonly curve: MotorDisplacementCurve | null;
      readonly pressureRange: ToolPressureRange;
    }
  | {
      readonly mode: 'external-voltage';
      readonly curve: MotorDisplacementCurve | null;
      readonly pressureRange: ToolPressureRange | null;
    };
export type NetworkToolCommand =
  | { readonly kind: 'viewport'; readonly centerX: number; readonly centerY: number; readonly zoom: number }
  | { readonly kind: 'motor-control'; readonly id: string; readonly control: ToolMotorControl }
  | {
      readonly kind: 'switch-output';
      readonly id: string;
      readonly output: ({ readonly mode: 'switch' | 'analog' } & ToolPressureRange) | null;
    }
  | { readonly kind: 'probe-edit'; readonly edit: NetworkToolProbeEdit }
  | { readonly kind: 'controller-program'; readonly id: string; readonly program: NetworkSequence | null }
  | {
      readonly kind: 'branch-connect';
      readonly from: NetworkConnectionAnchor;
      readonly to: NetworkConnectionAnchor;
      readonly idPrefix: string;
    }
  | {
      readonly kind: 'rotate';
      readonly selection: readonly NetworkSelection[];
      readonly direction: 'clockwise' | 'counterclockwise';
    }
  | { readonly kind: 'mirror' | 'delete-selection'; readonly selection: readonly NetworkSelection[] }
  | {
      readonly kind: 'move-selection';
      readonly selection: readonly NetworkSelection[];
      readonly delta: { readonly x: number; readonly y: number };
    }
  | {
      readonly kind: 'copy-selection';
      readonly selection: readonly NetworkSelection[];
      readonly point: { readonly x: number; readonly y: number };
      readonly ids: Required<NetworkPasteIds>;
    }
  | { readonly kind: 'text'; readonly edit: NetworkTextEdit }
  | {
      readonly kind: 'project-parameter' | 'initial-parameter' | 'pipe-parameter';
      readonly id: string;
      readonly key: string;
      readonly value: number | null;
    }
  | {
      readonly kind: 'add-component';
      readonly id: string;
      readonly definitionId: string;
      readonly definitionVersion: number;
      readonly label: string;
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: 'add-node'; readonly id: string; readonly label: string; readonly x: number; readonly y: number }
  | { readonly kind: 'move'; readonly id: string; readonly x: number; readonly y: number }
  | {
      readonly kind: 'parameter';
      readonly id: string;
      readonly group: string;
      readonly key: string;
      readonly value: number;
    }
  | {
      readonly kind: 'connect';
      readonly id: string;
      readonly from: NetworkEndpoint;
      readonly to: NetworkEndpoint;
      readonly pipe: null | {
        readonly internalDiameterM: number;
        readonly lengthM: number;
        readonly roughnessM: number;
        readonly localLossCoefficient: number;
      };
    }
  | { readonly kind: 'remove'; readonly target: 'component' | 'node' | 'connection'; readonly id: string }
  | { readonly kind: 'route'; readonly route: NetworkRoute }
  | { readonly kind: 'arrange'; readonly request: NetworkLayoutRequest };
export interface NetworkToolEditPlan {
  readonly document: NetworkProject;
  readonly physical: boolean;
  readonly commands: readonly NetworkToolCommand[];
  readonly changes: readonly {
    readonly section: string;
    readonly id: string;
    readonly before: unknown;
    readonly after: unknown;
  }[];
}
const failure = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('TOOL_COMMAND_INVALID', '/commands', message)],
});
/** Closed command vocabulary; every intermediate candidate is parsed, and the whole batch commits once. */
export function planNetworkToolCommands(input: unknown, rawCommands: unknown): Result<NetworkToolEditPlan> {
  const document = parseNetworkProject(input);
  if (!document.ok) return document;
  const safe = checkJson(rawCommands);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    items = r.array(rawCommands, '/commands', networkToolCommandLimit);
  if (r.diagnostics.length) return { ok: false, diagnostics: r.diagnostics };
  if (!items.length) return failure('编辑批至少需要一条命令。');
  let current = document.value;
  const commands: NetworkToolCommand[] = [];
  const coordinates = (o: Record<string, unknown>, p: string) => ({
    x: r.number(o.x, p + '/x', -1e6, 1e6),
    y: r.number(o.y, p + '/y', -1e6, 1e6),
  });
  for (const [i, raw] of items.entries()) {
    const p = '/commands/' + i,
      o = r.object(raw, p, [
        'kind',
        'id',
        'definitionId',
        'definitionVersion',
        'label',
        'x',
        'y',
        'group',
        'key',
        'value',
        'from',
        'to',
        'pipe',
        'target',
        'route',
        'request',
        'selection',
        'direction',
        'delta',
        'point',
        'ids',
        'edit',
        'program',
        'control',
        'output',
        'idPrefix',
        'centerX',
        'centerY',
        'zoom',
      ]);
    let command: NetworkToolCommand, candidate: unknown;
    if (o.kind === 'viewport') {
      r.object(raw, p, ['kind', 'centerX', 'centerY', 'zoom']);
      const viewport = {
        centerX: r.number(o.centerX, p + '/centerX', -1e6, 1e6),
        centerY: r.number(o.centerY, p + '/centerY', -1e6, 1e6),
        zoom: r.number(o.zoom, p + '/zoom', 0.0001, 8),
      };
      command = { kind: 'viewport', ...viewport };
      candidate = { ...current, layout: { ...current.layout, viewport } };
    } else if (o.kind === 'motor-control' || o.kind === 'switch-output') {
      const kind = o.kind;
      r.object(raw, p, ['kind', 'id', kind === 'motor-control' ? 'control' : 'output']);
      const id = r.id(o.id, p + '/id'),
        target = current.design.components.find((c) => c.id === id);
      if (!target) return failure('结构化参数目标元件不存在。');
      let replacement: NetworkComponent;
      if (kind === 'motor-control') {
        if (target.definition.id !== 'teaching:variable-motor') return failure('只有变量液压马达支持此控制配置。');
        const min = target.parameters.hydraulic?.minimumDisplacementM3PerRev,
          max = target.parameters.hydraulic?.maximumDisplacementM3PerRev;
        if (min === undefined || max === undefined) return failure('变量马达缺少合法排量范围。');
        const parsed = readToolMotorControl(r, o.control, p + '/control', { min, max });
        if (!parsed.ok) return parsed;
        command = { kind, id, control: parsed.value };
        const { motorDisplacementCurve: _curve, externalMotorControl: _external, ...rest } = target;
        const control = command.control;
        replacement = {
          ...rest,
          ...(control.curve ? { motorDisplacementCurve: control.curve } : {}),
          ...(control.mode === 'external-pressure'
            ? { externalMotorControl: { kind: 'pressure' as const, ...control.pressureRange } }
            : control.mode === 'external-voltage'
              ? { externalMotorControl: { kind: 'voltage' as const, ...(control.pressureRange ?? {}) } }
              : {}),
        };
      } else {
        if (target.typeId !== 'adjustable-pressure-switch') return failure('只有压力开关支持输出配置。');
        let output: Extract<NetworkToolCommand, { kind: 'switch-output' }>['output'] = null;
        if (o.output !== null) {
          const q = p + '/output',
            input = r.object(o.output, q, ['mode', 'lowPa', 'highPa']);
          if (input.mode !== 'switch' && input.mode !== 'analog') return failure('压力开关输出模式无效。');
          output = { mode: input.mode, ...readToolPressureRange(r, o.output, q, ['mode', 'lowPa', 'highPa']) };
        }
        command = { kind, id, output };
        const checked = r.finish(command);
        if (!checked.ok) return checked;
        const { pressureSwitchOutput: _output, ...rest } = target;
        replacement = { ...rest, ...(output ? { pressureSwitchOutput: output } : {}) };
      }
      candidate = {
        ...current,
        design: {
          ...current.design,
          components: current.design.components.map((c) => (c.id === id ? replacement : c)),
        },
      };
    } else if (o.kind === 'probe-edit') {
      r.object(raw, p, ['kind', 'edit']);
      const edit = readToolProbe(r, o.edit, p + '/edit');
      if (!edit.ok) return edit;
      command = { kind: 'probe-edit', edit: edit.value };
      const probeEdit = command.edit;
      const planned = planNetworkProbe(
        current,
        probeEdit.kind === 'configure'
          ? {
              kind: 'configure',
              id: probeEdit.id,
              name: probeEdit.name,
              nodeId: probeEdit.target.kind === 'node' ? probeEdit.target.nodeId : null,
              ...(probeEdit.target.kind === 'port' ? { port: probeEdit.target } : {}),
            }
          : probeEdit,
      );
      if (!planned.ok) return planned;
      candidate = planned.value;
    } else if (o.kind === 'controller-program') {
      r.object(raw, p, ['kind', 'id', 'program']);
      command = {
        kind: 'controller-program',
        id: r.id(o.id, p + '/id'),
        program: o.program === null ? null : readNetworkSequence(r, o.program, p + '/program'),
      };
      const checked = r.finish(command);
      if (!checked.ok) return checked;
      const planned = planNetworkSequence(current, command.id, command.program);
      if (!planned.ok) return planned;
      candidate = planned.value;
    } else if (o.kind === 'branch-connect') {
      r.object(raw, p, ['kind', 'from', 'to', 'idPrefix']);
      command = {
        kind: 'branch-connect',
        from: readToolAnchor(r, o.from, p + '/from'),
        to: readToolAnchor(r, o.to, p + '/to'),
        idPrefix: r.id(o.idPrefix, p + '/idPrefix'),
      };
      const checked = r.finish(command);
      if (!checked.ok) return checked;
      const planned = planNetworkBranchConnection(current, {
        from: command.from,
        to: command.to,
        idPrefix: command.idPrefix,
      });
      if (!planned.ok) return planned;
      candidate = planned.value.document;
    } else if (
      o.kind === 'rotate' ||
      o.kind === 'mirror' ||
      o.kind === 'move-selection' ||
      o.kind === 'delete-selection' ||
      o.kind === 'copy-selection'
    ) {
      const kind = o.kind;
      r.object(raw, p, [
        'kind',
        'selection',
        ...(kind === 'rotate'
          ? ['direction']
          : kind === 'move-selection'
            ? ['delta']
            : kind === 'copy-selection'
              ? ['point', 'ids']
              : []),
      ]);
      const selection: NetworkSelection[] = [];
      for (const [index, item] of r.array(o.selection, p + '/selection', 100).entries()) {
        const q = p + '/selection/' + index,
          value = r.object(item, q, ['kind', 'id']),
          id = r.id(value.id, q + '/id');
        if (
          value.kind !== 'component' &&
          value.kind !== 'node' &&
          value.kind !== 'connection' &&
          value.kind !== 'probe' &&
          value.kind !== 'text'
        )
          return failure('选择对象种类不受支持。');
        const target = { kind: value.kind, id };
        if ((kind === 'rotate' || kind === 'mirror') && target.kind !== 'component')
          return failure('旋转与左右镜像仅支持元件。');
        if (kind === 'move-selection' && target.kind === 'connection') return failure('移动选区不接受独立连线。');
        const exists =
          target.kind === 'component'
            ? current.design.components.some((v) => v.id === id)
            : target.kind === 'node'
              ? current.design.nodes.some((v) => v.id === id)
              : target.kind === 'connection'
                ? current.design.connections.some((v) => v.id === id)
                : target.kind === 'probe'
                  ? (current.controlProbes ?? []).some((v) => v.id === id)
                  : (current.layout.texts ?? []).some((v) => v.id === id);
        if (!exists || selection.some((v) => v.kind === target.kind && v.id === id))
          return failure('选择对象不存在或重复。');
        selection.push({ kind: value.kind, id });
      }
      if (!selection.length) return failure('选区至少需要一个对象。');
      if (kind === 'rotate') {
        if (o.direction !== 'clockwise' && o.direction !== 'counterclockwise') return failure('旋转方向无效。');
        command = { kind, selection, direction: o.direction };
      } else if (kind === 'move-selection') {
        command = { kind, selection, delta: coordinates(r.object(o.delta, p + '/delta', ['x', 'y']), p + '/delta') };
      } else if (kind === 'copy-selection') {
        const point = coordinates(r.object(o.point, p + '/point', ['x', 'y']), p + '/point');
        const values = r.object(o.ids, p + '/ids', ['components', 'nodes', 'connections', 'texts', 'probes']);
        const ids = (name: string) =>
          r.array(values[name], p + '/ids/' + name, 1000).map((v, i) => r.id(v, p + '/ids/' + name + '/' + i));
        command = {
          kind,
          selection,
          point,
          ids: {
            components: ids('components'),
            nodes: ids('nodes'),
            connections: ids('connections'),
            texts: ids('texts'),
            probes: ids('probes'),
          },
        };
      } else command = { kind, selection };
      const parsedCommand = r.finish(command);
      if (!parsedCommand.ok) return parsedCommand;
      if (command.kind === 'move-selection')
        candidate = networkMoveSelection(current, command.selection, command.delta);
      else if (command.kind === 'copy-selection') {
        if (
          command.selection.some(
            (target) =>
              target.kind === 'component' &&
              current.design.components.some((item) => item.id === target.id && item.controller !== undefined),
          )
        )
          return {
            ok: false,
            diagnostics: [
              diagnostic(
                'CLIPBOARD_UNSUPPORTED',
                '/commands',
                'MCP 暂不复制包含控制程序的元件；程序引用尚未重映射，原工程保留。',
              ),
            ],
          };
        const copied = captureNetworkSelection(current, command.selection);
        if (!copied.ok) return copied;
        const pasted = planNetworkPaste(current, copied.value, command.point, command.ids);
        if (!pasted.ok) return pasted;
        candidate = pasted.value.document;
      } else {
        const planned =
          command.kind === 'rotate'
            ? networkRotateSelection(current, command.selection, command.direction)
            : command.kind === 'mirror'
              ? networkFlipSelection(current, command.selection)
              : planNetworkDeleteSelection(current, command.selection);
        if (!planned.ok) return planned;
        candidate = planned.value;
      }
    } else if (o.kind === 'text') {
      r.object(raw, p, ['kind', 'edit']);
      const value = r.object(o.edit, p + '/edit', ['kind', 'value', 'replace', 'id']);
      let edit: NetworkTextEdit;
      if (value.kind === 'delete') {
        r.object(o.edit, p + '/edit', ['kind', 'id']);
        edit = { kind: 'delete', id: r.id(value.id, p + '/edit/id') };
      } else if (value.kind === 'put') {
        r.object(o.edit, p + '/edit', ['kind', 'value', 'replace']);
        if (typeof value.replace !== 'boolean') return failure('文本替换标记必须为布尔值。');
        // Reuse the domain text reader via the public project parser, including normalization and coupled limits.
        const textProject = parseNetworkProject({ ...current, layout: { ...current.layout, texts: [value.value] } });
        if (!textProject.ok) return textProject;
        const text = textProject.value.layout.texts?.[0];
        if (!text) return failure('文本标注缺失。');
        edit = { kind: 'put', value: text, replace: value.replace };
      } else return failure('文本操作不受支持。');
      command = { kind: 'text', edit };
      const fields = r.finish(command);
      if (!fields.ok) return fields;
      const planned = planNetworkText(current, edit);
      if (!planned.ok) return planned;
      candidate = planned.value;
    } else if (o.kind === 'add-component') {
      r.object(raw, p, ['kind', 'id', 'definitionId', 'definitionVersion', 'label', 'x', 'y']);
      const id = r.id(o.id, p + '/id'),
        definitionId = r.text(o.definitionId, p + '/definitionId', 1, 100),
        definitionVersion = r.number(o.definitionVersion, p + '/definitionVersion', 1, 10000),
        label = r.text(o.label, p + '/label', 1, 100),
        position = coordinates(o, p);
      const def = networkCreationDefinitions.find((d) => d.id === definitionId && d.version === definitionVersion);
      if (!def) return failure('只能使用目录中明确版本的已支持创建预设。');
      const component = {
        id,
        typeId: def.typeId,
        definition: { id: def.id, version: def.version },
        model: { id: def.model.id, version: def.model.version },
        label,
        parameters: networkCreationParameters(def, current.design.fluid.densityKgPerM3),
      };
      const initial = networkInitialFor(component);
      if (!initial.ok) return initial;
      command = { kind: 'add-component', id, definitionId, definitionVersion, label, ...position };
      candidate = {
        ...current,
        design: {
          ...current.design,
          components: [...current.design.components, component],
          initialConditions: initial.value
            ? [...current.design.initialConditions, initial.value]
            : current.design.initialConditions,
        },
        layout: { ...current.layout, components: [...current.layout.components, { componentId: id, ...position }] },
      };
    } else if (o.kind === 'add-node') {
      r.object(raw, p, ['kind', 'id', 'label', 'x', 'y']);
      const id = r.id(o.id, p + '/id'),
        label = r.text(o.label, p + '/label', 1, 100),
        position = coordinates(o, p);
      command = { kind: 'add-node', id, label, ...position };
      candidate = {
        ...current,
        design: { ...current.design, nodes: [...current.design.nodes, { id, kind: 'ideal-hydraulic', label }] },
        layout: { ...current.layout, nodes: [...current.layout.nodes, { nodeId: id, ...position }] },
      };
    } else if (o.kind === 'move') {
      r.object(raw, p, ['kind', 'id', 'x', 'y']);
      const id = r.id(o.id, p + '/id'),
        position = coordinates(o, p);
      if (!current.design.components.some((c) => c.id === id)) return failure('移动目标元件不存在。');
      command = { kind: 'move', id, ...position };
      candidate = {
        ...current,
        layout: {
          ...current.layout,
          components: current.layout.components.map((c) => (c.componentId === id ? { ...c, ...position } : c)),
        },
      };
    } else if (o.kind === 'parameter') {
      r.object(raw, p, ['kind', 'id', 'group', 'key', 'value']);
      const id = r.id(o.id, p + '/id'),
        group = r.id(o.group, p + '/group'),
        key = r.id(o.key, p + '/key'),
        value = r.number(o.value, p + '/value', -Number.MAX_VALUE, Number.MAX_VALUE);
      const target = current.design.components.find((c) => c.id === id);
      if (!target || target.parameters[group]?.[key] === undefined)
        return failure('所选参数不存在；不能创建未注册的物理字段。');
      command = { kind: 'parameter', id, group, key, value };
      candidate = {
        ...current,
        design: {
          ...current.design,
          components: current.design.components.map((c) =>
            c.id === id
              ? { ...c, parameters: { ...c.parameters, [group]: { ...c.parameters[group], [key]: value } } }
              : c,
          ),
        },
      };
    } else if (o.kind === 'project-parameter' || o.kind === 'initial-parameter' || o.kind === 'pipe-parameter') {
      r.object(raw, p, ['kind', 'id', 'key', 'value']);
      const id = r.id(o.id, p + '/id'),
        key = r.id(o.key, p + '/key'),
        value = o.value === null ? null : r.number(o.value, p + '/value', -Number.MAX_VALUE, Number.MAX_VALUE),
        target = o.kind === 'project-parameter' ? 'project' : o.kind === 'initial-parameter' ? 'initial' : 'pipe';
      if (!networkToolParameterRows(current).some((row) => row.target === target && row.id === id && row.key === key))
        return failure('目标或数值参数不存在；请读取当前参数清单，不接受未知字段或阀位枚举。');
      command = { kind: o.kind, id, key, value };
      candidate = {
        ...current,
        design: {
          ...current.design,
          ...(target === 'project' ? { fluid: { ...current.design.fluid, [key]: value } } : {}),
          ...(target === 'initial'
            ? {
                initialConditions: current.design.initialConditions.map((i) =>
                  i.componentId === id ? { ...i, [key]: value } : i,
                ),
              }
            : {}),
          ...(target === 'pipe'
            ? {
                connections: current.design.connections.map((c) =>
                  c.id === id && c.kind === 'pipe' ? { ...c, parameters: { ...c.parameters, [key]: value } } : c,
                ),
              }
            : {}),
        },
      };
    } else if (o.kind === 'connect') {
      r.object(raw, p, ['kind', 'id', 'from', 'to', 'pipe']);
      const endpoint = (value: unknown, q: string): NetworkEndpoint => {
        const e = r.object(value, q, ['kind', 'componentId', 'portId', 'nodeId']);
        if (e.kind === 'node') {
          r.object(value, q, ['kind', 'nodeId']);
          return { kind: 'node', nodeId: r.id(e.nodeId, q + '/nodeId') };
        }
        r.object(value, q, ['kind', 'componentId', 'portId']);
        r.constant(e.kind, 'port', q + '/kind');
        return {
          kind: 'port',
          componentId: r.id(e.componentId, q + '/componentId'),
          portId: r.id(e.portId, q + '/portId'),
        };
      };
      const id = r.id(o.id, p + '/id'),
        from = endpoint(o.from, p + '/from'),
        to = endpoint(o.to, p + '/to');
      let pipe: Extract<NetworkToolCommand, { kind: 'connect' }>['pipe'] = null;
      if (o.pipe !== null) {
        const q = p + '/pipe',
          v = r.object(o.pipe, q, ['internalDiameterM', 'lengthM', 'roughnessM', 'localLossCoefficient']);
        pipe = {
          internalDiameterM: r.number(v.internalDiameterM, q + '/internalDiameterM', 0.002, 0.2),
          lengthM: r.number(v.lengthM, q + '/lengthM', 0, 1000),
          roughnessM: r.number(v.roughnessM, q + '/roughnessM', 0, 0.001),
          localLossCoefficient: r.number(v.localLossCoefficient, q + '/localLossCoefficient', 0, 1000),
        };
      }
      command = { kind: 'connect', id, from, to, pipe };
      candidate = {
        ...current,
        design: {
          ...current.design,
          connections: [
            ...current.design.connections,
            pipe
              ? { id, from, to, kind: 'pipe', model: physicalPipeModel, parameters: pipe }
              : { id, from, to, kind: 'ideal' },
          ],
        },
        layout: { ...current.layout, routes: [...current.layout.routes, { connectionId: id, mode: 'auto' }] },
      };
    } else if (o.kind === 'remove') {
      r.object(raw, p, ['kind', 'target', 'id']);
      const id = r.id(o.id, p + '/id'),
        target = o.target;
      if (target !== 'component' && target !== 'node' && target !== 'connection')
        return failure('删除目标种类不受支持。');
      const exists =
        target === 'component'
          ? current.design.components.some((c) => c.id === id)
          : target === 'node'
            ? current.design.nodes.some((n) => n.id === id)
            : current.design.connections.some((e) => e.id === id);
      if (!exists) return failure('删除目标不存在。');
      const touches = (e: NetworkEndpoint) =>
        e.kind === 'node' ? target === 'node' && e.nodeId === id : target === 'component' && e.componentId === id;
      const connections = current.design.connections.filter(
        (e) => !(target === 'connection' && e.id === id) && !touches(e.from) && !touches(e.to),
      );
      command = { kind: 'remove', target, id };
      candidate = {
        ...current,
        design: {
          ...current.design,
          components: current.design.components.filter((c) => target !== 'component' || c.id !== id),
          nodes: current.design.nodes.filter((n) => target !== 'node' || n.id !== id),
          connections,
          initialConditions: current.design.initialConditions.filter(
            (c) => target !== 'component' || c.componentId !== id,
          ),
        },
        layout: {
          ...current.layout,
          components: current.layout.components.filter((c) => target !== 'component' || c.componentId !== id),
          nodes: current.layout.nodes.filter((n) => target !== 'node' || n.nodeId !== id),
          routes: current.layout.routes.filter((r) => connections.some((e) => e.id === r.connectionId)),
        },
      };
    } else if (o.kind === 'route') {
      r.object(raw, p, ['kind', 'route']);
      const q = p + '/route',
        v = r.object(o.route, q, ['connectionId', 'mode', 'points']),
        id = r.id(v.connectionId, q + '/connectionId');
      if (!current.design.connections.some((e) => e.id === id)) return failure('路线目标不存在。');
      let route: NetworkRoute;
      if (v.mode === 'manual') {
        const points = r.array(v.points, q + '/points', 64).map((p, i) => {
          const v = r.object(p, q + '/points/' + i, ['x', 'y']);
          return coordinates(v, q + '/points/' + i);
        });
        if (!points.length) return failure('手动路径至少一个锚点。');
        route = { connectionId: id, mode: 'manual', points };
      } else {
        r.object(o.route, q, ['connectionId', 'mode']);
        if (v.mode !== 'auto' && v.mode !== 'avoid') return failure('路线模式不受支持。');
        route = { connectionId: id, mode: v.mode };
      }
      command = { kind: 'route', route };
      candidate = {
        ...current,
        layout: { ...current.layout, routes: current.layout.routes.map((r) => (r.connectionId === id ? route : r)) },
      };
    } else if (o.kind === 'arrange') {
      r.object(raw, p, ['kind', 'request']);
      const request = r.object(o.request, p + '/request', ['kind', 'connectionIds']);
      if (request.kind !== 'routing') return failure('自动摆放已移除；仅支持自动管线避障，元件和节点位置保持。');
      const layout = planNetworkLayout(current, o.request);
      if (!layout.ok) return layout;
      command = { kind: 'arrange', request: layout.value.request };
      candidate = layout.value.document;
    } else return failure('未知编辑命令；不接受脚本、路径、IPC、求解器或任意文档替换。');
    const fields = r.finish(command);
    if (!fields.ok) return fields;
    const parsed = parseNetworkProject(candidate);
    if (!parsed.ok) return parsed;
    current = parsed.value;
    if (command.kind === 'route' && command.route.mode === 'avoid') {
      const routed = networkDrawingRoute(current, command.route.connectionId);
      if (!routed.ok) return routed;
    }
    commands.push(fields.value);
  }
  const constraints = checkNetworkParameterRules(document.value, current);
  if (!constraints.ok) return constraints;
  return {
    ok: true,
    value: {
      document: current,
      physical: canonical(networkPhysicalDesign(document.value)) !== canonical(networkPhysicalDesign(current)),
      commands,
      changes: networkToolChanges(document.value, current),
    },
  };
}
export function networkToolChanges(before: NetworkProject, after: NetworkProject): NetworkToolEditPlan['changes'] {
  const changes: NetworkToolEditPlan['changes'][number][] = [];
  const section = (
    name: string,
    before: readonly { readonly id: string }[],
    after: readonly { readonly id: string }[],
  ) => {
    for (const id of new Set([...before, ...after].map((v) => v.id))) {
      const a = before.find((v) => v.id === id) ?? null,
        b = after.find((v) => v.id === id) ?? null;
      if (canonical(a) !== canonical(b)) changes.push({ section: name, id, before: a, after: b });
    }
  };
  section('components', before.design.components, after.design.components);
  section('nodes', before.design.nodes, after.design.nodes);
  section('connections', before.design.connections, after.design.connections);
  section('controlProbes', before.controlProbes ?? [], after.controlProbes ?? []);
  for (const [name, a, b] of [
    ['fluid', before.design.fluid, after.design.fluid],
    ['layout', before.layout, after.layout],
    ['initialConditions', before.design.initialConditions, after.design.initialConditions],
  ] as const)
    if (canonical(a) !== canonical(b)) changes.push({ section: name, id: 'document', before: a, after: b });
  return changes;
}

/** Closed external probe vocabulary; the planner retains engineering/reference rules. */
function readToolProbe(r: ContractReader, input: unknown, p: string): Result<NetworkToolProbeEdit> {
  const o = r.object(input, p, ['kind', 'id', 'controllerId', 'x', 'y', 'points', 'name', 'target']);
  const id = r.id(o.id, p + '/id');
  const position = () => ({ x: r.number(o.x, p + '/x', -1e6, 1e6), y: r.number(o.y, p + '/y', -1e6, 1e6) });
  if (o.kind === 'add-gauge' || o.kind === 'move') {
    r.object(input, p, ['kind', 'id', 'x', 'y']);
    return r.finish({ kind: o.kind, id, ...position() });
  }
  if (o.kind === 'add' || o.kind === 'add-near') {
    r.object(input, p, ['kind', 'id', 'controllerId', ...(o.kind === 'add' ? ['x', 'y'] : [])]);
    const controllerId = r.id(o.controllerId, p + '/controllerId');
    return o.kind === 'add'
      ? r.finish({ kind: 'add', id, controllerId, ...position() })
      : r.finish({ kind: 'add-near', id, controllerId });
  }
  if (o.kind === 'delete') {
    r.object(input, p, ['kind', 'id']);
    return r.finish({ kind: 'delete', id });
  }
  if (o.kind === 'rename-controller') {
    r.object(input, p, ['kind', 'id', 'name']);
    return r.finish({ kind: 'rename-controller', id, name: r.text(o.name, p + '/name', 1, 100) });
  }
  if (o.kind === 'route') {
    r.object(input, p, ['kind', 'id', 'points']);
    const points = r.array(o.points, p + '/points', 64).map((v, i) => {
      const q = p + '/points/' + i,
        point = r.object(v, q, ['x', 'y']);
      return { x: r.number(point.x, q + '/x', -1e6, 1e6), y: r.number(point.y, q + '/y', -1e6, 1e6) };
    });
    if (!points.length) return failure('压力表引线至少需要一个绘图点。');
    return r.finish({ kind: 'route', id, points });
  }
  if (o.kind === 'configure') {
    r.object(input, p, ['kind', 'id', 'name', 'target']);
    const name = r.text(o.name, p + '/name', 0, 60),
      q = p + '/target',
      target = r.object(o.target, q, ['kind', 'nodeId', 'componentId', 'portId']);
    if (target.kind === 'disconnected') {
      r.object(o.target, q, ['kind']);
      return r.finish({ kind: 'configure', id, name, target: { kind: 'disconnected' } });
    }
    if (target.kind === 'node') {
      r.object(o.target, q, ['kind', 'nodeId']);
      return r.finish({
        kind: 'configure',
        id,
        name,
        target: { kind: 'node', nodeId: r.id(target.nodeId, q + '/nodeId') },
      });
    }
    r.object(o.target, q, ['kind', 'componentId', 'portId']);
    r.constant(target.kind, 'port', q + '/kind');
    return r.finish({
      kind: 'configure',
      id,
      name,
      target: {
        kind: 'port',
        componentId: r.id(target.componentId, q + '/componentId'),
        portId: r.id(target.portId, q + '/portId'),
      },
    });
  }
  return failure('未知压力表/控制器编辑操作。');
}
function readToolAnchor(r: ContractReader, input: unknown, p: string): NetworkConnectionAnchor {
  const o = r.object(input, p, ['kind', 'nodeId', 'componentId', 'portId', 'connectionId', 'point']);
  if (o.kind === 'route') {
    r.object(input, p, ['kind', 'connectionId', 'point']);
    const point = r.object(o.point, p + '/point', ['x', 'y']);
    return {
      kind: 'route',
      connectionId: r.id(o.connectionId, p + '/connectionId'),
      point: { x: r.number(point.x, p + '/point/x', -1e6, 1e6), y: r.number(point.y, p + '/point/y', -1e6, 1e6) },
    };
  }
  if (o.kind === 'node') {
    r.object(input, p, ['kind', 'nodeId']);
    return { kind: 'node', nodeId: r.id(o.nodeId, p + '/nodeId') };
  }
  r.object(input, p, ['kind', 'componentId', 'portId']);
  r.constant(o.kind, 'port', p + '/kind');
  return { kind: 'port', componentId: r.id(o.componentId, p + '/componentId'), portId: r.id(o.portId, p + '/portId') };
}

function readToolPressureRange(
  r: ContractReader,
  input: unknown,
  p: string,
  keys: readonly string[] = ['lowPa', 'highPa'],
): ToolPressureRange {
  const o = r.object(input, p, keys),
    lowPa = r.number(o.lowPa, p + '/lowPa', -1e8, 70e6),
    highPa = r.number(o.highPa, p + '/highPa', -1e8, 70e6);
  if (highPa <= lowPa) r.fail('PARAMETER_INVALID', p, '控制压力上限必须高于下限。');
  return { lowPa, highPa };
}
function readToolMotorControl(
  r: ContractReader,
  input: unknown,
  p: string,
  range: { readonly min: number; readonly max: number },
): Result<ToolMotorControl> {
  const o = r.object(input, p, ['mode', 'curve', 'pressureRange']);
  if (o.mode !== 'manual' && o.mode !== 'curve' && o.mode !== 'external-pressure' && o.mode !== 'external-voltage')
    return failure('变量马达控制模式无效。');
  const mode = o.mode;
  r.object(input, p, [
    'mode',
    'curve',
    ...(mode === 'external-pressure' || mode === 'external-voltage' ? ['pressureRange'] : []),
  ]);
  const curve = o.curve === null ? null : readMotorDisplacementCurve(r, o.curve, p + '/curve', range);
  if (mode === 'curve' ? !curve?.enabled : curve?.enabled)
    return failure('自身曲线模式必须提供已启用曲线；其他模式的保留曲线必须禁用。');
  if (mode === 'external-pressure')
    return r.finish({ mode, curve, pressureRange: readToolPressureRange(r, o.pressureRange, p + '/pressureRange') });
  if (mode === 'external-voltage')
    return r.finish({
      mode,
      curve,
      pressureRange: o.pressureRange === null ? null : readToolPressureRange(r, o.pressureRange, p + '/pressureRange'),
    });
  return r.finish({ mode, curve });
}
