import type { NetworkComponent, NetworkProject } from './network-model.js';
import type { Result } from './model.js';
import { parseNetworkProject } from './network-project.js';
import { immutable, ContractReader } from './reader.js';
import {
  networkDefaultParameters,
  networkDefinitions,
  pumpReliefMaximumSettingPa,
  type NetworkDefinition,
} from './network-registry.js';
import { directionalValveSpec } from './network-valve.js';
import { isTeachingActuatorType } from './network-actuators.js';

/** Creation policy only. Reading a saved project never applies these presets. */
export const networkCreationDefinitions: readonly NetworkDefinition[] = immutable(
  networkDefinitions.filter(
    (definition) =>
      (definition.model.solverId === 'hopsan' || definition.role === 'controller') &&
      ['spike-verified', 'runtime-candidate'].includes(definition.evidence) &&
      !networkDefinitions.some((other) => other.id === definition.id && other.version > definition.version),
  ),
);

export function networkCreationParameters(
  definition: NetworkDefinition,
  densityKgPerM3 = 870,
): NetworkComponent['parameters'] {
  const original = networkDefaultParameters(definition.id, definition.version);
  if (!original) throw new Error('Registered creation definition missing');
  if (!Number.isFinite(densityKgPerM3) || densityKgPerM3 <= 0) throw new Error('Validated fluid density required');
  if (definition.typeId === 'pump' && original.relief)
    return immutable({ ...original, relief: { ...original.relief, enabled: 1 } });
  // R is in bar/(L/min)^2. Matching the published fully-open quadratic
  // resistance is a preset conversion, not a copy of FluidSIM's valve law.
  const equivalentArea = (resistance: number) => Math.sqrt(densityKgPerM3 / (2 * resistance * 1e5 * 60000 ** 2)) / 0.67;
  if (definition.id === 'teaching:relief') {
    return immutable({
      ...original,
      hydraulic: {
        ...original.hydraulic,
        settingDifferentialPa: 3e6,
        maximumAreaM2: equivalentArea(0.17),
        flowCoefficient: 0.67,
      },
    });
  }
  if (definition.id === 'teaching:check-valve') {
    return immutable({
      ...original,
      hydraulic: {
        ...original.hydraulic,
        openingDifferentialPa: 0.6e6,
        maximumAreaM2: equivalentArea(0.09),
        flowCoefficient: 0.67,
      },
    });
  }
  if (definition.id === 'teaching:throttle') {
    return immutable({
      ...original,
      hydraulic: { ...original.hydraulic, maximumAreaM2: equivalentArea(0.19), flowCoefficient: 0.67 },
    });
  }
  if (definition.id === 'teaching:one-way-throttle' && definition.version === 3) {
    return immutable({
      ...original,
      hydraulic: {
        ...original.hydraulic,
        maximumAreaM2: equivalentArea(0.07),
        reverseMaximumAreaM2: equivalentArea(0.05),
        reverseOpeningDifferentialPa: 0,
        flowCoefficient: 0.67,
      },
    });
  }
  if (['teaching:valve-o', 'teaching:valve-m'].includes(definition.id)) {
    // Keep the existing travel/overlap/dynamic contracts. Set only the
    // equivalent diameter that matches R at the commanded working position.
    const travel = original.spool?.commandTravelM;
    const overlap = original.spool?.overlapM;
    if (travel === undefined || overlap === undefined) throw new Error('Registered spool input missing');
    return immutable({
      ...original,
      spool: { ...original.spool, diameterM: equivalentArea(0.164) / (Math.PI * (travel - overlap)) },
    });
  }
  if (definition.id === 'teaching:cylinder') {
    // FluidSIM 16/10 mm single-rod cylinder, stroke 200 mm. Coulomb/breakaway
    // forces and cushioning have no equivalent in this viscous-only model.
    return immutable({
      ...original,
      geometry: {
        ...original.geometry,
        capAreaM2: (Math.PI * 0.016 ** 2) / 4,
        rodSideAreaM2: (Math.PI * (0.016 ** 2 - 0.01 ** 2)) / 4,
        strokeM: 0.2,
      },
      mechanics: { ...original.mechanics, massKg: 0.3, pistonDampingNsPerM: 215 },
    });
  }
  return original;
}

