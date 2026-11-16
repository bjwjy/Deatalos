import {
  diagnostic,
  type NetworkComponent,
  type NetworkConnection,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import type { DutyPhasePaths } from './network-duty-accessories.js';
import {
  isReturnTreeAccessory,
  pipeParameters,
  reportReturnPipe,
  returnPipeLoss,
  type ReturnPipeLaw,
  type ReturnPipeResult,
} from './network-duty-return-pipes.js';

export const supplyPipeFlowConditions = [
  '有损供油限单台定量泵、单油箱和两只在行程内同时动作的普通双作用缸，各用一只独立四通换向阀。吸油须为唯一理想通路，泵出口至各阀 P 口允许唯一通路上的物理干线和支管。支管取本缸实际进油量，干线取两缸实际进油量之和。',
  '各段按保存管径、有效管长、粗糙度、局部阻力系数和油液参数求压降。由泵出口沿供油路径扣除压降得到各阀 P 口压力。已建模供油路径的手填供油损失须为零。泵口直动溢流直回同一油箱，溢流量不计入供油管，轴功率按泵出口与油箱的压差及泵总供流计算。',
  '可配普通回油管。供油环路、阀后物理管、先导溢流和回油附件混接、有损吸油、空化及瞬态待核。',
] as const;

interface SupplySegment {
  readonly id: string;
  readonly parameters: Result<ReturnPipeLaw>;
  readonly upstreamId: string | undefined;
  readonly valveIds: readonly string[];
  readonly role: string;
}

interface SupplyTopology {
  readonly segments: readonly SupplySegment[];
  readonly routes: ReadonlyMap<string, readonly string[]>;
}

export interface SupplyPipeResult extends ReturnPipeResult {
  readonly role: string;
  readonly cylinderLabels: readonly string[];
}

const unsupported = (message: string) => diagnostic('DUTY_UNSUPPORTED', '/duty/supply-pipes', message);

export function hasPhysicalSupplyPath(
  paths: DutyPhasePaths,
  pump: NetworkComponent,
  valves: readonly NetworkComponent[],
) {
  return valves.some((valve) => paths.path(pump.id + ':P', valve.id + ':P')?.some((arc) => arc.physicalPipe));
}

export function findSupplyPipeTopology(
  project: NetworkProject,
  paths: DutyPhasePaths,
  pump: NetworkComponent,
): Result<SupplyTopology | null> {
  const parts = project.design.components;
  const valves = parts.filter((part) => part.typeId === 'valve');
  const p = pump.id + ':P';
  if (!hasPhysicalSupplyPath(paths, pump, valves)) return { ok: true, value: null };
  if (
    pump.definition.id !== 'teaching:pump' ||
    valves.length !== 2 ||
    parts.filter((part) => part.typeId === 'cylinder').length !== 2
  )
    return {
      ok: false,
      diagnostics: [unsupported('有损供油管核算限单台定量泵和两只普通双作用缸，各缸使用独立四通换向阀。')],
    };
  if (parts.some((part) => isReturnTreeAccessory(part) || part.definition.id === 'teaching:pilot-relief'))
    return { ok: false, diagnostics: [unsupported('有损供油与先导溢流或回油附件的混接待核。')] };

  const segments = new Map<
    string,
    {
      pipe: Extract<NetworkConnection, { kind: 'pipe' }>;
      from: string;
      upstreamId: string | undefined;
      valveIds: string[];
    }
  >();
  const routes = new Map<string, readonly string[]>();
  for (const valve of valves) {
    const route = paths.uniquePath(p, valve.id + ':P');
    if (!route || route.some((arc) => !arc.ideal && !arc.physicalPipe))
      return {
        ok: false,
        diagnostics: [
          unsupported(
            (valve.label || valve.id) + ' 的 P 口须经唯一供油通路接泵出口。供油环路、旁路、断开或其他串联元件待核。',
          ),
        ],
      };
    const ids: string[] = [];
    for (const { physicalPipe: pipe, from } of route) {
      if (!pipe) continue;
      const upstreamId = ids.at(-1);
      const existing = segments.get(pipe.id);
      if (existing && (existing.from !== from || existing.upstreamId !== upstreamId))
        return { ok: false, diagnostics: [unsupported('供油管 [' + pipe.id + '] 的上游或流向不唯一。')] };
      if (existing) existing.valveIds.push(valve.id);
      else segments.set(pipe.id, { pipe, from, upstreamId, valveIds: [valve.id] });
      ids.push(pipe.id);
    }
    routes.set(valve.id, ids);
  }
  const parsed: SupplySegment[] = [];
  for (const { pipe, upstreamId, valveIds } of segments.values()) {
    const role = valveIds.length === 2 ? '供油干线' : '供油支管';
    parsed.push({ id: pipe.id, parameters: pipeParameters(project, pipe, role), upstreamId, valveIds, role });
  }
  return { ok: true, value: { segments: parsed, routes } };
}

export function reportSupplyPipes(
  topology: SupplyTopology,
  branches: readonly { readonly valveId: string; readonly label: string; readonly flowM3PerS: number }[],
  pumpPressurePa: number,
): Result<ReadonlyMap<string, SupplyPipeResult>> {
  const results = new Map<string, SupplyPipeResult>();
  for (const { parameters, upstreamId, valveIds, role } of topology.segments) {
    if (!parameters.ok) return parameters;
    const law = parameters.value;
    const members = branches.filter((branch) => valveIds.includes(branch.valveId));
    const flow = members.reduce((sum, branch) => sum + branch.flowM3PerS, 0);
    const upstreamPa = upstreamId === undefined ? pumpPressurePa : results.get(upstreamId)?.downstreamPressurePa;
    if (upstreamPa === undefined)
      return { ok: false, diagnostics: [unsupported(role + ' [' + law.connectionId + '] 的入口压力待核。')] };
    const pipe = reportReturnPipe(law, flow, upstreamPa - returnPipeLoss(law, flow).pressureDropPa, role);
    if (!pipe.ok) return pipe;
    results.set(law.connectionId, { ...pipe.value, role, cylinderLabels: members.map((branch) => branch.label) });
  }
  return { ok: true, value: results };
}
