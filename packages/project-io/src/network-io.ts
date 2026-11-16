import {
  diagnostic,
  immutable,
  limits,
  parseDocument,
  parseNetworkProject,
  parseNetworkSnapshot,
  type NetworkIdentity,
  type NetworkComponent,
  type NetworkInitial,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import { createDraft, parseProject, type MigrationContext, type MigrationChange } from './legacy-io.js';
export interface NetworkLoadedProject {
  readonly document: NetworkProject;
  readonly source: {
    readonly version: 1 | 2 | 3;
    readonly text: string;
  };
  readonly requiresSaveAs: boolean;
  readonly migration: {
    readonly sourceVersion: 1 | 2;
    readonly targetVersion: 3;
    readonly changes: readonly MigrationChange[];
  } | null;
}
/** Explicit data migration only. Does not select Hopsan or convert a legacy physical model. */
export function upgradeNetworkDocument(value: unknown): Result<NetworkProject> {
  const parsed = parseDocument(value);
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const components: NetworkComponent[] = input.design.components.map((c) => ({
    id: c.id,
    typeId: c.typeId,
    definition: {
      id: c.definitionId,
      version: c.definitionVersion,
    },
    model: {
      id: `legacy-basic:${c.typeId}`,
      version: '1.0.0-experimental',
    },
    label: c.label,
    parameters: {
      legacy: c.params,
    },
  }));
  const initialConditions: NetworkInitial[] = [
    ...input.design.initialConditions.valves.map((v) => ({
      ...v,
      kind: 'valve' as const,
    })),
    ...input.design.initialConditions.actuators.map((a) =>
      a.kind === 'cylinder'
        ? {
            ...a,
            velocityMPerS: null,
            capPressurePa: null,
            rodPressurePa: null,
          }
        : {
            ...a,
            angularSpeedRadPerS: null,
          },
    ),
  ];
  return parseNetworkProject({
    format: 'HydraulicWorkbench',
    version: 3,
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    ...(input.note === undefined
      ? {}
      : {
          note: input.note,
        }),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    design: {
      fluid: {
        ...input.design.fluid,
        bulkModulusPa: null,
      },
      pressureReference: {
        kind: 'gauge',
        absoluteReferencePa: null,
      },
      components,
      nodes: [],
      initialConditions,
      connections: input.design.connections.map((c) => ({
        id: c.id,
        kind: 'pipe',
        from: {
          kind: 'port',
          ...c.from,
        },
        to: {
          kind: 'port',
          ...c.to,
        },
        model: {
          id: 'legacy-basic:pipe',
          version: '1.0.0-experimental',
        },
        parameters: c.params,
      })),
    },
    layout: {
      ...input.layout,
      nodes: [],
    },
    provenance: {
      createdWithAppVersion: input.provenance.createdWithAppVersion,
      preferredSolverId: 'legacy-basic',
    },
    extensions: input.extensions,
  });
}
export function createNetworkDraft(context: MigrationContext): Result<NetworkProject> {
  const old = createDraft(context);
  if (!old.ok) return old;
  const upgraded = upgradeNetworkDocument(old.value);
  if (!upgraded.ok) return upgraded;
  return parseNetworkProject({
    ...upgraded.value,
    design: {
      ...upgraded.value.design,
      fluid: {
        ...upgraded.value.design.fluid,
        bulkModulusPa: 1e9,
      },
      pressureReference: {
        kind: 'kernel-numeric',
        absoluteReferencePa: null,
      },
    },
    provenance: {
      createdWithAppVersion: context.appVersion,
      preferredSolverId: 'hopsan',
    },
  });
}
export function parseNetworkFile(input: unknown, context?: MigrationContext): Result<NetworkLoadedProject> {
  if (typeof input !== 'string' && !(input instanceof Uint8Array))
    return {
      ok: false,
      diagnostics: [diagnostic('FILE_INVALID', '/', '文件须为文本或UTF-8字节。')],
    };
  if ((typeof input === 'string' ? new TextEncoder().encode(input).length : input.byteLength) > limits.bytes)
    return {
      ok: false,
      diagnostics: [diagnostic('FILE_TOO_LARGE', '/', '文件超过字节预算。')],
    };
  let text: string, value: unknown;
  try {
    text =
      typeof input === 'string'
        ? input
        : new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
          }).decode(input);
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return {
      ok: false,
      diagnostics: [diagnostic('FILE_INVALID', '/', '无效UTF-8 JSON。')],
    };
  }
  if (value && typeof value === 'object' && 'version' in value && value.version === 3) {
    const parsed = parseNetworkProject(value);
    return parsed.ok
      ? {
          ok: true,
          value: immutable({
            document: parsed.value,
            source: {
              version: 3,
              text,
            },
            requiresSaveAs: false,
            migration: null,
          }),
        }
      : parsed;
  }
  const legacy = parseProject(input, context);
  if (!legacy.ok) return legacy;
  const upgraded = upgradeNetworkDocument(legacy.value.document);
  if (!upgraded.ok) return upgraded;
  const changes: MigrationChange[] = [
    ...(legacy.value.migration?.changes ?? []),
    {
      code: 'NETWORK_FORMAT_UPGRADE',
      field: '/version',
      message: '另存v3；保留legacy-basic模型，不自动转换物理后端。',
    },
    {
      code: 'PHYSICAL_PIPES_PRESERVED',
      field: '/design/connections',
      message: '原管路参数和端点顺序保留为物理管路；未插入理想节点或默认容积。',
    },
    {
      code: 'INITIAL_UNKNOWN_PRESERVED',
      field: '/design/initialConditions',
      message: '旧格式未声明的动态速度、腔压和体积模量保持null，不填0或教学默认值。',
    },
  ];
  return {
    ok: true,
    value: immutable({
      document: upgraded.value,
      source: legacy.value.source,
      requiresSaveAs: true,
      migration: {
        sourceVersion: legacy.value.source.version,
        targetVersion: 3,
        changes,
      },
    }),
  };
}
export function encodeNetworkProject(input: unknown): Result<Uint8Array> {
  const parsed = parseNetworkProject(input);
  if (!parsed.ok) return parsed;
  const bytes = new TextEncoder().encode(JSON.stringify(parsed.value, null, 2) + '\n');
  return bytes.length <= limits.bytes
    ? {
        ok: true,
        value: bytes,
      }
    : {
        ok: false,
        diagnostics: [diagnostic('FILE_TOO_LARGE', '/', '编码超过字节预算。')],
      };
}
/** Foundation JSON export. Never recomputes physics or writes runtime into a project. */
export function encodeNetworkResult(
  projectInput: unknown,
  resultInput: unknown,
  expected: NetworkIdentity,
): Result<Uint8Array> {
  const project = parseNetworkProject(projectInput);
  if (!project.ok) return project;
  const result = parseNetworkSnapshot(project.value, resultInput, expected);
  if (!result.ok) return result;
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      {
        format: 'HydraulicWorkbenchNetworkResult',
        version: 1,
        document: project.value,
        point: result.value,
      },
      null,
      2,
    ) + '\n',
  );
  return bytes.length <= 4_000_000
    ? {
        ok: true,
        value: bytes,
      }
    : {
        ok: false,
        diagnostics: [diagnostic('FILE_TOO_LARGE', '/', '结果JSON超过预算。')],
      };
}