export function networkTeachingPreset(component: NetworkComponent, densityKgPerM3 = 870): NetworkComponent | undefined {
  const definition =
    (component.typeId === 'limited-rotary-actuator' && component.definition.version < 3) ||
    (['pressure-intensifier', 'pressure-compensated-flow'].includes(component.typeId) &&
      component.definition.version === 1)
      ? networkDefinitions.find(
          (candidate) => candidate.id === component.definition.id && candidate.version === component.definition.version,
        )
      : networkCreationDefinitions.find((candidate) => candidate.id === component.definition.id);
  if (!definition) return undefined;
  return immutable({
    ...component,
    definition: { id: definition.id, version: definition.version },
    model: { id: definition.model.id, version: definition.model.version },
    parameters: networkCreationParameters(definition, densityKgPerM3),
  });
}

export function enableRotaryWorkProtection(component: NetworkComponent): NetworkComponent {
  if (component.typeId !== 'limited-rotary-actuator' || component.definition.version >= 3) return component;
  const definition = networkCreationDefinitions.find((candidate) => candidate.id === component.definition.id);
  const defaults = definition && networkDefaultParameters(definition.id, definition.version);
  if (!definition || !defaults?.workProtection || !defaults.protectionReturn)
    throw new Error('Registered rotary protection definition missing');
  return immutable({
    ...component,
    definition: { id: definition.id, version: definition.version },
    model: { id: definition.model.id, version: definition.model.version },
    parameters: {
      ...component.parameters,
      workProtection: component.parameters.workProtection ?? defaults.workProtection,
      protectionReturn: defaults.protectionReturn,
    },
  });
}

export function enableIntensifierOutletRelief(component: NetworkComponent): NetworkComponent {
  if (component.typeId !== 'pressure-intensifier' || component.definition.version !== 1) return component;
  const definition = networkCreationDefinitions.find((candidate) => candidate.id === component.definition.id);
  const defaults = definition && networkDefaultParameters(definition.id, definition.version);
  if (!definition || !defaults?.outletRelief || !defaults.storage)
    throw new Error('Registered intensifier protection definition missing');
  return immutable({
    ...component,
    definition: { id: definition.id, version: definition.version },
    model: { id: definition.model.id, version: definition.model.version },
    parameters: { ...component.parameters, storage: defaults.storage, outletRelief: defaults.outletRelief },
  });
}

export function enableCompensatedFlowStorage(component: NetworkComponent): NetworkComponent {
  if (component.typeId !== 'pressure-compensated-flow' || component.definition.version !== 1) return component;
  const definition = networkCreationDefinitions.find((candidate) => candidate.id === component.definition.id);
  const storage = definition && networkDefaultParameters(definition.id, definition.version)?.storage;
  if (!definition || !storage) throw new Error('Registered compensated flow storage missing');
  return immutable({
    ...component,
    definition: { id: definition.id, version: definition.version },
    model: { id: definition.model.id, version: definition.model.version },
    parameters: { ...component.parameters, storage },
  });
}

/** Pure candidate; the existing editor transaction owns commit/undo/runtime invalidation. */
export function applyNetworkTeachingPreset(project: NetworkProject, componentId: string): Result<NetworkProject> {
  const component = project.design.components.find((candidate) => candidate.id === componentId);
  const replacement = component ? networkTeachingPreset(component, project.design.fluid.densityKgPerM3) : undefined;
  if (!replacement)
    return {
      ok: false,
      diagnostics: [
        {
          code: 'MODEL_UNSUPPORTED',
          severity: 'error',
          field: `/design/components/${componentId}`,
          message: '此元件没有可应用的教学预设。',
          suggestion: '保留当前工程和输入。',
        },
      ],
    };
  const initialConditions = project.design.initialConditions.map((initial) => {
    if (initial.componentId !== componentId || initial.kind !== 'throttle') return initial;
    const opening = replacement.parameters.hydraulic?.maximumAreaM2;
    if (opening === undefined) throw new Error('Registered throttle maximum area missing');
    return { ...initial, openingAreaM2: opening };
  });
  return parseNetworkProject({
    ...project,
    design: {
      ...project.design,
      initialConditions,
      components: project.design.components.map((current) => (current.id === componentId ? replacement : current)),
    },
  });
}

