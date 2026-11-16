import { diagnostic, type NetworkComponent, type Result } from '@hyd/domain';
import type { DutyPhasePaths } from './network-duty-accessories.js';
import { orificeResistance } from './network-duty-flow-split.js';
import type { CalculationInput } from './network-learning.js';

export const dutyProtectionTypes: ReadonlySet<string> = new Set(['counterbalance', 'shock-makeup-valve']);

export const protectionDutyConditions = [
  '限单定量泵、单油箱、一只普通四通换向阀、一只普通双作用缸和一只本批阀，通路唯一且按理想连线。缸容积效率取 1，回油基准取油箱压力，其余供油压降填 0。换向阀的供回油孔口压降按实际通过的流量计算。',
  '平衡阀 B 串接缸有杆腔、A 接换向阀 B、X 从无杆腔取压。伸出校核 B→A 的负载与先导联合开启，缩回校核 A→B 的自由单向通路。只核算阻性负载。',
  '冲击溢流补油阀组跨接两个工作口，T 接同一油箱。按 A、B 各自相对 T 的压差计算工作口→T 溢流和 T→工作口补油，并将这些流量计入目标工况的油量平衡。',
  '结果为指定缸速的稳态工作点及泵需求。超越负载制动、压力冲击、空化和主泵溢流同时调节留待专项核算。',
] as const;

