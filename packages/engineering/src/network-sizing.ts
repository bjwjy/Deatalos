import {
  checkJson,
  checkNetworkParameterRules,
  ContractReader,
  diagnostic,
  immutable,
  parseNetworkProject,
  type NetworkComponent,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import { sizeCylinder, type Sizing, type SizingRequirements } from './cylinder-sizing.js';
import {
  calculationSubstitution,
  type CalculationInput,
  type CalculationRecord,
  type CalculationStep,
} from './network-learning.js';

export interface NetworkSizingRequest {
  readonly cylinderId: string;
  readonly pumpId: string | null;
  readonly requirements: Required<SizingRequirements>;
}
export interface SizingChange {
  readonly componentId: string;
  readonly parameter: string;
  readonly before: number;
  readonly after: number;
}
export interface NetworkSizingPlan {
  readonly request: NetworkSizingRequest;
  readonly sizing: Sizing;
  readonly document: NetworkProject;
  readonly changes: readonly SizingChange[];
  readonly record: CalculationRecord;
}
function parseRequest(input: unknown): Result<NetworkSizingRequest> {
  const checked = checkJson(input);
  if (!checked.ok) return checked;
  const r = new ContractReader();
  const o = r.object(input, '/sizing', ['cylinderId', 'pumpId', 'requirements']);
  const raw = r.object(o.requirements, '/sizing/requirements', [
    'forceN',
    'speedMPerS',
    'pressureBudgetPa',
    'strokeM',
    'pumpAngularSpeedRadPerS',
    'volumetricEfficiency',
    'totalEfficiency',
  ]);
  const positive = (key: string) =>
    r.number(raw[key], '/sizing/requirements/' + key, Number.MIN_VALUE, Number.MAX_VALUE);
  const requirements = {
    forceN: positive('forceN'),
    speedMPerS: positive('speedMPerS'),
    pressureBudgetPa: positive('pressureBudgetPa'),
    strokeM: positive('strokeM'),
    pumpAngularSpeedRadPerS: positive('pumpAngularSpeedRadPerS'),
    volumetricEfficiency: r.number(
      raw.volumetricEfficiency,
      '/sizing/requirements/volumetricEfficiency',
      Number.MIN_VALUE,
      1,
    ),
    totalEfficiency: r.number(raw.totalEfficiency, '/sizing/requirements/totalEfficiency', Number.MIN_VALUE, 1),
  };
  return r.finish({
    cylinderId: r.id(o.cylinderId, '/sizing/cylinderId'),
    pumpId: o.pumpId === null ? null : r.id(o.pumpId, '/sizing/pumpId'),
    requirements,
  });
}
const fail = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('SIZING_TARGET_INVALID', '/sizing', message)],
});