/** Explicit user-requested version upgrade only; ordinary file reads never call this. */
export function configurePumpRelief(
  project: NetworkProject,
  componentId: string,
  input: unknown,
): Result<NetworkProject> {
  const r = new ContractReader(),
    raw = r.object(input, '/pumpRelief', ['enabled', 'settingDifferentialPa', 'maximumAreaM2', 'flowCoefficient']);
  if (typeof raw.enabled !== 'boolean')
    r.fail('PARAMETER_INVALID', '/pumpRelief/enabled', '请明确勾选或关闭内置溢流。');
  const enabled = raw.enabled === true;
  const relief = {
    enabled: enabled ? 1 : 0,
    settingDifferentialPa: r.number(
      raw.settingDifferentialPa,
      '/pumpRelief/settingDifferentialPa',
      1e4,
      pumpReliefMaximumSettingPa,
    ),
    maximumAreaM2: r.number(raw.maximumAreaM2, '/pumpRelief/maximumAreaM2', 1e-10, 1e-3),
    flowCoefficient: r.number(raw.flowCoefficient, '/pumpRelief/flowCoefficient', 0.01, 1),
  };
  const pump = project.design.components.find((c) => c.id === componentId);
  const definition = networkCreationDefinitions.find(
    (d) => d.id === pump?.definition.id && d.typeId === 'pump' && d.groups.relief,
  );
  if (!definition) r.fail('MODEL_UNSUPPORTED', '/pumpRelief', '此泵尚不支持内置溢流；保留原模型。');
  const checked = r.finish(true);
  if (!checked.ok) return checked;
  if (!pump || !definition) throw new Error('Validated pump missing');
  if (!pump.parameters.relief && !enabled) return { ok: true, value: project };
  const defaults = networkDefaultParameters(definition.id, definition.version);
  if (!defaults) throw new Error('Registered pump-relief model missing');
  const replacement = {
    ...pump,
    definition: { id: definition.id, version: definition.version },
    model: { id: definition.model.id, version: definition.model.version },
    parameters: {
      ...defaults,
      ...pump.parameters,
      storage: { ...defaults.storage, ...pump.parameters.storage },
      relief,
    },
  };
  return parseNetworkProject({
    ...project,
    design: {
      ...project.design,
      components: project.design.components.map((c) => (c.id === componentId ? replacement : c)),
    },
  });
}

