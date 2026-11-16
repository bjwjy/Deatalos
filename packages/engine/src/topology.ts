import { diagnostic, type Result } from '@hyd/domain';
import type { LegacyModel, Topology, Link, LinkKey } from './legacy-model.js';

export function topology(model: LegacyModel): Result<Topology> {
  const group = (type: string) => model.components.filter((c) => c.type === type);
  if (
    ['tank', 'pump', 'relief', 'valve'].some((type) => group(type).length > 1) ||
    group('cylinder').length + group('motor').length > 1
  ) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'MODEL_UNSUPPORTED',
          '/design/components',
          '基础模型仅支持单泵站和单执行器，多个实例不能按任意网络求解。',
        ),
      ],
    };
  }
  const tank = group('tank')[0],
    pump = group('pump')[0],
    relief = group('relief')[0];
  const valve = group('valve')[0],
    act = [...group('cylinder'), ...group('motor')][0];
  if (!tank || !pump || !relief || !valve || !act) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'INCOMPLETE_CIRCUIT',
          '/design/components',
          '可保存的草稿尚未组成一油箱、一泵、一溢流阀、一换向阀及一执行器。',
        ),
      ],
    };
  }
  const get = (a: string, b: string): Link | undefined => {
    const wire = model.wires.find((w) => (w.from === a && w.to === b) || (w.from === b && w.to === a));
    return wire ? { wire, a, b } : undefined;
  };
  const supply = get(`${pump.id}:P`, `${valve.id}:P`);
  const reliefIn = get(`${pump.id}:P`, `${relief.id}:P`);
  const reliefOut = get(`${relief.id}:T`, `${tank.id}:T`);
  const returnLink = get(`${valve.id}:T`, `${tank.id}:T`);
  const suction = get(`${tank.id}:T`, `${pump.id}:S`);
  const directA = get(`${valve.id}:A`, `${act.id}:A`);
  const directB = get(`${valve.id}:B`, `${act.id}:B`);
  const reversed = !(directA && directB);
  const A = reversed ? get(`${valve.id}:A`, `${act.id}:B`) : directA;
  const B = reversed ? get(`${valve.id}:B`, `${act.id}:A`) : directB;
  if (!supply || !reliefIn || !reliefOut || !returnLink || !suction || !A || !B || model.wires.length !== 7) {
    const incomplete = model.wires.length < 7;
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          incomplete ? 'INCOMPLETE_CIRCUIT' : 'MODEL_UNSUPPORTED',
          '/design/connections',
          incomplete
            ? '缺少基础回路必需的直接连线。'
            : '仅支持七条指定直连管线及执行器 A/B 交叉，不支持额外或替代支路。',
        ),
      ],
    };
  }
  const links: Record<LinkKey, Link> = { supply, reliefIn, reliefOut, return: returnLink, suction, A, B };
  return { ok: true, value: { tank, pump, relief, valve, act, links, reversed } };
}
