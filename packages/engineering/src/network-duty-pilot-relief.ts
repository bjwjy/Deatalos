import { diagnostic, type NetworkComponent, type Result } from '@hyd/domain';

export const pilotReliefSplitConditions = [
  '内控内泄先导式溢流阀限单泵双缸共用滤芯。P 取供油母线压力。T 可经理想通路直回同一油箱，也可直接或经串联物理管汇入共用滤芯入口。支持一缸先与溢流汇合，另一缸在共用滤芯入口侧汇入。管段数沿工程连接容量。',
  'T 口独立支管仅计先导与主阀合计溢流。提前汇合段另计先汇入的一缸实际排油。滤芯及其下游管段按两缸排油与溢流之和计损。T 口背压为滤芯入口压力与沿 T 口通路各段压降之和。T 直回油箱时，滤芯只计两缸排油。',
  '按 P−T 压差与保存先导设定比较。超过设定后先导级过油，控制腔压差由进油节流孔与先导孔流量平衡求得。主阀受力超过预紧力才开启，开度受弹簧刚度与最大行程限制。泵供流等于两缸进油与溢流回箱量之和。',
  '采用内控内泄准静态模型。管段缺参、两缸排油都在滤芯前的有损管段汇入溢流、并联旁路、外控外泄、多只先导阀并用或切换瞬态待核。',
] as const;

export interface PilotReliefSplitPoint {
  readonly componentId: string;
  readonly label: string;
  readonly inletPressurePa: number;
  readonly returnPressurePa: number;
  readonly pilotCrackingPa: number;
  readonly mainCrackingPa: number;
  readonly pilotFlowM3PerS: number;
  readonly mainFlowM3PerS: number;
  readonly totalFlowM3PerS: number;
  readonly liftM: number;
  readonly state: 'closed' | 'pilot-only' | 'main-open' | 'main-full';
}

export interface PilotReliefLaw {
  readonly atPressure: (inletPressurePa: number, returnPressurePa: number) => PilotReliefSplitPoint;
  readonly differentialAtFlow: (flowM3PerS: number) => number;
}

const positive = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

/** The steady two-stage law of the registered P/T teaching model. */
export function pilotReliefLaw(valve: NetworkComponent, density: number): Result<PilotReliefLaw> {
  const label = valve.label || valve.id;
  const h = valve.parameters.hydraulic;
  const m = valve.parameters.main;
  const setting = h?.settingDifferentialPa;
  const feedArea = h?.feedAreaM2;
  const pilotArea = h?.pilotAreaM2;
  const coefficient = h?.flowCoefficient;
  const diameter = m?.mainDiameterM;
  const stiffness = m?.mainSpringStiffnessNPerM;
  const preload = m?.mainPreloadN;
  const maximumTravel = m?.mainMaximumTravelM;
  if (
    !positive(setting) ||
    !positive(feedArea) ||
    !positive(pilotArea) ||
    !positive(coefficient) ||
    !positive(density) ||
    !positive(diameter) ||
    !positive(stiffness) ||
    preload === undefined ||
    !Number.isFinite(preload) ||
    preload < 0 ||
    !positive(maximumTravel)
  )
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'DUTY_UNSUPPORTED',
          '/duty/pilotRelief',
          label + ' [' + valve.id + '] 缺少有效的先导设定、孔口或主阀芯参数。',
        ),
      ],
    };

  const chamberDropFraction = pilotArea ** 2 / (feedArea ** 2 + pilotArea ** 2);
  const pilotGain = coefficient * feedArea * Math.sqrt((2 * chamberDropFraction) / density);
  const mainGain = coefficient * Math.PI * diameter * Math.sqrt(2 / density);
  const forceSlope = ((Math.PI * diameter ** 2) / 4) * chamberDropFraction;
  const mainCrackingPa = setting + preload / forceSlope;
  const pilotAtMainCracking = pilotGain * Math.sqrt(mainCrackingPa - setting);
  const liftAt = (differential: number) =>
    Math.min(maximumTravel, Math.max(0, ((differential - setting) * forceSlope - preload) / stiffness));
  const pilotFlowAt = (differential: number) => pilotGain * Math.sqrt(Math.max(0, differential - setting));
  const mainFlowAt = (differential: number, lift: number) => mainGain * lift * Math.sqrt(Math.max(0, differential));

  const atPressure = (inletPressurePa: number, returnPressurePa: number): PilotReliefSplitPoint => {
    const differential = inletPressurePa - returnPressurePa;
    const pilotFlowM3PerS = inletPressurePa <= returnPressurePa + setting ? 0 : pilotFlowAt(differential);
    const liftM = pilotFlowM3PerS === 0 ? 0 : liftAt(differential);
    const mainFlowM3PerS = mainFlowAt(differential, liftM);
    return {
      componentId: valve.id,
      label,
      inletPressurePa,
      returnPressurePa,
      pilotCrackingPa: setting,
      mainCrackingPa,
      pilotFlowM3PerS,
      mainFlowM3PerS,
      totalFlowM3PerS: pilotFlowM3PerS + mainFlowM3PerS,
      liftM,
      state:
        pilotFlowM3PerS === 0
          ? 'closed'
          : liftM === 0
            ? 'pilot-only'
            : liftM === maximumTravel
              ? 'main-full'
              : 'main-open',
    };
  };

  const differentialAtFlow = (flow: number) => {
    // At zero the flow solver needs the opening boundary, while the report
    // evaluates the valve again at the actual common pressure.
    const pilotOnlyPa = setting + (flow / pilotGain) ** 2;
    if (flow <= pilotAtMainCracking) return pilotOnlyPa;
    let low = mainCrackingPa;
    const fullLiftPa = setting + (preload + stiffness * maximumTravel) / forceSlope;
    const mainOnlyPa = (flow / (mainGain * maximumTravel)) ** 2;
    let high = Math.min(pilotOnlyPa, Math.max(fullLiftPa, mainOnlyPa));
    for (let i = 0; i < 56; i++) {
      const mid = low + (high - low) / 2;
      if (mid === low || mid === high) break;
      if (pilotFlowAt(mid) + mainFlowAt(mid, liftAt(mid)) < flow) low = mid;
      else high = mid;
    }
    return low + (high - low) / 2;
  };
  return { ok: true, value: { atPressure, differentialAtFlow } };
}
