import {
  checkJson,
  componentNames,
  ContractReader,
  defaultDefinitionId,
  isComponentType,
  parseDocument,
  specs,
  toSI,
  type ProjectDocument,
  type Result,
} from '@hyd/domain';
import { sizeCylinder } from '@hyd/engineering';
import { copyDocument } from './content.js';

export function applyCommand(document: ProjectDocument, input: unknown): Result<ProjectDocument> {
  return apply(document, input, true);
}

// Only a bounded property group may defer validation. The complete candidate is
// parsed once, so related dimensions can change together in one history entry.
function apply(document: ProjectDocument, input: unknown, validate: boolean): Result<ProjectDocument> {
  const budget = checkJson(input);
  if (!budget.ok) return budget;
  const r = new ContractReader();
  const raw = r.object(input, '/command', [
    'type',
    'id',
    'target',
    'key',
    'value',
    'x',
    'y',
    'typeId',
    'from',
    'to',
    'definitionId',
    'initial',
    'requirements',
    'commands',
  ]);
  const candidate = copyDocument(document);
  const id = typeof raw.id === 'string' ? raw.id : '';
  const c = candidate.design.components.find((c) => c.id === id);
  const w = candidate.design.connections.find((w) => w.id === id);
  const missing = () => r.fail('REFERENCE_INVALID', '/command/id', '命令引用的对象不存在。');
  const number = (key: string) => r.number(raw[key], `/command/${key}`, -Number.MAX_VALUE, Number.MAX_VALUE);
  const defaults = (group: string) =>
    Object.fromEntries(specs(group).map((s) => [s.key, toSI(s.quantity, s.defaultValue)]));
  const allowed: Record<string, readonly string[]> = {
    'set-title': ['value'],
    'set-label': ['id', 'value'],
    'move-component': ['id', 'x', 'y'],
    'set-parameter': ['target', 'id', 'key', 'value'],
    'set-definition': ['id', 'definitionId'],
    'set-initial': ['id', 'initial'],
    'add-component': ['id', 'typeId', 'x', 'y'],
    'add-connection': ['id', 'from', 'to'],
    delete: ['id', 'target'],
    'apply-sizing': ['requirements'],
    'apply-properties': ['commands'],
  };
  if (typeof raw.type !== 'string' || !allowed[raw.type]) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'COMMAND_UNSUPPORTED',
          severity: 'error',
          field: '/command/type',
          message: '命令类型不受支持。',
          suggestion: '使用公开的编辑命令。',
        },
      ],
    };
  }
  r.object(input, '/command', ['type', ...(allowed[raw.type] ?? [])]);
  switch (raw.type) {
    case 'apply-properties': {
      if (!validate || !Array.isArray(raw.commands) || !raw.commands.length || raw.commands.length > 32)
        return {
          ok: false,
          diagnostics: [
            {
              code: 'COMMAND_GROUP_INVALID',
              severity: 'error',
              field: '/command/commands',
              message: '属性组须有1至32项修改，不能嵌套。',
              suggestion: '提交一个有界属性组。',
            },
          ],
        };
      let grouped: ProjectDocument = candidate;
      for (const command of raw.commands) {
        if (
          !command ||
          typeof command !== 'object' ||
          !['set-title', 'set-parameter', 'set-label', 'set-definition', 'set-initial'].includes(command.type)
        )
          return {
            ok: false,
            diagnostics: [
              {
                code: 'COMMAND_GROUP_INVALID',
                severity: 'error',
                field: '/command/commands',
                message: '属性组只接受参数、名称、定义及初态修改。',
                suggestion: '使用允许的属性命令。',
              },
            ],
          };
        const next = apply(grouped, command, false);
        if (!next.ok) return next;
        grouped = next.value;
      }
      return parseDocument(grouped);
    }
    case 'set-title':
      candidate.title = r.text(raw.value, '/command/value', 1, 100);
      break;
    case 'set-label':
      if (!c) missing();
      else c.label = r.text(raw.value, '/command/value', 0, 60);
      break;
    case 'move-component': {
      const position = candidate.layout.components.find((p) => p.componentId === id);
      if (!position) missing();
      else {
        position.x = number('x');
        position.y = number('y');
      }
      break;
    }
    case 'set-parameter': {
      const target =
        raw.target === 'fluid'
          ? candidate.design.fluid
          : raw.target === 'component'
            ? c?.params
            : raw.target === 'connection'
              ? w?.params
              : undefined;
      if (!target) missing();
      else {
        const key = r.text(raw.key, '/command/key', 1, 100);
        if (!Object.hasOwn(target, key)) r.fail('UNKNOWN_FIELD', '/command/key', '未注册的物理参数不能写入工程。');
        else target[key] = number('value');
      }
      break;
    }
    case 'set-definition':
      if (!c || c.typeId !== 'valve') missing();
      else c.definitionId = r.text(raw.definitionId, '/command/definitionId', 1, 100);
      break;
    case 'set-initial': {
      if (!c) {
        missing();
        break;
      }
      const initial = r.object(
        raw.initial,
        '/command/initial',
        c.typeId === 'valve' ? ['positionId'] : c.typeId === 'cylinder' ? ['positionM'] : ['angleRad'],
      );
      if (c.typeId === 'valve') {
        const value = initial.positionId;
        if (value !== 'extend' && value !== 'neutral' && value !== 'retract')
          r.fail('CONTROL_INVALID', '/command/initial', '未知实例初始阀位。');
        else
          candidate.design.initialConditions.valves = candidate.design.initialConditions.valves.map((v) =>
            v.componentId === id ? { ...v, positionId: value } : v,
          );
      } else if (c.typeId === 'cylinder' || c.typeId === 'motor') {
        const value =
          c.typeId === 'cylinder'
            ? {
                componentId: id,
                kind: 'cylinder' as const,
                positionM: r.number(initial.positionM, '/command/initial/positionM', 0, Number.MAX_VALUE),
              }
            : {
                componentId: id,
                kind: 'motor' as const,
                angleRad: r.number(initial.angleRad, '/command/initial/angleRad', -1e9, 1e9),
              };
        candidate.design.initialConditions.actuators = candidate.design.initialConditions.actuators.map((a) =>
          a.componentId === id ? value : a,
        );
      } else r.fail('INITIAL_CONDITION_INVALID', '/command/id', '此元件没有可编辑的执行器或阀初态。');
      break;
    }
    case 'add-component': {
      const typeId = raw.typeId;
      if (!isComponentType(typeId)) {
        r.fail('MODEL_UNSUPPORTED', '/command/typeId', '未知元件类型。');
        break;
      }
      const newId = r.id(raw.id, '/command/id');
      candidate.design.components.push({
        id: newId,
        typeId,
        definitionId: defaultDefinitionId(typeId),
        definitionVersion: 1,
        label: componentNames[typeId],
        params: defaults(typeId),
      });
      candidate.layout.components.push({ componentId: newId, x: number('x'), y: number('y') });
      if (typeId === 'cylinder')
        candidate.design.initialConditions.actuators.push({ componentId: newId, kind: 'cylinder', positionM: 0 });
      if (typeId === 'motor')
        candidate.design.initialConditions.actuators.push({ componentId: newId, kind: 'motor', angleRad: 0 });
      if (typeId === 'valve')
        candidate.design.initialConditions.valves.push({ componentId: newId, positionId: 'neutral' });
      break;
    }
    case 'add-connection': {
      const endpoint = (input: unknown, field: string) => {
        const value = r.object(input, field, ['componentId', 'portId']);
        return {
          componentId: r.id(value.componentId, `${field}/componentId`),
          portId: r.text(value.portId, `${field}/portId`, 1, 8),
        };
      };
      const newId = r.id(raw.id, '/command/id');
      candidate.design.connections.push({
        id: newId,
        from: endpoint(raw.from, '/command/from'),
        to: endpoint(raw.to, '/command/to'),
        params: defaults('pipe'),
      });
      candidate.layout.routes.push({ connectionId: newId, mode: 'auto' });
      break;
    }
    case 'delete': {
      if (raw.target === 'component' && c) {
        candidate.design.components = candidate.design.components.filter((c) => c.id !== id);
        candidate.design.connections = candidate.design.connections.filter(
          (w) => w.from.componentId !== id && w.to.componentId !== id,
        );
        candidate.layout.components = candidate.layout.components.filter((p) => p.componentId !== id);
        candidate.design.initialConditions.actuators = candidate.design.initialConditions.actuators.filter(
          (a) => a.componentId !== id,
        );
        candidate.design.initialConditions.valves = candidate.design.initialConditions.valves.filter(
          (v) => v.componentId !== id,
        );
      } else if (raw.target === 'connection' && w)
        candidate.design.connections = candidate.design.connections.filter((w) => w.id !== id);
      else missing();
      candidate.layout.routes = candidate.layout.routes.filter((route) =>
        candidate.design.connections.some((w) => w.id === route.connectionId),
      );
      break;
    }
    case 'apply-sizing': {
      const sized = sizeCylinder(raw.requirements);
      if (!sized.ok) return sized;
      const cylinder = candidate.design.components.find((c) => c.typeId === 'cylinder');
      const pump = candidate.design.components.find((c) => c.typeId === 'pump');
      const relief = candidate.design.components.find((c) => c.typeId === 'relief');
      if (!cylinder || !pump) {
        missing();
        break;
      }
      const s = sized.value;
      Object.assign(cylinder.params, {
        boreM: s.boreM,
        rodM: s.rodM,
        strokeM: s.strokeM,
        extensionResistanceN: s.forceN,
        mechanicalEfficiency: 0.95,
      }); // Declared legacy sizing assumption.
      pump.params.displacementM3PerRev = s.pumpDisplacementM3PerRev;
      if (relief) relief.params.openingDifferentialPa = s.pressureBudgetPa;
      delete candidate.note;
      break;
    }
  }
  if (r.diagnostics.length) return { ok: false, diagnostics: r.diagnostics };
  return validate ? parseDocument(candidate) : { ok: true, value: candidate };
}
