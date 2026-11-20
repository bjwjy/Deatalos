import { dutyPhasePaths } from './network-duty-accessories.js';
import { driveFeedback } from './network-duty-drive-feedback.js';
import type { NetworkProject, Result } from '@hyd/domain';
import type { DutyPhase, DutyBoundaryDemand } from './network-duty.js';
import type { StepWriter } from './network-duty-supply-storage.js';
import { pipelineSurge, elasticStop } from './network-duty-impact.js';

interface Field {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  scale: number;
}
const field = (key: string, label: string, unit: string, min: number, max: number, scale = 1): Field => ({
  key,
  label,
  unit,
  min,
  max,
  scale,
});
const time = field('duration', '观测时长', 's', 1e-6, 1e9),
  speed = field('speed', '接触前活塞速度幅值', 'mm/s', 0, 1e5, 0.001);
const compensation = (suffix: string, tag: string) => [
  field('cut' + suffix, tag + '截压差', 'MPa', 0.00001, 70, 1e6),
  field('band' + suffix, tag + '调节带', 'MPa', 0.00001, 70, 1e6),
  field('tau' + suffix, tag + '排量时间常数', 's', 0.00001, 5),
];
const response = [
  field('duration', '反馈观测窗', 's', 0.0001, 5),
  field('motorTau', '马达排量时间常数', 's', 0.00001, 5),
  ...compensation('', '第一泵'),
];
const feedbackDomain =
  '马达由保存的压差曲线给出排量目标，各泵按各自截压带一阶响应。直连同一母线、理想吸排油，采用保存的恒定轴速、实际泄漏、机械阻尼、外载及初态。泵按实例 ID 升序编号。流量、转矩、排量相对残差 0.2%，连续保持至少三倍排量时间常数及 5 ms 才列稳定时间。';
