import { diagnostic, type NetworkComponent, type Result } from '@hyd/domain';
import type { DutyPhasePaths } from './network-duty-accessories.js';
import type { CalculationInput } from './network-learning.js';
import { orificeResistance } from './network-duty-flow-split.js';

export const dutyLogicValveTypes: ReadonlySet<string> = new Set([
  'shuttle-valve',
  'two-pressure-valve',
  'pilot-check-close',
]);

export const logicValveDutyConditions = [
  '本批限单定量泵、单油箱、单只通路判定阀与一只普通双作用缸的稳态阻性工况。泵、油箱及工况阀位确定入口或先导压力。只允许唯一接线，工况换向阀作通断边界，其他已知供油压降可手填。',
  '梭阀和双压阀的 C 口直连供油缸腔。梭阀按入口压差及过渡带分配阀口面积，双压阀另校核两路最低入口压力及开启带。液控关闭单向阀串在缸回油路，X 取泵出口或同一油箱，关闭先导压差相对阀 A 口。',
  '泵口试算预算用于判断目标是否可达。预算下的截止只代表该试算点。关闭保载、回馈、阀芯切换瞬态、独立多源供压及混接其他有损元件另验。',
] as const;

interface LogicInput {
  readonly component: NetworkComponent;
  readonly phase: string;
  readonly index: number;
  readonly pumpPort: string;
  readonly tankPort: string;
  readonly inlet: string;
  readonly outlet: string;
  readonly tankPa: number;
  readonly drivePa: number;
  readonly areaRatio: number;
  readonly supplyLossPa: number;
  readonly inletFlow: number;
  readonly outletFlow: number;
  readonly density: number;
  readonly budgetPa: number;
}

type StepWriter = (
  key: string,
  label: string,
  formula: string,
  value: number,
  unit: string,
  inputs: readonly CalculationInput[],
  scale?: number,
  displayUnit?: string,
) => void;

type Boundary = 'pump' | 'tank';
const clip = (x: number) => Math.max(0, Math.min(1, x));
const mp = (pa: number) => Number((pa / 1e6).toPrecision(6)) + ' MPa';

