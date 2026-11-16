import {
  checkJson,
  ContractReader,
  diagnostic,
  fromSI,
  isComponentType,
  limits,
  parseDocument,
  readParameters,
  specs,
  type ActuatorInitial,
  type Component,
  type Connection,
  type Diagnostic,
  type ProjectDocument,
  type ProjectLayout,
  type Result,
} from '@hyd/domain';
export { projectSchema } from './schema.js';

export interface MigrationContext {
  readonly projectId: string;
  readonly timestamp: string;
  readonly appVersion: string;
}
export interface MigrationChange {
  readonly code: string;
  readonly field: string;
  readonly message: string;
}
export interface MigrationReport {
  readonly sourceVersion: 1;
  readonly targetVersion: 2;
  readonly requiresSaveAs: true;
  readonly changes: readonly MigrationChange[];
}
export interface LoadedProject {
  readonly document: ProjectDocument;
  readonly migration: MigrationReport | null;
  readonly source: { readonly version: 1 | 2; readonly text: string };
  readonly requiresSaveAs: boolean;
}

function metadata(reader: ContractReader, context: MigrationContext) {
  const raw = reader.object(context, '/context', ['projectId', 'timestamp', 'appVersion']);
  const timestamp = reader.timestamp(raw.timestamp, '/context/timestamp');
  return {
    projectId: reader.id(raw.projectId, '/context/projectId'),
    createdAt: timestamp,
    updatedAt: timestamp,
    provenance: {
      createdWithAppVersion: reader.text(raw.appVersion, '/context/appVersion', 1, 100),
      preferredSolverId: 'legacy-basic' as const,
      modelVersion: '1.0.0-experimental' as const,
    },
  };
}

export function createDraft(context: MigrationContext): Result<ProjectDocument> {
  const reader = new ContractReader();
  const identity = metadata(reader, context);
  const fluid = Object.fromEntries(specs('fluid').map((spec) => [spec.legacyKey, spec.defaultValue]));
  const candidate: ProjectDocument = {
    ...identity,
    format: 'HydraulicWorkbench',
    version: 2,
    title: '未命名基础回路',
    description: '',
    design: {
      fluid: readParameters(reader, fluid, 'fluid', '/design/fluid', 'legacy'),
      components: [],
      connections: [],
      initialConditions: { actuators: [], valves: [] },
      embeddedDefinitions: [],
    },
    layout: { components: [], routes: [] },
    extensions: {},
  };
  return reader.diagnostics.length ? { ok: false, diagnostics: reader.diagnostics } : parseDocument(candidate);
}

