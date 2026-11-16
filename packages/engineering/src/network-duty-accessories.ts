import {
  diagnostic,
  networkValvePaths,
  type NetworkComponent,
  type NetworkConnection,
  type NetworkEndpoint,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import type { DutyPhase } from './network-duty.js';
import { dutyControlValveTypes } from './network-duty-control-valves.js';
import { orificeResistance, seriesAccessoryDrop } from './network-duty-return-pipes.js';
import { calculationSubstitution, type CalculationInput, type CalculationStep } from './network-learning.js';
import type { ResultValue } from './network-results.js';

export const dutyAccessoryTypes: ReadonlySet<string> = new Set([
  'differential-pressure-gauge',
  'adjustable-pressure-switch',
  'manual-shutoff',
  'flow-meter',
  'return-filter',
]);
export const dutyAccessoryConditions = [
  '单泵、单油箱、单个受支持的双作用缸。吸油、供油与回油须各有唯一可辨路径，按稳态阻性负载和指定动作方向估算。',
  '截止阀按工况状态或保存初态判断。工况给定的中间有效面积按阀口公式核算压降，全开沿用手填的其余损失，关闭按零通流处理。',
  '串联流量计按保存线性阻力计算；滤芯按 A→B 清洁回油工况计算压降，回油需求须在保存额定流量以内。回油流量按排油腔面积与速度计算，使用该关系时要求执行器容积效率为 1（忽略泄漏）。',
  '手填供油压降和回油基础压力须扣除本书单列的仪表与滤芯压降，并涵盖其余阀管损失和开启压差。按目标运动与溢流阀未开启估算；压力、供流或溢流约束不满足时，目标工况尚不能成立。',
  '差压表两个取压口不互通。仅从可追溯的目标压力与已计算的串联压降推得两侧压力；未分配的损失或未知压力保留未知。',
  '滤芯堵塞、旁通、吸油压降、动态过程及多支路流量分配超出本批模型。',
] as const;

const endpointKey = (endpoint: NetworkEndpoint) =>
  endpoint.kind === 'node' ? 'node:' + endpoint.nodeId : endpoint.componentId + ':' + endpoint.portId;
const failure = (phase: DutyPhase, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty', phase.name + '：' + message)],
});
const name = (component: NetworkComponent) =>
  component.label.trim() && component.label !== component.id
    ? component.label + ' [' + component.id + ']'
    : component.id;

interface Arc {
  readonly from: string;
  readonly to: string;
  readonly ideal: boolean;
  readonly component?: NetworkComponent;
  readonly physicalPipe?: Extract<NetworkConnection, { kind: 'pipe' }>;
}

