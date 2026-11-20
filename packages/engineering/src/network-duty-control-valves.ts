import { diagnostic, type NetworkComponent, type Result } from '@hyd/domain';
import type { DutyPhasePaths, DutyPressureDrop } from './network-duty-accessories.js';
import { calculationSubstitution, type CalculationInput, type CalculationStep } from './network-learning.js';
import type { ControlDrainBoundary } from './network-duty-control-return.js';

export const dutyControlValveTypes: ReadonlySet<string> = new Set([
  'pressure-reducing',
  'pressure-compensated-flow',
  'sequence-valve',
]);

export const controlValveDutyConditions = [
  '控制阀正向串联在双作用缸供油路。两只减压阀或顺序阀串联时，按接线从缸向泵逐级求各阀 P、A 压力，两只 Y 均直回同箱。泵出口到阀 P 口只允许理想油路或串联流量计。吸油、供油和回油各有唯一通路。',
  '阀前流量计压降加到泵出口需求，阀后流量计压降加到 A 口需求。手填其余压降只覆盖 A 口至缸进油腔，须扣除已单列的流量计压降。',
  '结果是指定负载与速度下的稳态需求。泵流量、限压或溢流约束不足时，目标工况尚不能成立。反向旁通、交叉取压、未标定的多阀泄流和动作切换不在本批范围。',
  '泵实际供流须与该稳态点匹配，剩余流量的卸荷和溢流功率另行核对。',
] as const;
export const controlValveModelConditions: Readonly<Record<string, string>> = {
  'pressure-reducing':
    'Y 口直回油箱时，Y 压力取油箱压力。普通减压阀按 A−Y 相对设定值计算有限开口，出口相对压力达到设定值时无法通过目标正流量。',
  'pressure-compensated-flow':
    '二通压力补偿调速阀在补偿压差以下按孔口流动，到达补偿压差后受补偿流量上限约束。低于上限的目标流量对应未补偿区。内置或外接油液容积影响瞬态，稳态核算采用净储油流量为零的条件。',
  'sequence-valve':
    'Y 口直回油箱时，Y 压力取油箱压力。顺序阀按 P−Y 超过设定后的开口比例计算目标流量所需入口压力。开启门槛和达到目标流量所需压力分别列出。',
};

export function hasControlDrain(component: NetworkComponent): boolean {
  return component.typeId === 'pressure-reducing' || component.typeId === 'sequence-valve';
}

interface ValveDutyInput {
  readonly seriesControls?: ReadonlySet<string>;
  readonly component: NetworkComponent;
  readonly phaseName: string;
  readonly phaseIndex: number;
  readonly pumpId: string;
  readonly tankId: string;
  readonly actuatorInlet: string;
  readonly actuatorOutlet: string;
  readonly flowM3PerS: number;
  readonly cylinderPressurePa: number;
  readonly downstreamLossPa: number;
  readonly downstreamLossSource: string;
  readonly seriesDrops: readonly DutyPressureDrop[];
  readonly tankPressurePa: number;
  readonly drainBoundary?: ControlDrainBoundary;
  readonly budgetPa: number;
  readonly densityKgPerM3: number;
}

