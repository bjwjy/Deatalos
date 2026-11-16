import { diagnostic, type NetworkComponent, type NetworkProject, type Result } from '@hyd/domain';
import type { DutyPhasePaths, DutyPressureDrop } from './network-duty-accessories.js';
import {
  pipeParameters,
  reportFilterOutletReturnPipes,
  reportReturnPipe,
  type ReturnPipeResult,
} from './network-duty-return-pipes.js';
import type { CalculationInput } from './network-learning.js';
import type { PilotReturnResult } from './network-duty-pilot-return.js';

export const dutyMultiPortValveTypes: ReadonlySet<string> = new Set([
  'pilot-check',
  'pressure-reducing-relieving',
  'three-way-flow-control',
]);

export const multiPortValveCommonConditions = [
  '本批限一只多口阀和一个双作用缸。泵经理想油路从主油箱吸油。经阀排油时，缸容积效率取 1，以排油腔面积和速度计算排油量。',
  '压力与流量为目标点需求，仍须满足实际供流、压力预算及溢流边界。液控单向阀和三通溢流减压阀工况的泵余流须另核卸荷与发热。',
] as const;

export const multiPortValveConditions: Readonly<Record<string, string>> = {
  'pilot-check':
    '一只液控单向阀的 B 口接受控缸腔，X 口直接取另一缸腔压力。三口内泄以 A 口为先导参考，四口外泄以实际 Y 口压力为参考。B→A 仅校核目标稳态点能否维持全开。回油基础压力须扣除已单列的液控单向阀和过滤器压降。保压泄漏、解压冲击和交叉先导双阀另验。',
  'pressure-reducing-relieving':
    '三通溢流减压阀 A 口直接接受控缸腔，T 口经理想油路或一段物理管回同一油箱。进油 P→A 时 T 无流量；泄放 A→T 时按排油量计 T 管压降及开启门槛。基础回油压力取油箱，外载驱动与过压瞬态另验。',
  'three-way-flow-control':
    '三通调速阀在主供油路，P 口直接接定量泵，T 口直接回油箱。其余供油压降填写阀 A 口到缸进油腔。按泵保存排量及核算转速、效率估计供流，目标工作流量与旁通流量之和须与该供流匹配。泵溢流开启后的实际分流另验。',
};
export const pilotCheckFilterCondition =
  '过滤器仅用于缸排油侧。B→A 解锁排油时，A 口压力等于回油基础压力加已核算的回油压降，B 口再加液控单向阀压降。A→B 自由进油时，回油压降计入另一缸腔背压。Y 口取已解回油节点或独立泄油箱的压力。教学模型中 Y 支路稳态流量为零。';
export const pilotCheckOutletPipeCondition =
  '回油管段按各自保存参数计算。串联压降相加，并联各支路压差相等且流量之和等于缸排油量。清洁滤芯按 A→B 实际支路流量核对额定范围。管阻层流采用 64/Re，湍流采用 Colebrook，过渡区按两端摩擦系数插值。回油基础压力须扣除已计算的管路、回油元件和液控阀压降。';

const pipeSeriesTotal = [
  undefined,
  undefined,
  { label: '两段回油管合计压降', formula: 'dpPipe=dpPipe1+dpPipe2' },
  { label: '三段回油管合计压降', formula: 'dpPipe=dpPipe1+dpPipe2+dpPipe3' },
  { label: '四段回油管合计压降', formula: 'dpPipe=dpPipe1+dpPipe2+dpPipe3+dpPipe4' },
] as const;

interface ValveInput {
  readonly component: NetworkComponent;
  readonly phaseName: string;
  readonly phaseIndex: number;
  readonly pumpId: string;
  readonly tankId: string;
  readonly inlet: string;
  readonly outlet: string;
  readonly tankPressurePa: number;
  readonly baseReturnPa: number;
  readonly baseReturnSource: string;
  readonly returnFilter: DutyPressureDrop | undefined;
  readonly solvedReturn?: PilotReturnResult;
  readonly supplyLossPa: number;
  readonly drivePressurePa: number;
  readonly areaRatio: number;
  readonly inletFlow: number;
  readonly outletFlow: number;
  readonly actuatorEfficiency: number;
  readonly density: number;
  readonly pumpFlow: number;
}