/** Valves determine directed connectivity. Gauge ports have no internal arc. */
export function dutyPhasePaths(
  project: NetworkProject,
  phase: DutyPhase,
  useSavedThrottle: boolean,
  trackMetering = false,
) {
  const graph = new Map<string, Arc[]>();
  const link = (
    from: string,
    to: string,
    ideal: boolean,
    component?: NetworkComponent,
    physicalPipe?: Arc['physicalPipe'],
  ) => {
    const arcs = graph.get(from) ?? [];
    arcs.push({ from, to, ideal, ...(component ? { component } : {}), ...(physicalPipe ? { physicalPipe } : {}) });
    graph.set(from, arcs);
  };
  const shutoffs = project.design.components.filter((component) => component.typeId === 'manual-shutoff');
  for (const setting of phase.shutoffs ?? [])
    if (!shutoffs.some((component) => component.id === setting.componentId))
      return failure(phase, '截止阀设定引用未知或非截止阀实例 ' + setting.componentId + '。');
  const states: { component: NetworkComponent; area: number; origin: '工况指定' | '工程初态' }[] = [];
  for (const component of shutoffs) {
    const explicit = phase.shutoffs?.find((setting) => setting.componentId === component.id);
    const initial = project.design.initialConditions.find((item) => item.componentId === component.id);
    const maximum = component.parameters.hydraulic?.maximumAreaM2;
    const area = explicit
      ? explicit.state === 'partial'
        ? explicit.openingAreaM2
        : explicit.state === 'open'
          ? maximum
          : 0
      : initial?.kind === 'throttle'
        ? initial.openingAreaM2
        : undefined;
    if (maximum === undefined || area === undefined)
      return failure(phase, name(component) + ' 缺少截止阀设计开闭依据。');
    if (explicit?.state === 'partial' && !(area > 0 && area < maximum))
      return failure(phase, name(component) + ' 的工况有效开口须大于零且小于保存最大面积。');
    states.push({ component, area, origin: explicit ? '工况指定' : '工程初态' });
  }
  for (const edge of project.design.connections) {
    if (edge.kind === 'signal') continue;
    const a = endpointKey(edge.from),
      b = endpointKey(edge.to);
    const physicalPipe = edge.kind === 'pipe' ? edge : undefined;
    link(a, b, edge.kind === 'ideal', undefined, physicalPipe);
    link(b, a, edge.kind === 'ideal', undefined, physicalPipe);
  }
  for (const component of project.design.components) {
    const join = (a: string, b: string, both = true, tracked = false) => {
      const from = component.id + ':' + a,
        to = component.id + ':' + b;
      link(from, to, false, tracked ? component : undefined);
      if (both) link(to, from, false, tracked ? component : undefined);
    };
    if (component.typeId === 'throttle' || component.typeId === 'one-way-throttle') {
      if (!useSavedThrottle) join('A', 'B', true, trackMetering);
      else {
        const initial = project.design.initialConditions.find((item) => item.componentId === component.id);
        if (initial?.kind !== 'throttle') return failure(phase, name(component) + ' 缺少保存的节流开口。');
        if (initial.openingAreaM2 > 0) join('A', 'B', component.typeId === 'throttle', trackMetering);
        if (component.typeId === 'one-way-throttle') join('B', 'A', false, trackMetering);
      }
    }
    if (component.typeId === 'check-valve') join('A', 'B', false, trackMetering);
    if (
      component.typeId === 'manual-shutoff' &&
      states.some((state) => state.component === component && state.area > 0)
    )
      join('A', 'B', true, true);
    if (component.typeId === 'flow-meter' || component.typeId === 'return-filter') join('A', 'B', true, true);
    if (dutyControlValveTypes.has(component.typeId)) join('P', 'A', false, true);
    if (component.typeId === 'pilot-check') join('A', 'B', true, true);
    if (component.typeId === 'three-way-flow-control') join('P', 'A', false, true);
    if (component.typeId === 'pressure-reducing-relieving') {
      const action = phase.actions[0];
      const outlet = action && action.componentId + ':' + (action.direction === 'forward' ? 'B' : 'A');
      if (outlet && path(component.id + ':A', outlet, undefined, true)) join('A', 'T', false, true);
      else join('P', 'A', false, true);
    }
    if (component.typeId === 'valve') {
      const slot = phase.valves.find((entry) => entry.componentId === component.id);
      if (slot) for (const [a, b] of networkValvePaths(component, slot.positionId)) join(a, b, true, trackMetering);
    }
  }
  function path(
    from: string,
    to: string,
    exclude?: Arc,
    idealOnly = false,
    omitPipe?: readonly [string, string],
  ): Arc[] | null {
    const seen = new Set([from]);
    const pending = [from];
    const previous = new Map<string, Arc>();
    for (const current of pending) {
      if (current === to) {
        const result: Arc[] = [];
        let edge = previous.get(to);
        while (edge) {
          result.push(edge);
          edge = previous.get(edge.from);
        }
        return result.reverse();
      }
      for (const edge of graph.get(current) ?? []) {
        if (
          seen.has(edge.to) ||
          edge === exclude ||
          (idealOnly && !edge.ideal) ||
          (omitPipe &&
            edge.physicalPipe &&
            ((edge.from === omitPipe[0] && edge.to === omitPipe[1]) ||
              (edge.from === omitPipe[1] && edge.to === omitPipe[0])))
        )
          continue;
        seen.add(edge.to);
        previous.set(edge.to, edge);
        pending.push(edge.to);
      }
    }
    return null;
  }
  return {
    ok: true,
    value: {
      path,
      uniquePath(from: string, to: string, omitPipe?: readonly [string, string]) {
        const route = path(from, to, undefined, false, omitPipe);
        return route && !route.some((arc) => path(from, to, arc, false, omitPipe)) ? route : null;
      },
      reachable: (from: string, to: string) => path(from, to) !== null,
      idealReachable: (from: string, to: string) => path(from, to, undefined, true) !== null,
      states,
      graph,
    },
  } as const;
}
export type DutyPhasePaths = Extract<ReturnType<typeof dutyPhasePaths>, { ok: true }>['value'];