const contactStudy = {
  condition:
    '第一次接触后短时两腔封闭，外力与初始液压力平衡。端部按实测线性刚度和黏性阻尼，两腔按接触时受压容积线性化；计算首次压缩至速度为零的压力与接触力。',
  fields: [
    speed,
    field('stiffness', '端部刚度', 'N/m', 1, 1e13),
    field('damping', '端部接触阻尼', 'N·s/m', 0, 1e9),
    field('capV', '接触时无杆腔受压容积', 'L', 0.00001, 1e4, 0.001),
    field('rodV', '接触时杆腔受压容积', 'L', 0.00001, 1e4, 0.001),
    field('capP', '接触时无杆腔绝压', 'MPa', 0.000001, 70, 1e6),
    field('rodP', '接触时杆腔绝压', 'MPa', 0.000001, 70, 1e6),
    field('vapour', '油液蒸气绝压', 'kPa', 0.00001, 1000, 1000),
  ],
};
export const serviceStudies = {
  feedback: { label: '变量泵与马达闭环响应', condition: feedbackDomain, fields: response },
  dualFeedback: {
    label: '双变量泵与马达联合调节',
    condition: feedbackDomain,
    fields: [...response, ...compensation('2', '第二泵')],
  },
  hold: {
    label: '保压下沉',
    condition: '无杆腔承载、杆腔可补油，按当前负载、油温和压差下实测的无杆腔净排油率恒定计算。到缩回端位后截止。',
    fields: [time, field('leak', '承载腔实测净排油', 'mL/min', 0, 1e7, 1e-6 / 60)],
  },
  filter: {
    label: '滤芯堵塞至旁通',
    condition:
      '固定流量、同油温，使用同一滤芯未旁通时两次实测差压。按这段时间的差压增长斜率估算开启时刻，换工况需重新标定。',
    fields: [
      field('flow', '标定流量', 'L/min', 1e-7, 60000, 1 / 60000),
      field('first', '起点差压', 'kPa', 0, 70000, 1000),
      field('last', '终点差压', 'kPa', 0, 70000, 1000),
      field('interval', '两次测量间隔', 's', 1e-6, 1e9),
      field('crack', '旁通开启差压', 'kPa', 0.0001, 70000, 1000),
    ],
  },
  heat: {
    label: '连续运行油温',
    condition: '油箱和系统油液用单一等效热容，发热功率、环境温度及散热系数在观测窗口恒定。',
    fields: [
      time,
      field('heatW', '实测平均入油热功率', 'W', 0, 1e9),
      field('capacity', '等效热容', 'J/K', 0.001, 1e12),
      field('conductance', '散热系数', 'W/K', 0, 1e8),
      field('ambient', '环境温度', '°C', -100, 500),
      field('initial', '初始油温', '°C', -100, 500),
      field('limit', '允许油温', '°C', -100, 500),
    ],
  },
  surge: {
    label: '单管关阀压力波与空穴复压',
    condition:
      '独立等径直管，入口恒压、出口给定线性关断流量。按有效波速、初始绝压与蒸气压用特征线和离散汽穴模型计算。忽略沿程衰减、支管反射、游离气体及侵蚀。',
    fields: [
      time,
      field('flow', '初始管流量', 'L/min', 0.000001, 60000, 1 / 60000),
      field('wave', '标定波速', 'm/s', 1, 5000),
      field('initialPa', '初始及入口绝压', 'MPa', 0.000001, 70, 1e6),
      field('vapour', '油液蒸气绝压', 'kPa', 0.00001, 1000, 1000),
      field('closure', '出口流量线性关断时长', 's', 0, 100),
    ],
  },
  impact: { ...contactStudy, label: '伸出端弹性碰撞' },
  impactRetract: { ...contactStudy, label: '缩回端弹性碰撞' },
};
export type ServiceMode = keyof typeof serviceStudies;
export interface ServiceInput {
  mode: ServiceMode;
  target: string;
  values: Readonly<Record<string, number>>;
}
export function serviceMode(value: unknown): value is ServiceMode {
  return typeof value === 'string' && Object.hasOwn(serviceStudies, value);
}
export function sharedFeedbackCircuit(p: NetworkProject) {
  const c = p.design.components,
    ps = c.filter((x) => x.definition.id === 'teaching:variable-pump'),
    m = c.find((x) => x.definition.id === 'teaching:variable-motor'),
    t = c.find((x) => x.typeId === 'tank'),
    v = c.find((x) => x.typeId === 'volume');
  if (
    !m ||
    !t ||
    ps.length !== 2 ||
    c.length !== 4 + Number(!!v) ||
    p.design.connections.some((e) => e.kind !== 'ideal')
  )
    return false;
  const paths = dutyPhasePaths(p, { name: '联合调节', valves: [], actions: [] }, false);
  if (!paths.ok) return false;
  const net = paths.value.idealReachable,
    high = m.id + ':A',
    low = t.id + ':T';
  return (
    !net(high, low) &&
    net(m.id + ':B', low) &&
    ps.every((x) => net(x.id + ':P', high) && net(x.id + ':S', low)) &&
    (!v || net(v.id + ':H', high))
  );
}
export function serviceTargets(p: NetworkProject, mode: ServiceMode) {
  if (mode === 'feedback' || mode === 'dualFeedback') {
    const pumps = p.design.components.filter((c) => c.typeId === 'pump');
    if (
      pumps.length !== (mode === 'feedback' ? 1 : 2) ||
      pumps.some((c) => c.definition.id !== 'teaching:variable-pump')
    )
      return [];
    return p.design.components.filter((c) => c.definition.id === 'teaching:variable-motor').map((c) => c.id);
  }
  if (mode === 'surge') return p.design.connections.filter((e) => e.kind === 'pipe').map((e) => e.id);
  return p.design.components
    .filter((c) =>
      mode === 'heat'
        ? c.typeId === 'tank'
        : mode === 'filter'
          ? c.typeId === 'return-filter'
          : ['cylinder', 'cushioned-cylinder', 'cushioned-double-rod-cylinder'].includes(c.typeId),
    )
    .map((c) => c.id);
}
export function servicePoint(
  p: NetworkProject,
  phase: DutyPhase,
  study: ServiceInput,
  write: StepWriter,
): Result<DutyBoundaryDemand> {
  const spec = serviceStudies[study.mode],
    v = study.values,
    id = study.target;
  const output = (reason: string, pending = false, satisfied = !pending): Result<DutyBoundaryDemand> => ({
    ok: true,
    value: {
      name: phase.name,
      boundaryAssessment: {
        summary: spec.label + ' [' + id + ']。' + reason,
        satisfied,
        ...(pending ? { loadPending: true as const } : {}),
      },
    },
  });
  if (!serviceTargets(p, study.mode).includes(id)) return output('测定对象与工程不匹配。', true);
  if (
    phase.actions.length ||
    phase.transient ||
    phase.loadStudy ||
    phase.flowSplit ||
    phase.pumpStorage ||
    phase.resetStudy ||
    phase.drainLeakM3PerS !== undefined
  )
    return output('标定试验需要独立工况。', true);
  const missing = spec.fields.filter((f) => v[f.key] === undefined);
  for (const f of spec.fields) {
    const n = v[f.key];
    if (n !== undefined)
      write(
        'given-' + f.key,
        f.label,
        '本工况给定',
        n,
        ({ MPa: 'Pa', kPa: 'Pa', 'mm/s': 'm/s', 'L/min': 'm³/s', 'mL/min': 'm³/s', L: 'm³' } as Record<string, string>)[
          f.unit
        ] ?? f.unit,
        1 / f.scale,
        f.unit,
      );
  }
  if (missing.length) return output('缺少' + missing.map((f) => f.label).join('、') + '。', true);
  const c = p.design.components.find((c) => c.id === id),
    n = (key: string) => v[key]!,
    fmt = (x: number) => Number(x.toPrecision(6));
  if (study.mode === 'feedback' || study.mode === 'dualFeedback') {
    const result = driveFeedback(p, id, v, write);
    return output(result.reason, result.pending);
  }
  if (study.mode === 'hold') {
    const g = c?.parameters.geometry,
      area = g?.capAreaM2 ?? g?.equalAnnularAreaM2,
      init = p.design.initialConditions.find((i) => i.componentId === id);
    if (!area || init?.kind !== 'cylinder') return output('缺少承载腔有效面积或起始行程。', true);
    const speed = n('leak') / area,
      distance = Math.min(init.positionM, speed * n('duration'));
    write('sink-speed', '缩回速度幅值', '净排油率/面积', speed, 'm/s', 1000, 'mm/s');
    write('sink', '下沉量', 'min(剩余行程,速度×时长)', distance, 'm', 1000, 'mm');
    if (speed > 0) write('stop', '按恒定泄漏到端位时间', '起始行程/速度', init.positionM / speed, 's');
    return output('窗口内下沉 ' + fmt(distance * 1000) + ' mm。');
  }
  if (study.mode === 'filter') {
    const rated = c?.parameters.hydraulic?.filterRatedFlowM3PerS;
    if (!rated || n('flow') > rated) return output('标定流量超过滤芯额定或额定流量未知。', true);
    const rate = (n('last') - n('first')) / n('interval');
    write('rate', '实测差压增长率', '(终值−初值)/标定时长', rate, 'Pa/s');
    if (n('first') >= n('crack')) return output('起点已达到开启压差。');
    if (n('last') >= n('crack')) return output('测量终点已达到开启门槛，旁通后数据不能外推首次开启时间。', true);
    if (rate <= 0) return output('当前趋势未朝开启门槛增长。');
    const until = (n('crack') - n('last')) / rate;
    write('until', '从最后测量至开启估计时间', '剩余差压/实测增长率', until, 's');
    return output('按实测增长率，距旁通开启 ' + fmt(until) + ' s。');
  }
  if (study.mode === 'heat') {
    const h = n('conductance'),
      w = n('heatW'),
      capacity = n('capacity'),
      t = n('duration'),
      start = n('initial'),
      a = n('ambient'),
      limit = n('limit');
    const end =
      h > 0 ? start + ((w - h * (start - a)) / h) * -Math.expm1((-h * t) / capacity) : start + (w * t) / capacity;
    write('end-temp', '窗口末油温', 'C dT/dt = W−H(T−Ta)', end, '°C');
    const eq = h > 0 ? a + w / h : undefined;
    if (eq !== undefined) write('equilibrium', '平衡油温', 'Ta+W/H', eq, '°C');
    const hit =
      start >= limit
        ? 0
        : eq === undefined
          ? w > 0
            ? ((limit - start) * capacity) / w
            : undefined
          : eq > limit
            ? (-capacity / h) * Math.log1p(-(limit - start) / (eq - start))
            : undefined;
    if (hit !== undefined) write('limit-time', '达到允许油温时刻', '热平衡方程首次过限', hit, 's');
    return output(
      '窗口末油温 ' +
        fmt(end) +
        ' °C。' +
        (hit === undefined ? '恒定边界下不会达到温度上限。' : '达到上限时刻 ' + fmt(hit) + ' s。'),
      false,
      hit === undefined || hit > t,
    );
  }
  const result =
    study.mode === 'surge'
      ? pipelineSurge(p, id, v, write)
      : elasticStop(p, id, v, write, study.mode === 'impactRetract');
  return output(result.reason, result.pending);
}