export function migrateV1(
  input: unknown,
  context: MigrationContext,
): Result<{ document: ProjectDocument; report: MigrationReport }> {
  const budget = checkJson(input);
  if (!budget.ok) return budget;
  const reader = new ContractReader();
  const raw = reader.object(input, '', [
    'format',
    'version',
    'name',
    'note',
    'fluid',
    'components',
    'wires',
    'extensions',
  ]);
  reader.constant(raw.format, 'HydraulicWorkbench', '/format');
  reader.constant(raw.version, 1, '/version', 'VERSION_UNSUPPORTED');
  const changes: MigrationChange[] = [
    { code: 'DESIGN_LAYOUT_SEPARATED', field: '/', message: '设计与布局分离；默认另存 v2，原文保留。' },
  ];
  const positions: { componentId: string; x: number; y: number }[] = [];
  const components: Component[] = reader.array(raw.components, '/components', limits.components).map((item, i) => {
    const field = `/components/${i}`;
    const c = reader.object(item, field, ['id', 'type', 'label', 'x', 'y', 'params', 'center']);
    const type = isComponentType(c.type) ? c.type : 'tank';
    if (!isComponentType(c.type)) reader.fail('MODEL_UNSUPPORTED', `${field}/type`, '未知元件类型不能自动迁移。');
    const id = reader.id(c.id, `${field}/id`);
    positions.push({
      componentId: id,
      x: reader.number(c.x, `${field}/x`, 60, 940),
      y: reader.number(c.y, `${field}/y`, 65, 540),
    });
    let definitionId = `builtin:${type}`;
    if (type === 'valve') {
      if (c.center !== undefined && c.center !== 'closed' && c.center !== 'tandem')
        reader.fail('MODEL_UNSUPPORTED', `${field}/center`, '未知中位机能。');
      definitionId = c.center === 'closed' ? 'builtin:valve-o' : 'builtin:valve-m';
      if (c.center === undefined)
        changes.push({
          code: 'LEGACY_M_CENTER',
          field: `${field}/center`,
          message: '缺省中位按旧读取行为映射为 M 型，不使用新建 O 型默认值。',
        });
    } else if ('center' in c) reader.fail('UNKNOWN_FIELD', `${field}/center`, '非换向阀不应包含中位物理字段。');
    for (const spec of specs(type))
      changes.push({
        code: 'FIELD_UNIT_MAPPED',
        field: `${field}/params/${spec.legacyKey}`,
        message: `${spec.legacyKey} → ${spec.key}，保留旧单位物理含义。`,
      });
    return {
      id,
      typeId: type,
      definitionId,
      definitionVersion: 1,
      label: reader.text(c.label, `${field}/label`, 0, 60),
      params: readParameters(reader, c.params, type, `${field}/params`, 'legacy'),
    };
  });
  function endpoint(input: unknown, field: string) {
    const text = reader.text(input, field, 3, 49);
    const [componentId, portId, extra] = text.split(':');
    if (!componentId || !portId || extra !== undefined)
      reader.fail('ENDPOINT_INVALID', field, '旧油口必须是 componentId:portId。');
    return { componentId: componentId ?? '', portId: portId ?? '' };
  }
  const connections: Connection[] = reader.array(raw.wires, '/wires', limits.connections).map((item, i) => {
    const field = `/wires/${i}`;
    const w = reader.object(item, field, ['id', 'from', 'to', 'params']);
    return {
      id: reader.id(w.id, `${field}/id`),
      from: endpoint(w.from, `${field}/from`),
      to: endpoint(w.to, `${field}/to`),
      params: readParameters(reader, w.params, 'pipe', `${field}/params`, 'legacy'),
    };
  });
  const actuators: ActuatorInitial[] = [];
  for (const c of components) {
    if (c.typeId === 'cylinder') actuators.push({ componentId: c.id, kind: 'cylinder', positionM: 0 });
    if (c.typeId === 'motor') actuators.push({ componentId: c.id, kind: 'motor', angleRad: 0 });
  }
  changes.push(
    {
      code: 'LEGACY_INITIAL_CONDITIONS',
      field: '/design/initialConditions',
      message: '旧文件不含运行状态；按旧启动规则赋初始零位、零角和阀中位。',
    },
    {
      code: 'PIPE_LENGTH_ALREADY_SI',
      field: '/wires/*/params/length',
      message: '管长本来为 m，原值保留；绘图坐标不参与换算。',
    },
  );
  const document: ProjectDocument = {
    ...metadata(reader, context),
    format: 'HydraulicWorkbench',
    version: 2,
    title: reader.text(raw.name, '/name', 1, 100),
    description: '',
    ...(raw.note === undefined ? {} : { note: reader.text(raw.note, '/note', 0, limits.note) }),
    design: {
      fluid: readParameters(reader, raw.fluid, 'fluid', '/fluid', 'legacy'),
      components,
      connections,
      initialConditions: {
        actuators,
        valves: components
          .filter((c) => c.typeId === 'valve')
          .map((c) => ({ componentId: c.id, positionId: 'neutral' })),
      },
      embeddedDefinitions: [],
    },
    layout: { components: positions, routes: connections.map((c) => ({ connectionId: c.id, mode: 'auto' })) },
    extensions: raw.extensions === undefined ? {} : reader.extensions(raw.extensions, '/extensions'),
  };
  if (reader.diagnostics.length) return { ok: false, diagnostics: reader.diagnostics };
  const checked = parseDocument(document);
  if (!checked.ok) return checked;
  return reader.finish({
    document: checked.value,
    report: { sourceVersion: 1 as const, targetVersion: 2 as const, requiresSaveAs: true as const, changes },
  });
}