const input = (reference: string, value: number, unit: string, source: string): CalculationInput => ({
  reference,
  value: { kind: 'known', value },
  unit,
  source,
});
const known = (value: number): ResultValue => ({ kind: 'known', value });

function accessoryStep(
  phase: DutyPhase,
  index: number,
  component: NetworkComponent,
  field: string,
  label: string,
  formula: string,
  unit: string,
  value: ResultValue,
  inputs: readonly CalculationInput[],
  scale = 1,
  displayUnit = unit,
): CalculationStep {
  return {
    key: `phase${index}:${component.id}:${field}`,
    label: `${phase.name} / ${name(component)} ${label}`,
    source: 'preliminary',
    formula,
    unit,
    inputs,
    substitution: calculationSubstitution(inputs),
    value,
    display: {
      unit: displayUnit,
      value: value.kind === 'known' ? known(value.value * scale) : value,
      conversion: `显示值=SI值×${scale}`,
    },
  };
}

interface SeriesInput {
  readonly pumpId: string;
  readonly tankId: string;
  readonly inlet: string;
  readonly outlet: string;
  readonly inletFlow: number;
  readonly outletArea: number;
  readonly speed: number;
  readonly volumetricEfficiency: number;
}
export interface DutyPressureDrop {
  readonly from: string;
  readonly to: string;
  readonly dropPa: number;
}

