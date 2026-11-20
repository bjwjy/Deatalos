import { diagnostic, type NetworkComponent, type NetworkProject, type Result } from '@hyd/domain';
import { dutyPhasePaths } from './network-duty-accessories.js';
import { pipeParameters, returnPipeLoss, reportReturnPipe } from './network-duty-return-pipes.js';
import type { DutyPhase } from './network-duty.js';

interface StorageLine {
  label: string;
  sealed: boolean;
  rate: (gap: number) => number;
  check: (q: number) => Result<unknown>;
}
const fail = (m: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/storage-line', m)],
});
export function storageLine(
  project: NetworkProject,
  phase: DutyPhase,
  source: NetworkComponent,
  acc: NetworkComponent,
  r: number,
): Result<StorageLine> {
  const hold = source.typeId === 'tank',
    from = source.id + (hold ? ':T' : ':P'),
    to = acc.id + ':H';
  const parts = project.design.components,
    pipes = project.design.connections.filter((c) => c.kind === 'pipe'),
    meters = parts.filter((c) => c.typeId === 'throttle'),
    isolators = parts.filter((c) => c.typeId === 'manual-shutoff');
  if (
    parts.some((p) => p !== acc && p !== source && !meters.includes(p) && !isolators.includes(p)) ||
    meters.length + pipes.length > 1 ||
    isolators.length > (hold ? 1 : 0) ||
    project.design.connections.some((c) => c.kind === 'signal')
  )
    return fail('恒压边界与 H 口之间限唯一理想通路、一段物理管或一只给定开口的节流阀。保压工况需独立隔离。');
  const path = dutyPhasePaths(project, phase, false, true);
  if (!path.ok) return path;
  const g = path.value;
  const isolator = isolators[0],
    meter = meters[0],
    pipe = pipes[0];
  const ends = (id: string) =>
    (g.idealReachable(from, id + ':A') && g.idealReachable(to, id + ':B')) ||
    (g.idealReachable(from, id + ':B') && g.idealReachable(to, id + ':A'));
  if (hold && (!isolator || !ends(isolator.id) || g.states.find((s) => s.component.id === isolator.id)?.area !== 0))
    return fail('隔离保压须有已关闭的截止阀跨在储油节点和油箱之间。');
  const route = g.uniquePath(from, to);
  const ok = (
    label: string,
    sealed: boolean,
    rate: (gap: number) => number,
    check: StorageLine['check'] = () => ({ ok: true, value: true }),
  ): Result<StorageLine> => ({ ok: true, value: { label, sealed, rate, check } });
  if (hold && !pipe && !meter && !g.reachable(from, to)) return ok('截止阀关闭，理想密封', true, () => 0);
  if (hold && !pipe && !meter) return fail('截止阀被额外通路旁接，隔离保压条件不成立。');
  if (!route || route.some((a) => !a.ideal && !a.physicalPipe && (!meter || a.component?.id !== meter.id)))
    return fail('储油节点至压力边界存在断路、并联旁路或未建模的串联压降。');
  if (pipe) {
    if (!route.some((a) => a.physicalPipe?.id === pipe.id)) return fail('物理管 [' + pipe.id + '] 未串在充放油通路。');
    const law = pipeParameters(project, pipe, '蓄能器串联管');
    if (!law.ok) return law;
    return ok(
      '物理管 [' + pipe.id + ']',
      false,
      (gap) => {
        let lo = 0,
          hi = Math.abs(gap) / r;
        for (let i = 0; i < 56; i++) {
          const q = (lo + hi) / 2;
          if (r * q + returnPipeLoss(law.value, q).pressureDropPa < Math.abs(gap)) lo = q;
          else hi = q;
        }
        return (Math.sign(gap) * (lo + hi)) / 2;
      },
      (q) => reportReturnPipe(law.value, Math.abs(q), 0, '蓄能器串联管'),
    );
  }
  if (meter) {
    if (!ends(meter.id) || !route.some((a) => a.component?.id === meter.id))
      return fail('节流阀 [' + meter.id + '] 未串在储油通路。');
    const init = project.design.initialConditions.find((p) => p.componentId === meter.id),
      cq = meter.parameters.hydraulic?.flowCoefficient;
    if (init?.kind !== 'throttle' || !cq) return fail('节流阀 [' + meter.id + '] 有效开口或流量系数待核。');
    if (init.openingAreaM2 === 0) return ok('节流阀 [' + meter.id + '] 关闭', true, () => 0);
    const k = project.design.fluid.densityKgPerM3 / (2 * (cq * init.openingAreaM2) ** 2);
    return ok(
      (hold ? '隔离支路等效泄漏孔口' : '节流阀') + ' [' + meter.id + ']',
      false,
      (gap) => (2 * gap) / (r + Math.sqrt(r * r + 4 * k * Math.abs(gap))),
    );
  }
  return ok('理想直连', false, (gap) => gap / r);
}

export function storagePipeEligible(project: NetworkProject, id: string): boolean {
  const parts = project.design.components,
    acc = parts.find((p) => p.typeId === 'accumulator'),
    source = parts.find((p) => p.typeId === 'pressure-source');
  if (!acc || !source || parts.length !== 2 || project.design.connections.filter((e) => e.kind === 'pipe').length !== 1)
    return false;
  const path = dutyPhasePaths(project, { name: '管路接线', valves: [], actions: [] }, false);
  return (
    path.ok && path.value.uniquePath(source.id + ':P', acc.id + ':H')?.some((a) => a.physicalPipe?.id === id) === true
  );
}