interface ProtectionInput {
  readonly component: NetworkComponent;
  readonly valve: NetworkComponent;
  readonly phase: string;
  readonly index: number;
  readonly pumpPort: string;
  readonly tankPort: string;
  readonly inlet: string;
  readonly outlet: string;
  readonly forward: boolean;
  readonly tankPa: number;
  readonly drivePa: number;
  readonly areaRatio: number;
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

interface ProtectionPoint {
  readonly supplyDropPa: number;
  readonly returnPressurePa: number;
  readonly pumpFlow?: number;
}

function pressureForFlow(low: number, high: number, flow: number, at: (pressure: number) => number): number {
  for (let i = 0; i < 64; i++) {
    const p = low + (high - low) / 2;
    if (at(p) < flow) low = p;
    else high = p;
  }
  return low + (high - low) / 2;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const mp = (pa: number) => Number((pa / 1e6).toPrecision(6)) + ' MPa';

export function estimateDutyProtection(
  paths: DutyPhasePaths,
  input: ProtectionInput,
  add: StepWriter,
): Result<ProtectionPoint> {
  const { component, valve, phase, index, pumpPort, tankPort, inlet, outlet, forward } = input;
  const { tankPa, drivePa, areaRatio, inletFlow, outletFlow, density, budgetPa } = input;
  const name = phase + ' / ' + (component.label || component.id) + ' [' + component.id + ']';
  const fail = (reason: string, code = 'DUTY_UNSUPPORTED'): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic(code, '/duty/load-protection', name + '：' + reason)],
  });
  const port = (id: string) => component.id + ':' + id;
  const work = (id: string) => valve.id + ':' + id;
  const cap = forward ? inlet : outlet;
  const rod = forward ? outlet : inlet;
  const counter = component.typeId === 'counterbalance';
  const workB = counter ? port('A') : rod;
  const groups = [pumpPort, tankPort, cap, workB, ...(counter ? [rod] : [])];
  const ideal = (from: string, to: string) => paths.uniquePath(from, to)?.every((arc) => arc.ideal) === true;
  if (
    !['teaching:directional-2-4', 'teaching:directional-3-4'].includes(valve.definition.id) ||
    !ideal(pumpPort, work('P')) ||
    !ideal(tankPort, work('T')) ||
    !ideal(work('A'), cap) ||
    !ideal(work('B'), workB) ||
    groups.some((from, i) => groups.slice(i + 1).some((to) => paths.idealReachable(from, to))) ||
    !paths.reachable(pumpPort, forward ? cap : workB) ||
    !paths.reachable(forward ? workB : cap, tankPort)
  )
    return fail('须有与缸动作方向一致的四通换向阀位，供油、回油及两个工作口须分开且通路唯一。');
  if (
    counter
      ? !ideal(port('B'), rod) || !ideal(port('X'), cap)
      : !ideal(port('A'), cap) || !ideal(port('B'), rod) || !ideal(port('T'), tankPort)
  )
    return fail(
      counter
        ? '平衡阀 B 须接有杆腔，A 接换向阀 B，X 从无杆腔直接取压。'
        : '保护阀 A/B 须分别接无杆腔/有杆腔，T 须直接接同一油箱。',
    );
  const h = component.parameters.hydraulic;
  const vh = valve.parameters.hydraulic;
  if (
    !h?.maximumAreaM2 ||
    !h.flowCoefficient ||
    !vh?.maximumAreaM2 ||
    !vh.flowCoefficient ||
    !(inletFlow > 0 && outletFlow > 0) ||
    !Number.isFinite(drivePa)
  )
    return fail('缺少有效阀口参数、阻性负载或缸流量。');
  const k = orificeResistance(density, h.flowCoefficient, h.maximumAreaM2);
  const kd = orificeResistance(density, vh.flowCoefficient, vh.maximumAreaM2);
  const validPressure = (value: number) => Number.isFinite(value) && value >= 0 && value <= 70e6;
  const known = (reference: string, value: number, unit: string): CalculationInput => ({
    reference,
    value: { kind: 'known', value },
    unit,
    source: 'load-protection:' + component.id,
  });
  const write = (
    id: string,
    title: string,
    value: number,
    unit: 'Pa' | 'm³/s' | '1',
    formula = '稳态联立结果',
    operands: readonly CalculationInput[] = [],
  ) => {
    const [scale, display] = unit === 'Pa' ? [1e-6, 'MPa'] : unit === 'm³/s' ? [60000, 'L/min'] : [100, '%'];
    add(
      'phase' + index + ':' + component.id + ':' + id,
      name + ' · ' + title,
      formula,
      value,
      unit,
      operands,
      scale,
      display,
    );
  };
  const flowAt = (head: number, resistance: number) => Math.sqrt(Math.max(0, head) / resistance);

  if (counter) {
    const {
      counterbalanceSettingPa: setting,
      regulationBandPa: band,
      pilotRatio: ratio,
      openingDifferentialPa: crack,
    } = h;
    if (!setting || !band || !ratio || crack === undefined)
      return fail('缺少平衡阀设定、调节带、先导比或单向开启压差。');
    const baseReturn = tankPa + kd * outletFlow ** 2;
    const supplyDrop = kd * inletFlow ** 2;
    if (!forward) {
      const pB = drivePa + areaRatio * baseReturn;
      const drop = crack + k * inletFlow ** 2;
      if (!validPressure(pB + drop + supplyDrop)) return fail('自由单向通路的目标压力超出核算范围。');
      write('a', 'A 口压力', pB + drop, 'Pa');
      write('b', 'B 口压力', pB, 'Pa');
      write('x', 'X 口压力（无杆腔回油）', baseReturn, 'Pa');
      write('free-drop', 'A→B 单向通流压降', drop, 'Pa');
      write('free-flow', 'A→B 单向通流量', inletFlow, 'm³/s');
      return { ok: true, value: { supplyDropPa: drop + supplyDrop, returnPressurePa: baseReturn } };
    }
    const pA = baseReturn;
    const signal = (pB: number, pX: number) => pB - pA + ratio * (pX - pA) - setting;
    const pilotAt = (pB: number) => drivePa + areaRatio * pB;
    const full = ((1 + ratio) * pA + setting + band - ratio * drivePa) / (1 + ratio * areaRatio);
    const upper = Math.max(pA + k * outletFlow ** 2, full);
    if (!Number.isFinite(upper)) return fail('调节目标压力超出有限数值范围。');
    const pB = pressureForFlow(pA, upper, outletFlow, (p) => clamp(signal(p, pilotAt(p)) / band) * flowAt(p - pA, k));
    const pX = pilotAt(pB);
    if (!validPressure(pB) || !validPressure(pX + supplyDrop)) return fail('调节目标压力超出 70 MPa 核算范围。');
    if (pX + supplyDrop > budgetPa) {
      const trialX = budgetPa - supplyDrop;
      const trialB = (trialX - drivePa) / areaRatio;
      const margin = signal(trialB, trialX);
      if (trialB >= pA && margin <= 0)
        return fail(
          '泵口预算 ' +
            mp(budgetPa) +
            ' 的目标流量试算下 B→A 截止，有效开启裕量 ' +
            mp(margin) +
            '，达到目标需泵压 ' +
            mp(pX + supplyDrop) +
            '。',
          'DUTY_TARGET_BLOCKED',
        );
    }
    const margin = signal(pB, pX);
    const fraction = clamp(margin / band);
    if (Math.abs(fraction * flowAt(pB - pA, k) - outletFlow) > outletFlow * 1e-8)
      return fail('平衡阀开度与目标回油量的压力联立待核。');
    write('a', 'A 口压力（换向阀侧）', pA, 'Pa');
    write('b', 'B 口压力（缸回油腔）', pB, 'Pa');
    write('x', 'X 口先导压力', pX, 'Pa');
    write('margin', 'B→A 有效开启裕量', margin, 'Pa', 's=(pB-pA)+r*(pX-pA)-pSet', [
      known('pA', pA, 'Pa'),
      known('pB', pB, 'Pa'),
      known('pX', pX, 'Pa'),
      known('r', ratio, '1'),
      known('pSet', setting, 'Pa'),
    ]);
    write('opening', fraction === 1 ? 'B→A 全开' : 'B→A 调节开度', fraction, '1', 'g=clamp(s/band,0,1)', [
      known('s', margin, 'Pa'),
      known('band', band, 'Pa'),
    ]);
    write('drop', 'B→A 调节压降', pB - pA, 'Pa');
    write('flow', 'B→A 回油量', outletFlow, 'm³/s', 'Q=f*sqrt(max(dp,0)/K)', [
      known('f', fraction, '1'),
      known('dp', pB - pA, 'Pa'),
      known('K', k, 'Pa·s²/m⁶'),
    ]);
    return { ok: true, value: { supplyDropPa: supplyDrop, returnPressurePa: pB } };
  }

  const { reliefASettingPa: reliefA, reliefBSettingPa: reliefB, makeupAreaM2, makeupCrackingPa: crack } = h;
  if (!reliefA || !reliefB || !makeupAreaM2 || crack === undefined)
    return fail('缺少两路溢流设定、补油开启压差或补油面积。');
  const km = orificeResistance(density, h.flowCoefficient, makeupAreaM2);
  const relieve = (p: number, setting: number) => flowAt(p - tankPa - setting, k);
  const makeup = (p: number) => flowAt(tankPa - p - crack, km);
  const returnSetting = forward ? reliefB : reliefA;
  const returnHigh = tankPa + kd * outletFlow ** 2;
  if (!Number.isFinite(returnHigh)) return fail('回油目标超出有限数值范围。');
  const returnPressure = pressureForFlow(
    tankPa,
    returnHigh,
    outletFlow,
    (p) => flowAt(p - tankPa, kd) + relieve(p, returnSetting),
  );
  if (
    Math.abs(flowAt(returnPressure - tankPa, kd) + relieve(returnPressure, returnSetting) - outletFlow) >
    outletFlow * 1e-8
  )
    return fail('保护阀与换向阀的回油流量平衡待核。');
  const inletPressure = drivePa + areaRatio * returnPressure;
  const pA = forward ? inletPressure : returnPressure;
  const pB = forward ? returnPressure : inletPressure;
  const qReliefA = relieve(pA, reliefA),
    qReliefB = relieve(pB, reliefB);
  const qMakeupA = makeup(pA),
    qMakeupB = makeup(pB);
  const pumpFlow = inletFlow + (forward ? qReliefA - qMakeupA : qReliefB - qMakeupB);
  const supplyDrop = kd * pumpFlow ** 2;
  if (!(pumpFlow > 0) || inletPressure + supplyDrop < tankPa)
    return fail('补油与目标缸速对应的泵供流或泵压差不为正，回馈或卸荷边界待核。');
  if (!validPressure(inletPressure + supplyDrop) || !validPressure(returnPressure))
    return fail('保护阀组的目标压力超出核算范围。');
  write('t', 'T 口油箱压力', tankPa, 'Pa');
  for (const [id, p, setting, qr, qm] of [
    ['A', pA, reliefA, qReliefA, qMakeupA],
    ['B', pB, reliefB, qReliefB, qMakeupB],
  ] as const) {
    write(id + '-pressure', id + ' 口压力', p, 'Pa');
    write(
      id + '-relief',
      id + '→T 溢流' + (qr > 0 ? '开启' : '关闭') + '（设定 ' + mp(setting) + '）',
      qr,
      'm³/s',
      'Q=f*sqrt(max(dp,0)/K)',
      [known('f', 1, '1'), known('dp', p - tankPa - setting, 'Pa'), known('K', k, 'Pa·s²/m⁶')],
    );
    write(
      id + '-makeup',
      'T→' + id + ' 补油' + (qm > 0 ? '开启' : '关闭') + '（开启差压 ' + mp(crack) + '）',
      qm,
      'm³/s',
      'Q=f*sqrt(max(dp,0)/K)',
      [known('f', 1, '1'), known('dp', tankPa - p - crack, 'Pa'), known('K', km, 'Pa·s²/m⁶')],
    );
  }
  write('return-flow', '换向阀实际回箱流量', outletFlow - (forward ? qReliefB : qReliefA), 'm³/s');
  write('tank-flow', '保护阀组 T 口净回箱流量（负值为补油）', qReliefA + qReliefB - qMakeupA - qMakeupB, 'm³/s');
  write('pump-flow', '泵目标供流（计入溢流和补油）', pumpFlow, 'm³/s');
  return { ok: true, value: { supplyDropPa: supplyDrop, returnPressurePa: returnPressure, pumpFlow } };
}