/** Resolve the supported one-valve topology using its saved quasi-static flow law. */
export function estimateDutyLogicValve(
  paths: DutyPhasePaths,
  input: LogicInput,
  add: StepWriter,
): Result<{ readonly supplyDropPa: number; readonly returnDropPa: number }> {
  const { component, pumpPort: pump, tankPort: tank, inlet, outlet, tankPa, drivePa, areaRatio, supplyLossPa } = input;
  const { inletFlow, outletFlow, density, budgetPa } = input;
  const title = input.phase + ' / ' + (component.label || component.id) + ' [' + component.id + ']';
  const fail = (message: string, code = 'DUTY_UNSUPPORTED'): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic(code, '/duty/logic-valve', title + '：' + message)],
  });
  const blocked = (message: string) => fail(message, 'DUTY_TARGET_BLOCKED');
  const port = (id: string) => component.id + ':' + id;
  const simple = (from: string, to: string) =>
    paths.uniquePath(from, to)?.every((arc) => arc.ideal || arc.component?.typeId === 'valve') === true;
  const ideal = (from: string, to: string) => paths.uniquePath(from, to)?.every((arc) => arc.ideal) === true;
  const boundary = (to: string): Boundary | null => {
    const supply = simple(pump, to);
    const drain = simple(tank, to);
    if (supply === drain) return null;
    return supply ? 'pump' : 'tank';
  };
  const known = (reference: string, value: number, unit: string): CalculationInput => ({
    reference,
    unit,
    value: { kind: 'known', value },
    source: 'logic-valve:' + component.id,
  });
  const pressure = (
    key: string,
    label: string,
    pa: number,
    formula = '工况压力边界',
    operands: readonly CalculationInput[] = [],
  ) =>
    add(
      'phase' + input.index + ':' + component.id + ':' + key,
      title + ' · ' + label,
      formula,
      pa,
      'Pa',
      operands,
      1e-6,
      'MPa',
    );
  const flow = (key: string, label: string, q: number, formula: string, operands: readonly CalculationInput[] = []) =>
    add(
      'phase' + input.index + ':' + component.id + ':' + key,
      title + ' · ' + label,
      formula,
      q,
      'm³/s',
      operands,
      60000,
      'L/min',
    );
  const h = component.parameters.hydraulic;
  if (!h?.maximumAreaM2 || !h.flowCoefficient || !(density > 0)) return fail('缺少有效阀口面积、流量系数或油液密度。');
  const resistance = orificeResistance(density, h.flowCoefficient, h.maximumAreaM2);
  if (component.typeId === 'pilot-check-close') {
    if (
      !simple(pump, inlet) ||
      !ideal(outlet, port('A')) ||
      !ideal(port('B'), tank) ||
      paths.reachable(outlet, tank) ||
      paths.reachable(pump, outlet)
    )
      return fail('主通路须为缸排油腔→A→B→油箱，缸进油须有唯一供油通路。反向、旁路或其他串联损失待核。');
    const pilot = boundary(port('X'));
    if (!pilot) return fail('X 口须经理想油路或工况换向阀单独接泵出口或油箱，先导压差待核。');
    if (pilot === 'pump' && !(areaRatio < 1)) return fail('X 取泵出口时限进油有效面积大于排油面积的工况。');
    const crack = h.openingDifferentialPa;
    const ratio = h.pilotRatio;
    if (crack === undefined || !ratio) return fail('缺少开启压差或关闭先导比。');
    const inletBase = drivePa + supplyLossPa;
    const head = resistance * outletFlow ** 2;
    const unpiloted = tankPa + crack + head;
    const pilotActive = pilot === 'pump' && inletBase + areaRatio * unpiloted > unpiloted;
    const pA = pilotActive ? (unpiloted + ratio * inletBase) / (1 + ratio * (1 - areaRatio)) : unpiloted;
    const pumpPa = inletBase + areaRatio * pA;
    const pX = pilot === 'pump' ? pumpPa : tankPa;
    if (!Number.isFinite(pumpPa)) return fail('目标压力超出有限数值范围。');
    if (pumpPa > budgetPa * (1 + 1e-12)) {
      const budgetA = (budgetPa - inletBase) / areaRatio;
      const budgetX = pilot === 'pump' ? budgetPa : tankPa;
      if (budgetA < tankPa)
        return blocked(
          '泵口试算预算 ' + mp(budgetPa) + ' 无法建立负载要求的回油压力。目标泵压 ' + mp(pumpPa) + '，通流待核。',
        );
      const budgetHead = budgetA - tankPa - crack - ratio * Math.max(0, budgetX - budgetA);
      const state = budgetHead <= 0 ? 'A→B 截止' : 'A→B 可开，流量不足';
      return blocked(
        '泵口试算预算 ' +
          mp(budgetPa) +
          ' 下' +
          state +
          '。X 口 ' +
          mp(budgetX) +
          '，A 口 ' +
          mp(budgetA) +
          '，有效开启压差 ' +
          mp(budgetHead) +
          '，目标泵压 ' +
          mp(pumpPa) +
          '。',
      );
    }
    const opposing = ratio * Math.max(0, pX - pA);
    pressure('pilot', 'X 口压力（' + (pilot === 'pump' ? '泵出口' : '油箱') + '）', pX);
    pressure('back', 'A 口及缸回油腔压力', pA);
    pressure('tank', 'B 口油箱压力', tankPa);
    pressure('threshold', '开启门槛（含关闭先导）', crack + opposing, 'dpOpen=dpCrack+r*max(pX-pA,0)', [
      known('dpCrack', crack, 'Pa'),
      known('r', ratio, '1'),
      known('pX', pX, 'Pa'),
      known('pA', pA, 'Pa'),
    ]);
    pressure('head', 'A→B 通流 · 有效开启压差', head, 'dp=pA-pB-dpOpen', [
      known('pA', pA, 'Pa'),
      known('pB', tankPa, 'Pa'),
      known('dpOpen', crack + opposing, 'Pa'),
    ]);
    flow('return-flow', 'A→B 目标回油量', outletFlow, 'Q=sqrt(dp/K)', [
      known('dp', head, 'Pa'),
      known('K', resistance, 'Pa·s²/m⁶'),
    ]);
    return { ok: true, value: { supplyDropPa: 0, returnDropPa: pA - tankPa } };
  }

  if (
    !ideal(port('C'), inlet) ||
    !simple(outlet, tank) ||
    paths.reachable(pump, inlet) ||
    paths.reachable(tank, inlet) ||
    paths.reachable(pump, outlet)
  )
    return fail('C 口须直连供油缸腔，另一腔经唯一通路回油箱。旁路、反向或未知出口压力待核。');
  const a = boundary(port('A'));
  const b = boundary(port('B'));
  if (!a || !b) return fail('A、B 须各自经唯一通路接泵出口或油箱，入口压差待核。');
  const dual = component.typeId === 'two-pressure-valve';
  const minimum = h.minimumInletPressurePa;
  const band = h.activationBandPa;
  const transition = h.transitionPressurePa;
  if (!transition || (dual && (minimum === undefined || !band))) return fail('缺少选通压差、最低入口压力或开启带。');
  if (a === 'tank' && b === 'tank') return blocked('A、B 均回箱，C 口无泵供油。两入口均为 ' + mp(tankPa) + '。');
  if (dual && (a === 'tank' || b === 'tank')) {
    if (minimum !== undefined && tankPa <= minimum)
      return blocked(
        (a === 'tank' ? 'A' : 'B') +
          ' 口回箱，仅一路供压，C 口截止。低压入口 ' +
          mp(tankPa) +
          '，启用门槛 ' +
          mp(minimum) +
          '。',
      );
    return fail('一侧回箱但回箱压力高于启用门槛。此高背压边界的双压阀通流待核。');
  }
  const outletPa = drivePa + areaRatio * tankPa + supplyLossPa;
  const fullPa = outletPa + resistance * inletFlow ** 2;
  const stateAt = (p: number) => {
    const pA = a === 'pump' ? p : tankPa;
    const pB = b === 'pump' ? p : tankPa;
    const fraction = clip(0.5 + (pA - pB) / (2 * transition));
    const opening = dual && minimum !== undefined && band ? clip((Math.min(pA, pB) - minimum) / band) : 1;
    return {
      pA,
      pB,
      opening,
      fraction,
      qa: opening * fraction * Math.sqrt(Math.max(0, (pA - outletPa) / resistance)),
      qb: opening * (1 - fraction) * Math.sqrt(Math.max(0, (pB - outletPa) / resistance)),
    };
  };
  let low = Math.max(outletPa, tankPa);
  let high = Math.max(fullPa, tankPa + transition, (minimum ?? 0) + (band ?? 0));
  if (!Number.isFinite(high)) return fail('目标压力超出有限数值范围。');
  for (let i = 0; i < 64; i++) {
    const mid = low + (high - low) / 2;
    const { qa, qb } = stateAt(mid);
    if (qa + qb < inletFlow) low = mid;
    else high = mid;
  }
  const pumpPa = low + (high - low) / 2;
  const { pA, pB, opening, fraction, qa, qb } = stateAt(pumpPa);
  if (Math.abs(qa + qb - inletFlow) > inletFlow * 1e-8) return fail('未找到可核对的阀口目标流量平衡。');
  if (dual && pumpPa > budgetPa * (1 + 1e-12) && minimum !== undefined && budgetPa <= minimum)
    return blocked('双入口在泵口试算预算 ' + mp(budgetPa) + ' 下均未达到启用门槛 ' + mp(minimum) + '，C 口截止。');
  const state = qa > 0 && qb > 0 ? 'A、B→C 同时通流' : qa > 0 ? 'A→C 通流，B 无通流' : 'B→C 通流，A 无通流';
  pressure('p-a', 'A 口压力（' + (a === 'pump' ? '供压' : '回箱') + '）', pA);
  pressure('p-b', 'B 口压力（' + (b === 'pump' ? '供压' : '回箱') + '）', pB);
  pressure('signal', '入口压差 A−B', pA - pB, 'dp=pA-pB', [known('pA', pA, 'Pa'), known('pB', pB, 'Pa')]);
  pressure('transition', '全选通压差门槛', transition);
  if (dual && minimum !== undefined && band) {
    pressure('enable', '双入口启用门槛', minimum);
    add(
      'phase' + input.index + ':' + component.id + ':opening',
      title + ' · 双压阀开度',
      'g=clamp((min(pA,pB)-pMin)/band,0,1)',
      opening,
      '1',
      [known('pA', pA, 'Pa'), known('pB', pB, 'Pa'), known('pMin', minimum, 'Pa'), known('band', band, 'Pa')],
      100,
      '%',
    );
  }
  pressure('p-c', 'C 口目标压力', outletPa);
  pressure('valve-drop', '阀压降 · ' + state, pumpPa - outletPa, 'dp=pPump-pC', [
    known('pPump', pumpPa, 'Pa'),
    known('pC', outletPa, 'Pa'),
  ]);
  const seat = (openingFraction: number, delta: number) => [
    known('f', openingFraction, '1'),
    known('dp', delta, 'Pa'),
    known('K', resistance, 'Pa·s²/m⁶'),
  ];
  flow('a-flow', 'A→C 流量', qa, 'Q=f*sqrt(max(dp,0)/K)', seat(opening * fraction, pA - outletPa));
  flow('b-flow', 'B→C 流量', qb, 'Q=f*sqrt(max(dp,0)/K)', seat(opening * (1 - fraction), pB - outletPa));
  return { ok: true, value: { supplyDropPa: pumpPa - outletPa, returnDropPa: 0 } };
}