/** Unique simple paths provide flow provenance. Open relief flow and branch splitting are outside this model. */
export function estimateDutyAccessories(
  project: NetworkProject,
  phase: DutyPhase,
  index: number,
  paths: DutyPhasePaths,
  conditions: SeriesInput,
) {
  const pump = conditions.pumpId + ':P',
    tank = conditions.tankId + ':T';
  const segments = [
    { kind: 'suction', from: tank, to: conditions.pumpId + ':S' },
    { kind: 'supply', from: pump, to: conditions.inlet },
    { kind: 'return', from: conditions.outlet, to: tank },
  ] as const;
  const steps = paths.states.map(({ component, area, origin }) =>
    accessoryStep(
      phase,
      index,
      component,
      'shutoff',
      `截止阀${area === 0 ? '关闭' : area === component.parameters.hydraulic?.maximumAreaM2 ? '全开' : '中间有效开口'}（${origin}）`,
      'model parameter',
      'm²',
      known(area),
      [],
    ),
  );
  const active = new Set<string>();
  const drops: DutyPressureDrop[] = [];
  let supplyLossPa = 0,
    returnLossPa = 0;
  for (const segment of segments) {
    const route = paths.uniquePath(segment.from, segment.to);
    if (!route) return failure(phase, '吸油、供油与回油须有唯一通路；发现断路或并联、旁路，不能确定串联元件流量。');
    for (const arc of route) {
      const component = arc.component;
      if (component?.typeId === 'manual-shutoff') {
        const state = paths.states.find((entry) => entry.component.id === component.id);
        const maximum = component.parameters.hydraulic?.maximumAreaM2;
        if (state && state.area > 0 && state.area < (maximum ?? 0)) {
          const coefficient = component.parameters.hydraulic?.flowCoefficient;
          if (
            !coefficient ||
            segment.kind === 'suction' ||
            (segment.kind === 'return' && conditions.volumetricEfficiency !== 1)
          )
            return failure(phase, name(component) + ' 中间开度须有流量系数，限供回油串联，回油侧要求缸容积效率为 1。');
          const flow = segment.kind === 'return' ? conditions.outletArea * conditions.speed : conditions.inletFlow;
          const density = project.design.fluid.densityKgPerM3;
          const drop = orificeResistance(density, coefficient, state.area) * flow ** 2;
          if (!Number.isFinite(drop)) return failure(phase, name(component) + ' 中间开口压降超出数值范围。');
          const operands = [
            input('Q', flow, 'm³/s', '本支路目标流量'),
            input('A', state.area, 'm²', '工况有效开口'),
            input('Cq', coefficient, '1', '保存参数'),
            input('rho', density, 'kg/m³', '油液参数'),
          ];
          steps.push(
            accessoryStep(
              phase,
              index,
              component,
              'partial-flow',
              '中间开口流量',
              '工况目标流量',
              'm³/s',
              known(flow),
              [],
              60000,
              'L/min',
            ),
          );
          steps.push(
            accessoryStep(
              phase,
              index,
              component,
              'partial-drop',
              '中间开口压降',
              'dp=rho*(Q/(Cq*A))^2/2',
              'Pa',
              known(drop),
              operands,
              1e-3,
              'kPa',
            ),
          );
          drops.push({ from: arc.from, to: arc.to, dropPa: drop });
          if (segment.kind === 'return') returnLossPa += drop;
          else supplyLossPa += drop;
        }
      }
      if (component?.typeId !== 'flow-meter' && component?.typeId !== 'return-filter') continue;
      const filter = component.typeId === 'return-filter';
      const forward = arc.from === component.id + ':A';
      if (segment.kind === 'suction' || (filter && (segment.kind !== 'return' || !forward)))
        return failure(phase, name(component) + ' 位置或方向超出支持范围。流量计限供/回油，过滤器限 A→B 回油。');
      const returning = segment.kind === 'return';
      if (returning && conditions.volumetricEfficiency !== 1)
        return failure(phase, name(component) + ' 的回油流量需明确忽略泄漏，请使用执行器容积效率 1。');
      if (active.has(component.id)) return failure(phase, name(component) + ' 同时位于多条路径，无法确定流量。');
      active.add(component.id);
      const flow = returning ? conditions.outletArea * conditions.speed : conditions.inletFlow;
      const signedFlow = forward ? flow : -flow;
      const source = 'saved-parameter:' + component.id;
      let drop: number;
      let formula: string;
      const flowInputs = returning
        ? [
            input('Aout', conditions.outletArea, 'm²', '排油腔面积'),
            input('speed', conditions.speed, 'm/s', '工况速度'),
          ]
        : [];
      const operands: CalculationInput[] = [
        input('qA', signedFlow, 'm³/s', returning ? '排油腔面积×速度' : '油缸进油需求'),
      ];
      if (filter) {
        const ratedFlow = component.parameters.hydraulic?.filterRatedFlowM3PerS;
        const ratedDrop = component.parameters.hydraulic?.filterRatedDropPa;
        if (ratedFlow === undefined || ratedDrop === undefined)
          return failure(phase, name(component) + ' 缺少清洁滤芯额定流量或额定压降。');
        if (flow > ratedFlow * (1 + 1e-12))
          return failure(phase, name(component) + ' 的回油需求超过保存额定流量，清洁滤芯压降超出本次核算范围。');
        drop = seriesAccessoryDrop({ kind: 'filter', ratedDropPa: ratedDrop, ratedFlowM3PerS: ratedFlow }, flow);
        formula = 'dp=dpRated*(qA/qRated)^2';
        operands.push(input('qRated', ratedFlow, 'm³/s', source), input('dpRated', ratedDrop, 'Pa', source));
      } else {
        const resistance = component.parameters.hydraulic?.meterResistancePaSPerM3;
        if (resistance === undefined) return failure(phase, name(component) + ' 缺少保存流阻。');
        drop = seriesAccessoryDrop({ kind: 'meter', resistancePaSPerM3: resistance }, flow);
        formula = 'dp=R*qA';
        operands.push(input('R', resistance, 'Pa·s/m³', source));
      }
      steps.push(
        accessoryStep(
          phase,
          index,
          component,
          'series-flow',
          `${returning ? '回油' : '供油'}流量（A→B 为正）`,
          returning && forward ? 'Qreturn=Aout*v' : '沿唯一通路取有符号流量',
          'm³/s',
          known(signedFlow),
          flowInputs,
          60000,
          'L/min',
        ),
        accessoryStep(
          phase,
          index,
          component,
          'series-drop',
          '压差（A−B）',
          formula,
          'Pa',
          known(forward ? drop : -drop),
          operands,
          1e-3,
          'kPa',
        ),
      );
      drops.push({ from: arc.from, to: arc.to, dropPa: drop });
      if (returning) returnLossPa += drop;
      else supplyLossPa += drop;
    }
  }
  for (const component of project.design.components) {
    if ((component.typeId === 'flow-meter' || component.typeId === 'return-filter') && !active.has(component.id))
      steps.push(
        accessoryStep(
          phase,
          index,
          component,
          'inactive',
          '未参与本工况通流计算',
          '未在三条稳态通路上',
          '1',
          { kind: 'not-applicable', reason: '该元件不在本工况的吸油、供油或回油通路。' },
          [],
        ),
      );
  }
  return { ok: true, value: { supplyLossPa, returnLossPa, drops, steps } } as const;
}