export function parseProject(input: unknown, context?: MigrationContext): Result<LoadedProject> {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) {
    return { ok: false, diagnostics: [diagnostic('FILE_INVALID', '/', '文件输入必须是文本或 UTF-8 字节。')] };
  }
  if ((typeof input === 'string' ? new TextEncoder().encode(input).length : input.byteLength) > limits.bytes) {
    return { ok: false, diagnostics: [diagnostic('FILE_TOO_LARGE', '/', '工程文件不得超过 2,000,000 字节。')] };
  }
  let text: string;
  let value: unknown;
  try {
    text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    value = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
  } catch {
    return { ok: false, diagnostics: [diagnostic('FILE_INVALID', '/', '文件必须为有效的 UTF-8 JSON。')] };
  }
  if (!value || typeof value !== 'object' || !('format' in value) || value.format !== 'HydraulicWorkbench') {
    return { ok: false, diagnostics: [diagnostic('FILE_INVALID', '/format', '不是液压实验台工程。')] };
  }
  if (!('version' in value) || (value.version !== 1 && value.version !== 2)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic('VERSION_UNSUPPORTED', '/version', '文件版本不支持，不能降级覆盖。'),
        ...('version' in value && value.version === 3
          ? [diagnostic('PROJECT_REQUIRES_ADVANCED', '/version', 'v3自由网络工程须由进阶工作台打开。')]
          : []),
      ],
    };
  }
  if (value.version === 1) {
    if (!context)
      return {
        ok: false,
        diagnostics: [
          diagnostic('MIGRATION_CONTEXT_REQUIRED', '/context', '迁移需由调用方提供工程 ID、时间与应用版本。'),
        ],
      };
    const migrated = migrateV1(value, context);
    return migrated.ok
      ? {
          ok: true,
          value: {
            document: migrated.value.document,
            migration: migrated.value.report,
            source: { version: 1, text },
            requiresSaveAs: true,
          },
        }
      : migrated;
  }
  const checked = parseDocument(value);
  return checked.ok
    ? {
        ok: true,
        value: { document: checked.value, migration: null, source: { version: 2, text }, requiresSaveAs: false },
      }
    : checked;
}

export function encodeProject(input: unknown): Result<Uint8Array> {
  const checked = parseDocument(input);
  if (!checked.ok) return checked;
  const bytes = new TextEncoder().encode(JSON.stringify(checked.value, null, 2) + '\n');
  if (bytes.byteLength > limits.bytes)
    return {
      ok: false,
      diagnostics: [diagnostic('FILE_TOO_LARGE', '/', '编码后超过工程字节预算，未生成可保存结果。')],
    };
  return { ok: true, value: bytes };
}

// Data-only seam for old-unit compatibility checks and F03. It is not a solver,
// file writer or v2 runtime-restoration API; no definition is inferred from SVG.
export function legacyComparisonInput(input: unknown): Result<Record<string, unknown>> {
  const checked = parseDocument(input);
  if (!checked.ok) return checked;
  const doc = checked.value;
  const errors: Diagnostic[] = [];
  const parameters = (group: string, values: Readonly<Record<string, number>>) =>
    Object.fromEntries(
      specs(group).map((spec) => {
        const value = values[spec.key];
        if (value === undefined) throw new Error('Validated document lost a required parameter');
        return [spec.legacyKey, fromSI(spec.quantity, value)];
      }),
    );
  const components = doc.design.components.map((c) => {
    const position = doc.layout.components.find((p) => p.componentId === c.id);
    if (!position || position.x < 60 || position.x > 940 || position.y < 65 || position.y > 540)
      errors.push(
        diagnostic('LEGACY_LAYOUT_UNSUPPORTED', '/layout/components', '旧消费端画布范围不同，F03 须隔离几何校验。'),
      );
    return {
      id: c.id,
      type: c.typeId,
      label: c.label,
      x: position?.x,
      y: position?.y,
      params: parameters(c.typeId, c.params),
      ...(c.typeId === 'valve' ? { center: c.definitionId === 'builtin:valve-o' ? 'closed' : 'tandem' } : {}),
    };
  });
  const result = {
    format: 'HydraulicWorkbench',
    version: 1,
    name: doc.title,
    ...(doc.note === undefined ? {} : { note: doc.note }),
    fluid: parameters('fluid', doc.design.fluid),
    components,
    wires: doc.design.connections.map((c) => ({
      id: c.id,
      from: `${c.from.componentId}:${c.from.portId}`,
      to: `${c.to.componentId}:${c.to.portId}`,
      params: parameters('pipe', c.params),
    })),
    ...(Object.keys(doc.extensions).length ? { extensions: doc.extensions } : {}),
  };
  return errors.length ? { ok: false, diagnostics: errors } : { ok: true, value: result };
}

// A semantic layout comparison can be made independently of ProjectDesign.
export type { ProjectLayout };