/** Single-cylinder extension sizing only. Explicit targets; no inferred common-source operating condition. */
export function planNetworkSizing(document: unknown, input: unknown): Result<NetworkSizingPlan> {
  const parsed = parseNetworkProject(document);
  if (!parsed.ok) return parsed;
  const request = parseRequest(input);
  if (!request.ok) return request;
  const project = parsed.value,
    req = request.value;
  const cylinder = project.design.components.find((c) => c.id === req.cylinderId);
  const pump = req.pumpId === null ? null : project.design.components.find((c) => c.id === req.pumpId);
  if (cylinder?.definition.id !== 'teaching:cylinder' || (req.pumpId !== null && pump?.typeId !== 'pump'))
    return fail('请选择明确的已支持液压缸及泵；不自动套用首实例。');
  if (pump?.parameters.relief?.enabled === 1)
    return fail(
      '此尺寸初选尚未核算泵内置溢流的供油压差；请先关闭内置溢流进行尺寸初选，再开启并做回路需求核算与实际仿真。',
    );
  const sized = sizeCylinder(req.requirements);
  if (!sized.ok) return sized;
  const s = sized.value;
  const capArea = (Math.PI * s.boreM ** 2) / 4;
  const rodSideArea = capArea - (Math.PI * s.rodM ** 2) / 4;
  const replacements = new Map<string, Readonly<Record<string, Readonly<Record<string, number>>>>>();
  replacements.set(cylinder.id, { geometry: { capAreaM2: capArea, rodSideAreaM2: rodSideArea, strokeM: s.strokeM } });
  if (pump)
    replacements.set(pump.id, {
      hydraulic: { displacementM3PerRev: s.pumpDisplacementM3PerRev },
      drive: { angularSpeedRadPerS: req.requirements.pumpAngularSpeedRadPerS },
    });
  const changes: SizingChange[] = [];
  const components: NetworkComponent[] = [];
  for (const component of project.design.components) {
    const patch = replacements.get(component.id);
    if (!patch) {
      components.push(component);
      continue;
    }
    const parameters = { ...component.parameters };
    for (const [group, values] of Object.entries(patch)) {
      const previous = component.parameters[group];
      if (!previous) return fail('所选目标缺少参数组：' + component.id + '.' + group);
      parameters[group] = { ...previous, ...values };
      for (const [key, after] of Object.entries(values)) {
        const before = previous[key];
        if (before === undefined) return fail('所选目标缺少参数：' + component.id + '.' + group + '.' + key);
        changes.push({ componentId: component.id, parameter: group + '.' + key, before, after });
      }
    }
    components.push({ ...component, parameters });
  }
  const candidate = parseNetworkProject({ ...project, design: { ...project.design, components } });
  if (!candidate.ok) return candidate; // Incompatible initial position/stroke is rejected, never silently reset.
  const units: Readonly<Record<string, string>> = {
    forceN: 'N',
    speedMPerS: 'm/s',
    pressureBudgetPa: 'Pa',
    strokeM: 'm',
    pumpAngularSpeedRadPerS: 'rad/s',
    volumetricEfficiency: '1',
    totalEfficiency: '1',
  };
  const inputs: CalculationInput[] = Object.entries(req.requirements).map(([reference, value]) => ({
    reference,
    unit: units[reference] ?? '1',
    value: { kind: 'known', value },
    source: 'user-requirement',
  }));
  const steps: CalculationStep[] = [];
  const add = (
    key: string,
    label: string,
    formula: string,
    value: number,
    unit: string,
    displayUnit = unit,
    scale = 1,
  ) => {
    const dependencies: CalculationInput[] = [
      ...inputs,
      ...steps.map((step) => ({ reference: step.key, unit: step.unit, value: step.value, source: 'preliminary-step' })),
    ];
    steps.push({
      key,
      label,
      source: 'preliminary',
      formula,
      inputs: dependencies,
      substitution: calculationSubstitution(dependencies),
      unit,
      value: { kind: 'known', value },
      display: {
        unit: displayUnit,
        value: { kind: 'known', value: value * scale },
        conversion: `显示值 = SI值 × ${scale}`,
      },
    });
  };
  add(
    'theoreticalBore',
    '理论最小缸径',
    'Dmin=sqrt(4F/[pi*0.95*(p-1MPa-0.5MPa*(1-0.6²))])',
    s.theoreticalBoreM,
    'm',
    'mm',
    1000,
  );
  add(
    'bore',
    '满足力预算的离散缸径',
    '在声明教学系列内逐项核算后向上选取；并用取整后的杆径复核',
    s.boreM,
    'm',
    'mm',
    1000,
  );
  add('rod', '配套杆径', 'd=round(D_mm*0.6) mm', s.rodM, 'm', 'mm', 1000);
  add('stroke', '行程', 'L=用户给定行程', s.strokeM, 'm', 'mm', 1000);
  add('capArea', '无杆腔面积', 'A_A=pi*D²/4', capArea, 'm²');
  add('rodSideArea', '有杆腔有效面积', 'A_B=pi*(D²-d²)/4', rodSideArea, 'm²');
  add('flow', '要求供油流量', 'Qreq=A_A*v', s.requiredFlowM3PerS, 'm³/s', 'L/min', 60000);
  add(
    'requiredDisplacement',
    '要求泵排量',
    'Dreq=Qreq/[(omega/(2*pi))*eta_v]',
    s.requiredDisplacementM3PerRev,
    'm³/rev',
    'cm³/rev',
    1e6,
  );
  add(
    'pumpDisplacement',
    '离散泵排量初选',
    '从声明教学系列向上选取D >= Dreq',
    s.pumpDisplacementM3PerRev,
    'm³/rev',
    'cm³/rev',
    1e6,
  );
  add(
    'estimatedFlow',
    '效率假设下估计流量',
    'Qest=Dselected*(omega/(2*pi))*eta_v；非仿真实际流量',
    s.actualFlowM3PerS,
    'm³/s',
    'L/min',
    60000,
  );
  add(
    'estimatedSpeed',
    '效率假设下估计伸出速度',
    'vest=Qest/A_A；非仿真实际速度',
    s.actualSpeedMPerS,
    'm/s',
    'mm/s',
    1000,
  );
  add(
    'power',
    '效率假设下估计轴功率',
    'Pshaft=pBudget*Qest/eta_total；非内核机械功率',
    s.shaftPowerW,
    'W',
    'kW',
    0.001,
  );
  const assumptions = [
    ...s.assumptions,
    '仅单缸伸出基础初选；不计算缩回、同时/顺序工况、共源竞争或强度。',
    '应用仅更新所选缸面积/行程及可选泵排量/转速；外载、初态、阀/压力源设定、泄漏和效率不自动改写。',
    '泵原生模型采用显式泄漏而非恒定容积效率；初选估计与瞬态实际值须分列，应用不保证实际速度。',
    '压力预算是用户设计要求，需自行核对压力源/溢流设置与完整回路。',
  ];
  const constraints = checkNetworkParameterRules(project, candidate.value);
  if (!constraints.ok) return constraints;
  return {
    ok: true,
    value: immutable({
      request: req,
      sizing: s,
      document: candidate.value,
      changes,
      record: {
        format: 'HydraulicLearningCalculation',
        version: 1,
        kind: 'preliminary',
        title: `单缸伸出初选：${cylinder.label} (${cylinder.id})；泵：${pump?.id ?? '不应用'}`,
        document: project,
        identity: null,
        context: null,
        assumptions,
        steps,
      },
    }),
  };
}