interface ValveResult {
  readonly supplyDropPa: number;
  readonly returnPressurePa: number;
  readonly returnPipeDropPa: number;
  readonly pumpFlow: number;
  readonly supplyBalanceIssue?: string;
}

type AddStep = (
  key: string,
  label: string,
  formula: string,
  value: number,
  unit: string,
  inputs: readonly CalculationInput[],
  scale?: number,
  displayUnit?: string,
) => void;

const clip = (value: number) => Math.max(0, Math.min(1, value));
export const threeWayDutyFlowMatches = (available: number, required: number) =>
  Math.abs(available - required) <= required * 1e-10;

/** Resolve one explicitly piped valve at a positive target cylinder speed. */
export function estimateDutyMultiPortValve(
  project: NetworkProject,
  paths: DutyPhasePaths,
  input: ValveInput,
  add: AddStep,
): Result<ValveResult> {
  const { component, inlet, outlet, inletFlow, outletFlow, density, tankPressurePa } = input;
  const returnFilterDropPa = input.returnFilter?.dropPa ?? 0;
  const baseReturnPa = input.baseReturnPa + returnFilterDropPa;
  const label = input.phaseName + ' / ' + (component.label || component.id);
  const fail = (reason: string): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/multi-port-valve', `${label} [${component.id}]：${reason}`)],
  });
  const port = (name: string) => component.id + ':' + name;
  const pump = input.pumpId + ':P',
    tank = input.tankId + ':T';
  const feed = paths.uniquePath(pump, inlet);
  const drain = input.solvedReturn ? paths.path(outlet, tank) : paths.uniquePath(outlet, tank);
  if (
    !feed ||
    !drain ||
    !paths.uniquePath(tank, input.pumpId + ':S') ||
    !paths.idealReachable(tank, input.pumpId + ':S')
  )
    return fail('供油和回油须各有唯一通路，泵 S 口须经理想油路从同一油箱吸油。');
  const onFeed = feed.some((arc) => arc.component?.id === component.id);
  const onDrain = drain.some((arc) => arc.component?.id === component.id);
  if (onFeed === onDrain) return fail('该阀须串联于当前缸腔的进油或排油路径，不能同时经过两路。');
  if (onDrain && input.actuatorEfficiency !== 1) return fail('经阀排油量采用排油腔扫掠体积，要求执行器容积效率为 1。');
  const h = component.parameters.hydraulic;
  const coefficient = h?.flowCoefficient;
  const area = h?.maximumAreaM2;
  if (coefficient === undefined || area === undefined || coefficient <= 0 || area <= 0 || density <= 0)
    return fail('缺少有效阀口面积、流量系数或油液密度。');
  const conductance = coefficient * area * Math.sqrt(2 / density);
  const orificeDrop = (q: number, opening = 1) => (q / (conductance * opening)) ** 2;
  const chamberPressure = (backPressure: number) => input.drivePressurePa + input.areaRatio * backPressure;
  const source = '稳态阀模型:' + component.id;
  const known = (reference: string, value: number, unit: string, origin = source): CalculationInput => ({
    reference,
    value: { kind: 'known', value },
    unit,
    source: origin,
  });
  const step = (
    key: string,
    title: string,
    value: number,
    unit: 'Pa' | 'm³/s' | 'm/s' | '1' | '%',
    formula = '稳态结果',
    inputs: readonly CalculationInput[] = [],
  ) => {
    const display = {
      Pa: [1e-6, 'MPa'],
      'm³/s': [60000, 'L/min'],
      'm/s': [1, 'm/s'],
      '1': [1, '1'],
      '%': [100, '%'],
    } as const;
    const [scale, displayUnit] = display[unit];
    add(
      `phase${input.phaseIndex}:${component.id}:${key}`,
      label + ' ' + title,
      formula,
      value,
      unit === '%' ? '1' : unit,
      inputs,
      scale,
      displayUnit,
    );
  };
  const finish = (
    supplyDropPa: number,
    returnPressurePa: number,
    pumpFlow = inletFlow,
    returnPipeDropPa = 0,
  ): Result<ValveResult> => {
    const pressure = chamberPressure(returnPressurePa) + input.supplyLossPa + supplyDropPa;
    if (!Number.isFinite(pressure) || pressure > 70e6 || returnPressurePa > 70e6 || !Number.isFinite(pumpFlow))
      return fail('目标工况所需压力或流量超出本模型计算范围。');
    return { ok: true, value: { supplyDropPa, returnPressurePa, returnPipeDropPa, pumpFlow } };
  };
  const flowText = (q: number) => Number((q * 60000).toPrecision(7));
  if (component.typeId === 'pilot-check') {
    const external = component.definition.id === 'teaching:pilot-check';
    if (
      !paths.idealReachable(port('B'), onFeed ? inlet : outlet) ||
      !paths.idealReachable(port('X'), onFeed ? outlet : inlet)
    )
      return fail('B 口须经理想油路直连受控缸腔，X 口直取另一缸腔。');
    let yFilterDropPa: number | undefined;
    let returnPipes: readonly ReturnPipeResult[] = [];
    const solved = input.solvedReturn;
    if (solved) {
      step('pilot-y-flow', 'Y 口稳态流量（教学取压模型）', 0, 'm³/s', 'model parameter');
      const basePort = onDrain ? port('A') : outlet;
      if (paths.idealReachable(basePort, solved.from) && Math.abs(input.baseReturnPa - tankPressurePa) > 1e-6)
        return fail('回油基础压力与油箱压力不一致。已求解的回油压力须以主油箱为基准。');
    } else if (external && !paths.idealReachable(port('Y'), tank)) {
      const filter = input.returnFilter;
      if (!filter || !paths.idealReachable(port('Y'), filter.from))
        return fail('Y 口须经理想油路接同一油箱或本工况通流的缸回油滤芯入口。其他取压点的先导参考压力待核。');
      if (!paths.idealReachable(filter.to, tank)) {
        const pipes = reportFilterOutletReturnPipes(project, paths, filter.to, tank, outletFlow, tankPressurePa);
        if (!pipes.ok) return fail(pipes.diagnostics.map((item) => item.message).join('；'));
        returnPipes = pipes.value;
      }
      const basePort = onDrain ? port('A') : outlet;
      if (paths.idealReachable(basePort, filter.from) && Math.abs(input.baseReturnPa - tankPressurePa) > 1e-6)
        return fail(
          '回油基础压力与油箱压力不一致。排油侧与 Y 同接滤芯入口时，基础压力须取油箱压力，滤芯及已核算的管路压降由软件另计。',
        );
      yFilterDropPa = filter.dropPa;
    }
    const hasPipe = returnPipes.length > 0;
    const seriesTotal = pipeSeriesTotal[returnPipes.length];
    const returnPipeDropPa = solved?.totalDropPa ?? returnPipes.reduce((total, pipe) => total + pipe.pressureDropPa, 0);
    const pilotReturnPa = baseReturnPa + returnPipeDropPa;
    const yPressurePa = solved?.yPressurePa ?? tankPressurePa + (yFilterDropPa ?? 0) + returnPipeDropPa;
    const crack = h?.openingDifferentialPa;
    const ratio = h?.pilotRatio;
    if (crack === undefined || ratio === undefined) return fail('缺少开启压差或先导比。');
    const orificeInputs = (flow: number) => [
      known('q', flow, 'm³/s'),
      known('rho', density, 'kg/m³', 'saved-fluid-density'),
      known('Cq', coefficient, '1', 'saved-parameter:' + component.id),
      known('Aeff', area, 'm²', 'saved-parameter:' + component.id),
    ];
    const pipeLabel = (pipe: ReturnPipeResult) => '回油管 [' + pipe.connectionId + ']';
    const pipeInputs = hasPipe ? [known('dpPipe', returnPipeDropPa, 'Pa', '滤芯出口回油管压降')] : [];
    for (const [index, returnPipe] of returnPipes.entries()) {
      const pipeSource = pipeLabel(returnPipe);
      const suffix = returnPipes.length > 1 ? ':' + (index + 1) : '';
      if (returnPipes.length <= 4) {
        const diameter = known('D', returnPipe.diameterM, 'm', pipeSource);
        const velocity = known('u', returnPipe.velocityMPerS, 'm/s');
        const dynamic = [known('rho', returnPipe.densityKgPerM3, 'kg/m³', 'saved-fluid-density'), velocity];
        step('pipe-velocity' + suffix, pipeSource + ' 平均流速', returnPipe.velocityMPerS, 'm/s', 'u=4*q/(pi*D^2)', [
          known('q', outletFlow, 'm³/s', '缸排油量'),
          diameter,
        ]);
        step(
          'pipe-reynolds' + suffix,
          pipeSource + ' 雷诺数（' + returnPipe.regime + '）',
          returnPipe.reynolds,
          '1',
          'Re=u*D/nu',
          [velocity, diameter, known('nu', returnPipe.kinematicViscosityM2PerS, 'm²/s', 'saved-fluid-viscosity')],
        );
        if (returnPipe.frictionFactor === undefined)
          step('pipe-friction' + suffix, pipeSource + ' 沿程压降（静止）', returnPipe.frictionDropPa, 'Pa');
        else
          step(
            'pipe-friction' + suffix,
            pipeSource + ' 沿程压降',
            returnPipe.frictionDropPa,
            'Pa',
            'dpF=f*(L/D)*rho*u^2/2',
            [
              known('f', returnPipe.frictionFactor, '1', returnPipe.regime),
              known('L', returnPipe.lengthM, 'm', pipeSource),
              diameter,
              ...dynamic,
            ],
          );
        step('pipe-local' + suffix, pipeSource + ' 局部压降', returnPipe.localDropPa, 'Pa', 'dpK=K*rho*u^2/2', [
          known('K', returnPipe.localLossCoefficient, '1', pipeSource),
          ...dynamic,
        ]);
      }
      step('pipe-total' + suffix, pipeSource + ' 管路总压降', returnPipe.pressureDropPa, 'Pa', 'dpPipe=dpF+dpK', [
        known('dpF', returnPipe.frictionDropPa, 'Pa'),
        known('dpK', returnPipe.localDropPa, 'Pa'),
      ]);
    }
    if (returnPipes.length > 1)
      step(
        'pipe-series-total',
        seriesTotal?.label ?? '回油管合计压降',
        returnPipeDropPa,
        'Pa',
        seriesTotal?.formula ?? 'dpPipe=sum(dpPipe_i)',
        returnPipes.map((pipe, index) => known('dpPipe' + (index + 1), pipe.pressureDropPa, 'Pa', pipeLabel(pipe))),
      );
    if (solved) {
      for (const [index, device] of solved.devices.entries()) {
        const title = device.label + ' [' + device.id + ']';
        step('return-device-flow:' + index, title + ' 稳态流量（沿连接定义方向）', device.flow, 'm³/s');
        step('return-device-drop:' + index, title + ' 回油压降', device.dropPa, 'Pa');
      }
      step('return-network-drop', '主回油通路压降', solved.totalDropPa, 'Pa');
      step(
        'pilot-reference',
        'Y 口先导参考压力（' + (solved.yTankId === input.tankId ? '回油取压点' : '独立泄油箱') + '）',
        yPressurePa,
        'Pa',
        'pY=pTank+dpTap',
        [
          known('pTank', solved.yTankPressurePa, 'Pa', 'saved-tank-pressure:' + solved.yTankId),
          known('dpTap', yPressurePa - solved.yTankPressurePa, 'Pa', '回油取压点至油箱压差'),
        ],
      );
    } else if (external) {
      const tankInput = known('pTank', tankPressurePa, 'Pa', 'saved-tank-pressure:' + input.tankId);
      if (yFilterDropPa === undefined)
        step('pilot-reference', 'Y 口先导参考压力（理想回箱）', yPressurePa, 'Pa', 'model parameter', [tankInput]);
      else
        step(
          'pilot-reference',
          'Y 口先导参考压力（滤芯入口背压）',
          yPressurePa,
          'Pa',
          hasPipe ? 'pY=pTank+dpFilter+dpPipe' : 'pY=pTank+dpFilter',
          [tankInput, known('dpFilter', yFilterDropPa, 'Pa', '清洁回油过滤器压降'), ...pipeInputs],
        );
    }
    if (onFeed) {
      const pB = chamberPressure(pilotReturnPa);
      const drop = crack + orificeDrop(inletFlow);
      const result = finish(drop, pilotReturnPa, inletFlow, returnPipeDropPa);
      if (!result.ok) return result;
      step('pilot-flow', '自由方向 A→B 通流量', inletFlow, 'm³/s');
      step('pilot-crack', '自由方向开启压差', crack, 'Pa');
      step('pilot-drop', 'A→B 阀本体压降', drop, 'Pa', 'pilotDrop=crack+rho*(q/(Cq*Aeff))^2/2', [
        known('crack', crack, 'Pa', 'saved-parameter:' + component.id),
        ...orificeInputs(inletFlow),
      ]);
      step('pilot-load', 'B 口负载压力', pB, 'Pa');
      step('pilot-supply', 'A 口压力需求', pB + drop, 'Pa');
      return result;
    }
    const pA = pilotReturnPa;
    const drop = orificeDrop(outletFlow);
    const pB = pA + drop;
    const pX = chamberPressure(pB);
    const reference = external ? yPressurePa : pA;
    const need = reference + (pB - reference + crack) / ratio;
    const margin = pX - need;
    if (!(margin > 0)) {
      const refLabel = external ? 'Y 口' : 'A 口';
      const kPa = (pa: number) => Number((pa / 1e3).toPrecision(6)) + ' kPa';
      const pipeReason =
        returnPipes.length <= 4
          ? returnPipes.map((pipe) => `${pipeLabel(pipe)} 压降 ${kPa(pipe.pressureDropPa)}。`).join('')
          : '';
      const totalReason =
        solved || returnPipes.length > 1 ? `${seriesTotal?.label ?? '主回油通路压降'} ${kPa(returnPipeDropPa)}。` : '';
      return fail(
        `B→A 先导压力不足，阀不能维持解锁。${pipeReason}${totalReason}${refLabel}参考压力 ${Number((reference / 1e6).toPrecision(6))} MPa，X 口 ${Number((pX / 1e6).toPrecision(6))} MPa，须高于 ${Number((need / 1e6).toPrecision(6))} MPa，解锁裕量 ${kPa(margin)}。`,
      );
    }
    const result = finish(0, pB, inletFlow, returnPipeDropPa);
    if (!result.ok) return result;
    step('pilot-flow', '解锁方向 B→A 排油量', outletFlow, 'm³/s');
    const base = known('pBase', input.baseReturnPa, 'Pa', input.baseReturnSource);
    if (solved)
      step('pilot-return', 'A 口回油压力', pA, 'Pa', 'sum=pBase+dpDevices', [
        base,
        known('dpDevices', solved.totalDropPa, 'Pa', '主回油通路压降'),
      ]);
    else if (returnFilterDropPa > 0)
      step(
        'pilot-return',
        hasPipe ? 'A 口回油压力（计入滤芯及回油管）' : 'A 口回油压力（计入滤芯）',
        pA,
        'Pa',
        hasPipe ? 'pA=pBase+dpFilter+dpPipe' : 'pA=pBase+dpFilter',
        [base, known('dpFilter', returnFilterDropPa, 'Pa', '清洁回油过滤器压降'), ...pipeInputs],
      );
    else step('pilot-return', 'A 口回油基础压力', pA, 'Pa', 'model parameter', [base]);
    step('pilot-drop', 'B→A 阀本体压降', drop, 'Pa', 'dp=rho*(q/(Cq*Aeff))^2/2', orificeInputs(outletFlow));
    step('pilot-load', 'B 口负载压力', pB, 'Pa', 'pB=pA+dpPilot', [
      known('pA', pA, 'Pa'),
      known('dpPilot', drop, 'Pa'),
    ]);
    step('pilot-signal', '目标工况 X 口先导压力', pX, 'Pa', 'pX=pDrive+areaRatio*pB', [
      known('pDrive', input.drivePressurePa, 'Pa', '阻性负载折算压力'),
      known('areaRatio', input.areaRatio, '1', '排油腔与进油腔面积比'),
      known('pB', pB, 'Pa'),
    ]);
    if (!external) step('pilot-reference', 'A 口先导参考压力', reference, 'Pa');
    step('pilot-threshold', 'X 口维持开启门槛', need, 'Pa', 'pXmin=pRef+(pB-pRef+crack)/r', [
      known('pRef', reference, 'Pa'),
      known('pB', pB, 'Pa'),
      known('crack', crack, 'Pa'),
      known('r', ratio, '1'),
    ]);
    step('pilot-margin', '稳态解锁裕量', margin, 'Pa', 'margin=pX-pXmin', [
      known('pX', pX, 'Pa'),
      known('pXmin', need, 'Pa'),
    ]);
    return result;
  }
  const band = h?.regulationBandPa;
  if (band === undefined || band <= 0) return fail('缺少有效调节带。');
  if (component.typeId === 'pressure-reducing-relieving') {
    if (!paths.idealReachable(port('A'), onFeed ? inlet : outlet))
      return fail('三通溢流减压阀 A 口须经理想油路直连受控缸腔。');
    const setting = h?.reducingRelievingSettingPa;
    if (setting === undefined) return fail('缺少减压与泄放设定。');
    const tankRoute = paths.uniquePath(port('T'), tank);
    const physical = tankRoute?.flatMap((arc) => (arc.physicalPipe ? [arc.physicalPipe] : []));
    if (
      !tankRoute ||
      !physical ||
      physical.length > 1 ||
      tankRoute.some((arc) => !arc.ideal && !arc.physicalPipe) ||
      project.design.connections.filter((edge) => edge.kind === 'pipe').length !== physical.length
    )
      return fail('T 口须经唯一理想通路或一段物理管直接回同一油箱，其他有损或并联通路待核。');
    const [pipe] = physical;
    let pipeDrop = 0;
    let tPressure = tankPressurePa;
    if (pipe) {
      if (Math.abs(input.baseReturnPa - tankPressurePa) > 1e-6) return fail('T 口带损管的回油基准须取油箱压力。');
      const parameters = pipeParameters(project, pipe, '三通溢流减压阀 T 口管');
      if (!parameters.ok) return parameters;
      const row = reportReturnPipe(parameters.value, onFeed ? 0 : outletFlow, tankPressurePa);
      if (!row.ok) return row;
      pipeDrop = row.value.pressureDropPa;
      tPressure = row.value.upstreamPressurePa;
      const line = `T 口回油管 [${pipe.id}]`;
      step('reducing-t-flow', line + ' 流量', row.value.flowM3PerS, 'm³/s');
      step('reducing-t-friction', line + ' 沿程压降（' + row.value.regime + '）', row.value.frictionDropPa, 'Pa');
      step('reducing-t-local', line + ' 局部压降', row.value.localDropPa, 'Pa');
      step('reducing-t-drop', line + ' 总压降', pipeDrop, 'Pa');
      step('reducing-t-pressure', 'T 口背压', tPressure, 'Pa', 'pT=pTank+dpPipe', [
        known('pTank', tankPressurePa, 'Pa'),
        known('dpPipe', pipeDrop, 'Pa'),
      ]);
    }
    const threshold = tPressure + setting;
    if (onFeed) {
      const pA = chamberPressure(baseReturnPa);
      const fraction = clip((threshold - pA) / band);
      if (!fraction) return fail('A−T 压差达到或超过减压设定，P→A 进油关闭，目标流量不能成立。');
      const drop = orificeDrop(inletFlow, fraction);
      const result = finish(drop, baseReturnPa);
      if (!result.ok) return result;
      step('reducing-flow', 'P→A 减压供油流量', inletFlow, 'm³/s');
      step('reducing-opening', 'P→A 减压供油开口', fraction, '%');
      step('reducing-pA', 'A 口受控压力', pA, 'Pa');
      step('reducing-drop', 'P→A 阀本体压降', drop, 'Pa');
      step('reducing-pP', 'P 口压力需求', pA + drop, 'Pa');
      step('relieving-flow', 'A→T 泄放关闭', 0, 'm³/s');
      step('reducing-threshold', 'P→A 关闭及 A→T 开启门槛', threshold, 'Pa');
      return result;
    }
    if (!paths.uniquePath(port('P'), tank) || paths.reachable(pump, port('P')))
      return fail('A→T 泄放要求 P 口经换向阀隔离泵并回油箱。');
    if (Math.abs(baseReturnPa - tankPressurePa) > 1e-5)
      return fail('A→T 泄放的基础回油压力须填写 T 口油箱压力，阀压降由软件计算。');
    let lo = threshold;
    let hi = Math.max(threshold + band, tPressure + orificeDrop(outletFlow));
    for (let i = 0; i < 64; i++) {
      const mid = lo + (hi - lo) / 2;
      const capacity = conductance * clip((mid - threshold) / band) * Math.sqrt(mid - tPressure);
      if (capacity < outletFlow) lo = mid;
      else hi = mid;
    }
    const result = finish(0, hi, inletFlow, pipeDrop);
    if (!result.ok) return result;
    step('relieving-flow', 'A→T 泄放流量', outletFlow, 'm³/s');
    step('relieving-opening', 'A→T 泄放开口', clip((hi - threshold) / band), '%');
    step('reducing-threshold', 'A→T 泄放开启门槛', threshold, 'Pa');
    step('relieving-drop', 'A→T 阀本体压降', hi - tPressure, 'Pa');
    step('reducing-pA', 'A 口排油压力需求', hi, 'Pa');
    step('reducing-flow', 'P→A 减压供油关闭', 0, 'm³/s');
    return result;
  }
  if (!paths.idealReachable(port('T'), tank)) return fail('阀 T 口须经理想油路直接回同一油箱。');
  if (!onFeed || !paths.idealReachable(pump, port('P')))
    return fail('三通调速阀须正向串联在供油路，P 口经理想油路直接接泵。');
  const nominal = h?.priorityFlowM3PerS;
  const compensation = h?.compensationDifferentialPa;
  if (nominal === undefined || nominal <= 0 || compensation === undefined || compensation <= 0)
    return fail('计量口关闭或缺少有效工作流量、补偿压差。');
  const pA = chamberPressure(baseReturnPa) + input.supplyLossPa;
  const drop = compensation * (inletFlow / nominal) ** 2;
  const pP = pA + drop;
  const fraction = clip((drop - compensation) / band);
  const bypass = conductance * fraction * Math.sqrt(Math.max(0, pP - tankPressurePa));
  const required = inletFlow + bypass;
  const result = finish(drop, baseReturnPa, required);
  if (!result.ok) return result;
  const supplyBalanceIssue = !threeWayDutyFlowMatches(input.pumpFlow, required)
    ? `目标点流量不平衡，泵估计供流 ${flowText(input.pumpFlow)} L/min，工作口需 ${flowText(inletFlow)} L/min，旁通需 ${flowText(bypass)} L/min，合计 ${flowText(required)} L/min。`
    : undefined;
  step('priority-flow', 'P→A 工作口流量', inletFlow, 'm³/s');
  step('bypass-flow', 'P→T 旁通流量', bypass, 'm³/s', 'qBypass=Cq*Aeff*sqrt(2*(pP-pT)/rho)', [
    known('Cq', coefficient, '1'),
    known('Aeff', area * fraction, 'm²'),
    known('pP', pP, 'Pa'),
    known('pT', tankPressurePa, 'Pa'),
    known('rho', density, 'kg/m³'),
  ]);
  step('bypass-opening', fraction === 0 ? '旁通关闭' : fraction === 1 ? '旁通开满' : '旁通处于调节区', fraction, '%');
  step('metering-drop', 'P→A 计量压差', drop, 'Pa', 'dp=dpComp*(q/qNominal)^2', [
    known('dpComp', compensation, 'Pa'),
    known('q', inletFlow, 'm³/s'),
    known('qNominal', nominal, 'm³/s'),
  ]);
  step('priority-pA', 'A 口压力需求', pA, 'Pa');
  step('priority-pP', 'P 口压力需求', pP, 'Pa');
  step('flow', 'P 口总流量（工作＋旁通）', required, 'm³/s', 'qP=qWork+qBypass', [
    known('qWork', inletFlow, 'm³/s'),
    known('qBypass', bypass, 'm³/s'),
  ]);
  step('pump-available', '当前泵估计供流', input.pumpFlow, 'm³/s');
  return supplyBalanceIssue ? { ok: true, value: { ...result.value, supplyBalanceIssue } } : result;
}