/** Inverts the existing local steady constitutive laws at the requested flow and downstream pressure. */
export function estimateDutyControlValve(
  paths: DutyPhasePaths,
  input: ValveDutyInput,
): Result<{ readonly dropPa: number; readonly steps: readonly CalculationStep[]; readonly budgetIssue?: string }> {
  const { component, phaseName, flowM3PerS: flow, densityKgPerM3: rho } = input;
  const label = `${phaseName} / ${component.label || component.id}`;
  const fail = (reason: string): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/control-valve', `${label} [${component.id}]：${reason}`)],
  });
  const pump = input.pumpId + ':P',
    tank = input.tankId + ':T';
  const route = paths.uniquePath(pump, input.actuatorInlet);
  const suction = paths.uniquePath(tank, input.pumpId + ':S');
  const drain = paths.uniquePath(input.actuatorOutlet, tank);
  if (!route || !suction || !drain) return fail('吸油、供油或回油通路不唯一。当前不核算并联与旁路分流。');
  const includesValve = (arcs: typeof route) => arcs.some((arc) => arc.component?.id === component.id);
  const valveIndex = route.findIndex((arc) => arc.component?.id === component.id);
  if (valveIndex < 0 || includesValve(suction) || includesValve(drain)) return fail('控制阀须正向串联在缸的供油路。');
  const seriesDrop = (arc: (typeof route)[number]) =>
    input.seriesDrops.find((drop) => drop.from === arc.from && drop.to === arc.to)?.dropPa;
  let upstreamLossPa = 0;
  for (const arc of route.slice(0, valveIndex)) {
    if (arc.ideal || (arc.component && input.seriesControls?.has(arc.component.id))) continue;
    const drop = seriesDrop(arc);
    if (drop === undefined)
      return fail('P 口上游只允许理想油路或已核算的串联流量计，其他串联阀或物理管的阀前压降待核。');
    upstreamLossPa += drop;
  }
  const downstreamMeterLossPa = route.slice(valveIndex + 1).reduce((sum, arc) => sum + (seriesDrop(arc) ?? 0), 0);
  const isFlowValve = component.typeId === 'pressure-compensated-flow';
  if (!isFlowValve && !input.drainBoundary) return fail('Y 泄油口须经理想油路直接回同一油箱。');

  const parameters = component.parameters.hydraulic;
  const coefficient = parameters?.flowCoefficient;
  const area = isFlowValve ? parameters?.meteringAreaM2 : parameters?.maximumAreaM2;
  if (coefficient === undefined || area === undefined || coefficient <= 0 || rho <= 0)
    return fail('缺少有效开口、流量系数或油液密度。');
  if (area <= 0) return fail('阀口关闭，不能通过目标正流量。');
  const downstreamLossPa = input.downstreamLossPa + downstreamMeterLossPa;
  const outletPa = input.cylinderPressurePa + downstreamLossPa;
  const yPa = input.drainBoundary?.pressurePa ?? input.tankPressurePa;
  const fullDropPa = (rho / 2) * (flow / (coefficient * area)) ** 2;
  if (!Number.isFinite(fullDropPa) || !Number.isFinite(outletPa)) return fail('目标流量或压力超出有限数值范围。');

  const known = (reference: string, value: number, unit: string, source: string): CalculationInput => ({
    reference,
    value: { kind: 'known', value },
    unit,
    source,
  });
  const saved = (reference: string, value: number, unit: string) =>
    known(reference, value, unit, 'saved-parameter:' + component.id);
  const steps: CalculationStep[] = [];
  const add = (
    key: string,
    title: string,
    formula: string,
    value: number,
    unit: string,
    inputs: readonly CalculationInput[],
    scale = 1,
    displayUnit = unit,
  ) => {
    steps.push({
      key: `phase${input.phaseIndex}:${component.id}:${key}`,
      label: label + ' ' + title,
      source: 'preliminary',
      formula,
      unit,
      inputs,
      substitution: calculationSubstitution(inputs),
      value: { kind: 'known', value },
      display: {
        unit: displayUnit,
        value: { kind: 'known', value: value * scale },
        conversion: `显示值=SI值×${scale}`,
      },
    });
  };
  const q = known('q', flow, 'm³/s', '油缸进油需求');
  const density = known('rho', rho, 'kg/m³', 'saved-fluid-density');
  const cq = saved('Cq', coefficient, '1');
  const pY = known(
    'pY',
    yPa,
    'Pa',
    input.drainBoundary?.reference === 'return' ? '主回油取压点稳态压力' : 'saved-tank-pressure:' + input.tankId,
  );
  const display = (value: number) => Number(value.toPrecision(6));
  for (const pipe of input.drainBoundary?.pipes ?? []) {
    add(
      'control-return-pipe:' + pipe.connectionId,
      `回油管 [${pipe.connectionId}]，${display(pipe.flowM3PerS * 60000)} L/min，${pipe.regime}`,
      'dpPipe=dpF+dpK',
      pipe.pressureDropPa,
      'Pa',
      [known('dpF', pipe.frictionDropPa, 'Pa', '管段沿程压降'), known('dpK', pipe.localDropPa, 'Pa', '管段局部压降')],
      1e-3,
      'kPa',
    );
  }
  add(
    'control-outlet',
    'A 口压力需求',
    'pA=pCylinder+dpDownstream',
    outletPa,
    'Pa',
    [
      known('pCylinder', input.cylinderPressurePa, 'Pa', '缸进油腔稳态需求'),
      known(
        'dpDownstream',
        downstreamLossPa,
        'Pa',
        downstreamMeterLossPa ? '手填阀后其余压降与已核算流量计压降' : input.downstreamLossSource,
      ),
    ],
    1e-6,
    'MPa',
  );
  add('control-flow', '目标正向流量（P→A）', '油缸进油需求', flow, 'm³/s', [q], 60000, 'L/min');
  let dropPa: number;
  let budgetIssue: string | undefined;
  let effectiveArea = area;
  if (isFlowValve) {
    const compensation = parameters?.compensationDifferentialPa;
    if (compensation === undefined || compensation <= 0) return fail('缺少有效补偿压差。');
    const capacity = coefficient * area * Math.sqrt((2 * compensation) / rho);
    if (flow > capacity * (1 + 1e-10))
      return fail(`目标流量超过补偿上限 ${Number((capacity * 60000).toPrecision(6))} L/min，增加供油压力无法补足。`);
    const compensated = flow >= capacity * (1 - 1e-10);
    dropPa = compensated ? compensation : fullDropPa;
    add(
      'compensated-capacity',
      '补偿流量上限',
      'qLimit=Cq*Aeff*sqrt(2*dpComp/rho)',
      capacity,
      'm³/s',
      [cq, saved('Aeff', area, 'm²'), saved('dpComp', compensation, 'Pa'), density],
      60000,
      'L/min',
    );
    add('compensation-threshold', '补偿压差门槛', 'model parameter', compensation, 'Pa', [], 1e-3, 'kPa');
    add(
      'control-regime',
      compensated ? '达到补偿门槛' : '低于补偿门槛，按孔口流量核算',
      compensated ? '采用补偿门槛压差' : '按计量开口估算',
      dropPa,
      'Pa',
      [],
      1e-3,
      'kPa',
    );
  } else {
    const setting = parameters?.controlSettingPa;
    const band = parameters?.regulationBandPa;
    if (setting === undefined || band === undefined || setting <= 0 || band <= 0)
      return fail('缺少有效控制设定或调节带宽。');
    const threshold = yPa + setting;
    const reducer = component.typeId === 'pressure-reducing';
    add('control-drain', 'Y 泄油口压力', 'model parameter', yPa, 'Pa', [pY], 1e-6, 'MPa');
    if (input.drainBoundary?.coupled)
      add(
        'control-drain-flow',
        input.drainBoundary.leakM3PerS === undefined ? 'Y 口参考流量（零流量模型）' : 'P→Y 实测净泄流',
        '本工况泄流条件',
        input.drainBoundary.leakM3PerS ?? 0,
        'm³/s',
        [],
        60000,
        'L/min',
      );
    add(
      'control-threshold',
      reducer ? 'A 口关闭阈值' : 'P 口开启门槛',
      'pThreshold=pY+setting',
      threshold,
      'Pa',
      [pY, saved('setting', setting, 'Pa')],
      1e-6,
      'MPa',
    );
    if (reducer) {
      const margin = threshold - outletPa;
      const fraction = margin <= 1e-6 ? 0 : Math.min(1, margin / band);
      if (fraction <= 0) {
        const reason = '所需 A−Y 压力达到或超过减压设定，阀口关闭，目标正流量无法成立。';
        if (!input.drainBoundary?.coupled) return fail(reason);
        const mp = (p: number) => display(p / 1e6) + ' MPa';
        return {
          ok: false,
          diagnostics: [
            diagnostic(
              'DUTY_TARGET_BLOCKED',
              '/duty/control-valve',
              label +
                '：' +
                reason +
                '目标 A 口 ' +
                mp(outletPa) +
                '，Y 口 ' +
                mp(yPa) +
                '，A 口关闭阈值 ' +
                mp(threshold) +
                '。',
            ),
          ],
        };
      }
      effectiveArea = area * fraction;
      dropPa = fullDropPa / (fraction * fraction);
      add(
        'control-opening',
        '减压阀开口比例' + (input.drainBoundary?.coupled ? (fraction === 1 ? '（全开）' : '（调节区）') : ''),
        'f=clip((setting+pY-pA)/band)',
        fraction,
        '1',
        [
          pY,
          known('pA', outletPa, 'Pa', '阀 A 口压力需求'),
          saved('setting', setting, 'Pa'),
          saved('band', band, 'Pa'),
        ],
        100,
        '%',
      );
    } else {
      const lower = Math.max(outletPa, threshold);
      let lo = lower;
      let hi = Math.max(threshold + band, outletPa + fullDropPa);
      const fraction = (p: number) => Math.max(0, Math.min(1, (p - threshold) / band));
      for (let i = 0; i < 64; i++) {
        const p = lo + (hi - lo) / 2;
        const capacity = coefficient * area * fraction(p) * Math.sqrt((2 * (p - outletPa)) / rho);
        if (capacity < flow) lo = p;
        else hi = p;
      }
      dropPa = hi - outletPa;
      const opening = fraction(hi);
      effectiveArea = area * opening;
      add(
        'control-opening',
        '顺序阀开口比例' + (input.drainBoundary?.coupled ? (opening === 1 ? '（全开）' : '（调节区）') : ''),
        'f=clip((pP-pY-setting)/band)',
        opening,
        '1',
        [
          pY,
          known('pP', hi, 'Pa', '按目标流量求得的入口压力'),
          saved('setting', setting, 'Pa'),
          saved('band', band, 'Pa'),
        ],
        100,
        '%',
      );
      const inletBudgetPa = input.budgetPa - upstreamLossPa;
      if (inletBudgetPa <= threshold) {
        if (input.drainBoundary?.coupled)
          budgetIssue = `阀 P 口可用预算 ${display(inletBudgetPa / 1e6)} MPa 未超过开启门槛 ${display(threshold / 1e6)} MPa，顺序阀无法开启。`;
        add(
          'sequence-budget',
          '供油预算未超过开启门槛，顺序阀无法开启',
          '预算与开启门槛之差',
          inletBudgetPa - threshold,
          'Pa',
          [],
          1e-3,
          'kPa',
        );
      }
    }
  }
  const inletPa = outletPa + dropPa;
  const pumpOutletPa = inletPa + upstreamLossPa;
  if (!Number.isFinite(pumpOutletPa) || pumpOutletPa > 70e6 || inletPa <= outletPa || effectiveArea <= 0)
    return fail('目标工况所需压降超出本次可核算的压力范围。');
  add(
    'control-drop',
    '阀本体压降（P−A）',
    'dp=rho*(q/(Cq*Aeff))^2/2',
    dropPa,
    'Pa',
    [q, cq, density, known('Aeff', effectiveArea, 'm²', '当前阀口有效开口')],
    1e-3,
    'kPa',
  );
  add(
    'control-inlet',
    'P 口所需供油压力',
    'pP=pA+dpValve',
    inletPa,
    'Pa',
    [known('pA', outletPa, 'Pa', '阀 A 口压力需求'), known('dpValve', dropPa, 'Pa', '阀本体压降')],
    1e-6,
    'MPa',
  );
  if (upstreamLossPa > 0)
    add(
      'control-pump-outlet',
      '泵出口压力需求（计入阀前流量计）',
      'pPump=pP+dpUpstream',
      pumpOutletPa,
      'Pa',
      [
        known('pP', inletPa, 'Pa', '控制阀 P 口压力需求'),
        known('dpUpstream', upstreamLossPa, 'Pa', '阀前串联流量计压降'),
      ],
      1e-6,
      'MPa',
    );
  return { ok: true, value: { dropPa, steps, ...(budgetIssue ? { budgetIssue } : {}) } };
}