/** These statements follow the saved model version, not the current library. */
export function networkModelAssumptions(component: NetworkComponent): readonly string[] {
  if (component.definition.id === 'teaching:variable-pump' || component.definition.id === 'teaching:variable-motor')
    return immutable([
      '运行排量在已验证的给定边界写入内核输入，原生子步按当前值求解。百分比与模拟电压按最小到最大排量线性映射。',
      '教学模型采用瞬时排量给定；变量机构的动态响应需专门模型。',
    ]);
  if (isTeachingActuatorType(component.typeId)) {
    const storage =
      '油口具有显式固定等效储油容积。机械端采用集中质量或转动惯量、阻尼和有界行程，端点接触为无回弹停止。';
    if (component.typeId === 'single-acting-cylinder')
      return immutable(['A 口加压伸出，机械负载与预紧弹簧作用于活塞。回油时弹簧推动缩回。', storage]);
    if (component.typeId === 'limited-rotary-actuator')
      return immutable([
        '两侧排量相同，A、B 压差驱动有限角度往复摆动。转角以缩回挡位为零，反向压差可使轴离开限位。',
        storage,
        ...(component.parameters.workProtection
          ? [
              component.parameters.protectionReturn?.internalTank === 1
                ? '内置定压油箱只服务 A/B 工作口保护，按设定回油压力补油和泄放。'
                : '内置冲击溢流补油使用实际 T 口回油压力。A、B 高压侧各自向 T 泄放，T 向低压工作口补油。',
            ]
          : []),
      ]);
    return immutable([
      '靠近端点时，排油方向按位置增加等效孔口压降，充油方向无缓冲阻力。两端缓冲长度和最小开口独立可调，长度为零停用该端缓冲。',
      storage,
    ]);
  }
  if (component.typeId === 'two-pressure-valve')
    return immutable([
      'A、B 两个实际入口压力均达到开启条件才向 C 供油，完全开启后按实际入口压差选择高压侧。启用阈值采用工程压力基准。',
      '压差接近时两座可分担流量，C 不向入口反灌。关闭后出口压力由外部回路决定。',
    ]);
  if (component.typeId === 'pilot-check-close')
    return immutable([
      'A→B 单向通流。X 相对 A 的正先导压差乘先导面积比，提高正向开启所需压差。X 为无持续耗流的压力控制口。',
    ]);
  if (component.typeId === 'pressure-reducing-relieving')
    return immutable([
      '控制量为 A 相对 T 的实际压力。低于设定值时 P→A 补油，高于设定值时 A→T 泄放。供油与泄放开口按压差在调节带内变化。',
      '两条主通路为单向有限孔口，无反向旁通、阀芯惯性或泄漏。回油背压会抬高出口压力。',
    ]);
  if (component.typeId === 'manual-shutoff')
    return immutable(['A、B双向通断，关闭时面积为零，全开按有限孔口计算压降；不含阀芯惯性和关闭泄漏。']);
  if (component.typeId === 'shuttle-valve')
    return immutable([
      'A、B向C单向供油。实际入口压差超过完全切换压差时，低压侧封闭；切换带内两路按压差分配总开口。',
      '准静态无储油、无阀芯惯性与泄漏；C口较高回压可阻止供油，不反灌。',
    ]);
  if (component.typeId === 'accumulator')
    return immutable([
      '单口气囊式理想多变气体模型：预充始终为绝压，p_abs·V_g^n恒定；油口阻力为显式参数，气液容积由原生状态统一维护。',
      '排空时气囊封闭油口；达到最小气体容积仍继续压缩则明确失败。储能读数是相对排空态的气体压缩功，不是热内能或厂家额定储能；不含温度动态、气体溶解/泄漏、真实气体修正或安全认证。',
      '暂停/继续保留本次气液状态；重置/重新初始化与保存重开按设计初始存油量开始，运行状态不会偷偷覆盖设计。',
    ]);
  if (component.typeId === 'counterbalance')
    return immutable([
      '三口内泄平衡阀：A→B单向旁路，B→A按负载及X先导连续调制；回油A背压以1+先导比系数提高开启需求，没有Y外泄口。',
      '有限孔口、线性调节带准静态教学模型，不含阀芯惯性/泄漏、动态稳定性或软管破裂认证；马达泄漏仍可能导致运动，不能代替机械制动。',
    ]);
  if (component.typeId === 'pressure-compensated-flow')
    return immutable([
      '二通限制式：P→A压差足够时补偿，流量由节流面积、补偿压差、流量系数及密度决定；供压不足时自然降流，不用隐藏压力源补足。',
      'A→P经同一节流口反向流动、不补偿；面积0双向关闭。理想准静态教学模型，不含补偿阀芯动态、泄漏和厂家流量偏差标定。',
      ...(component.parameters.storage
        ? ['A 口内置可调油液容积，允许直接串接节流负载。P 口需要实际供压或已支持的储油连接。']
        : []),
    ]);
  if (component.definition.id === 'teaching:pilot-check-internal')
    return immutable([
      '三口内泄式：A→B克服弹簧压差自由流，X控制B→A解锁；A口回压直接影响所需先导压力，不需要额外Y口。',
      '准静态开关阀，先导/阀芯惯性与解压冲击不在模型内；先导不足以维持全开时明确拒绝，不充当平衡阀或下降调速阀。',
    ]);
  if (component.typeId === 'pilot-check')
    return immutable([
      'A→B克服弹簧压差自由流；B→A默认锁闭。X为真实先导口，Y为活塞外泄口，均须接线。',
      '外泄先导活塞准静态模型：先导相对Y的面积力克服B相对Y的负载及弹簧后有限开口解锁；无先导/泄油稳态耗流、惯性或解压级。不是平衡阀或安全锁。',
    ]);
  if (component.typeId === 'pressure-reducing' || component.typeId === 'sequence-valve')
    return immutable([
      component.typeId === 'pressure-reducing'
        ? '非溢流减压：P→A正常打开，实际A−Y升高时关小；Y仅为外泄参考，不能泄放外载造成的出口超压。'
        : '内控外泄顺序：实际P−Y达到设定后开启P→A，Y回压提高所需入口压力；不等同电气动作顺序控制。',
      '有限开口、线性调节带的准静态教学模型，有压力/流量下垂，无阀芯惯性/泄漏；反向旁通面积0表示关闭，参数不是厂家额定标定。',
    ]);
  if (directionalValveSpec(component.definition.id))
    return immutable([
      '有限常用机能的准静态方向阀：各位通路共用保存定义；无阀芯惯性、无过渡开口与泄漏，不模拟气动排气。',
      'R为第二回油口，须连接实际油箱；两位阀没有中位。仅支持当前声明的通路组合，不支持任意连通或气蚀。',
    ]);
  if (component.parameters.outletRelief)
    return immutable([
      'H 口内置油液容积。启用溢流时，实际 H−R 压差超过保存设定后经有限孔口向 R 泄放。',
      'R 接实际回油。负载工作口的低压和制动取决于工作口回路，增压器限压流量可在 H 口查看。',
    ]);
  if (component.typeId === 'pump' && component.parameters.relief)
    return immutable([
      `内置溢流${component.parameters.relief.enabled === 1 ? '启用' : '关闭'}：P→S，开启压差${component.parameters.relief.settingDifferentialPa} Pa、最大开口${component.parameters.relief.maximumAreaM2} m²。参数为可修改教学假设；S口需按实际回路接回油箱。`,
      '采用实际P−S压力与有限孔口泄放，不钳制压力。容量不足、超出70 MPa或不支持的负压工况仍会保护；内置容积与流量来源可查。',
    ]);
  if (component.definition.id === 'teaching:pilot-relief')
    return immutable([
      '内控内泄两级准静态教学模型：先导级与供油节流孔共同决定控制腔压力，主阀按压差力/弹簧平衡开度；回油背压计入设定压差。',
      '参数是显式教学假设，不是厂商标定值；不计算阀芯惯性、控制腔压缩瞬态、外控外泄或气蚀。',
    ]);
  if (component.definition.id.startsWith('teaching:custom-'))
    return immutable([
      '支持四个油口、三个逻辑位置；逐位选择已验证的正向、封闭/卸荷、反向三种机能，每种一次。符号和实际控制共用这份保存的定义。',
      '应用参数才提交为一次可撤销物理修改；未应用的选择不影响工程。当前不支持任意位数、增删油口或重复机能。',
    ]);
  if (component.model.version !== '0.3.0') return [];
  const volume = component.parameters.storage?.portVolumeM3;
  const initial = component.parameters.storage?.initialPressurePa;
  const notes = [
    `${component.label}：工作口内置油液容积 ${volume} m³/口，初压 ${initial} Pa；这是教学模型输入，不是实测容积，也不是随步长变化的数值柔度。`,
  ];
  if (component.typeId === 'motor') {
    const makeup = component.parameters.makeup;
    notes.push(
      `${component.label}：${makeup?.maximumAreaM2 === 0 ? '自动补油已关闭' : '自动补油已启用'}；内置独立储液源压力 ${makeup?.supplyPressurePa} Pa、开启压差 ${makeup?.openingDifferentialPa} Pa、开口 ${makeup?.maximumAreaM2} m²。此储液源不代表图上油箱，补油流量单独计量；不模拟气穴体积或两相气蚀。`,
    );
  }
  return immutable(notes);
}