/** Propagate only through ideal connections and calculated device drops. Conflicting anchors give no reading. */
export function dutyPressureMeasurementSteps(
  project: NetworkProject,
  phase: DutyPhase,
  index: number,
  paths: DutyPhasePaths,
  drops: readonly DutyPressureDrop[],
  anchors: ReadonlyMap<string, number>,
): readonly CalculationStep[] {
  const edges = new Map<string, { to: string; dropPa: number }[]>();
  const add = (from: string, to: string, dropPa: number) => {
    const list = edges.get(from) ?? [];
    list.push({ to, dropPa });
    edges.set(from, list);
  };
  for (const [from, arcs] of paths.graph) for (const arc of arcs) if (arc.ideal) add(from, arc.to, 0);
  for (const { from, to, dropPa } of drops) {
    add(from, to, dropPa);
    add(to, from, -dropPa);
  }
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, 1e-10 * Math.max(Math.abs(a), Math.abs(b)));
  function pressure(start: string): number | undefined {
    const offsets = new Map([[start, 0]]);
    const pending = [{ at: start, offset: 0 }];
    let resolved: number | undefined;
    for (const { at, offset } of pending) {
      const anchor = anchors.get(at);
      if (anchor !== undefined) {
        const value = anchor + offset;
        if (resolved !== undefined && !close(resolved, value)) return undefined;
        resolved = value;
      }
      for (const edge of edges.get(at) ?? []) {
        const next = offset + edge.dropPa;
        const previous = offsets.get(edge.to);
        if (previous === undefined) {
          offsets.set(edge.to, next);
          pending.push({ at: edge.to, offset: next });
        } else if (!close(previous, next)) return undefined;
      }
    }
    return resolved;
  }
  return project.design.components.flatMap((component) => {
    if (component.typeId === 'adjustable-pressure-switch') {
      const p = pressure(component.id + ':H');
      const trip = component.parameters.hydraulic?.tripPressurePa;
      const pressureInputs = p === undefined ? [] : [input('p_H', p, 'Pa', '同工况已知压力与串联压降')];
      const unavailable = { kind: 'unknown', reason: 'H 口没有经理想取压支路接到可追溯的同工况压力。' } as const;
      return [
        accessoryStep(
          phase,
          index,
          component,
          'sense-pressure',
          'H 口目标取压',
          'p_H=p_tap',
          'Pa',
          p === undefined ? unavailable : known(p),
          pressureInputs,
          1e-6,
          'MPa',
        ),
        accessoryStep(
          phase,
          index,
          component,
          'trip-margin',
          '目标取压减动作阈值',
          'p_H-p_trip',
          'Pa',
          p === undefined
            ? unavailable
            : trip === undefined
              ? { kind: 'unknown', reason: '缺少保存的动作压力。' }
              : known(p - trip),
          [
            ...pressureInputs,
            ...(trip === undefined ? [] : [input('p_trip', trip, 'Pa', 'saved-parameter:' + component.id)]),
          ],
          1e-6,
          'MPa',
        ),
      ];
    }
    if (component.typeId === 'differential-pressure-gauge') {
      const a = pressure(component.id + ':A'),
        b = pressure(component.id + ':B');
      return [
        accessoryStep(
          phase,
          index,
          component,
          'gauge-drop',
          '差压表读数（A−B）',
          'p_A-p_B',
          'Pa',
          a === undefined || b === undefined
            ? { kind: 'unknown', reason: '两侧压力缺少一致的核算依据。' }
            : known(a - b),
          [
            ...(a === undefined ? [] : [input('A.pressure', a, 'Pa', '同工况已知压力与串联压降')]),
            ...(b === undefined ? [] : [input('B.pressure', b, 'Pa', '同工况已知压力与串联压降')]),
          ],
          1e-3,
          'kPa',
        ),
      ];
    }
    return [];
  });
}