/** Reconstruct each upstream working point from the measured downstream load. */
export function estimateSeriesControlValves(
  paths: DutyPhasePaths,
  input: ValveDutyInput,
  controls: readonly NetworkComponent[],
): ReturnType<typeof estimateDutyControlValve> {
  if (controls.length === 1) return estimateDutyControlValve(paths, input);
  const ids = new Set(controls.map((c) => c.id)),
    route = paths.uniquePath(input.pumpId + ':P', input.actuatorInlet);
  const order = route?.flatMap((a) =>
    a.component && ids.has(a.component.id) && a.from === a.component.id + ':P' && a.to === a.component.id + ':A'
      ? [a.component]
      : [],
  );
  if (
    order?.length !== controls.length ||
    new Set(order).size !== controls.length ||
    controls.some((c) => !paths.idealReachable(c.id + ':Y', input.tankId + ':T'))
  )
    return {
      ok: false,
      diagnostics: [
        diagnostic('DUTY_UNSUPPORTED', '/duty/control-valves', '串联双压力阀必须都在唯一正向供油路上且 Y 直回同箱。'),
      ],
    };
  let dropPa = 0;
  const steps: CalculationStep[] = [];
  const issues: string[] = [];
  for (const c of order.reverse()) {
    const result = estimateDutyControlValve(paths, {
      ...input,
      component: c,
      seriesControls: ids,
      cylinderPressurePa: input.cylinderPressurePa + dropPa,
      drainBoundary: { reference: 'tank', pressurePa: input.tankPressurePa, coupled: false, pipeDropPa: 0, pipes: [] },
    });
    if (!result.ok) return result;
    dropPa += result.value.dropPa;
    steps.push(...result.value.steps);
    if (result.value.budgetIssue) issues.push(result.value.budgetIssue);
  }
  return { ok: true, value: { dropPa, steps, ...(issues.length ? { budgetIssue: issues.join('。') } : {}) } };
}
