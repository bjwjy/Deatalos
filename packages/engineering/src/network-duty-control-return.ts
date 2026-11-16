import { diagnostic, type NetworkComponent, type NetworkProject, type Result } from '@hyd/domain';
import { dutyPhasePaths, type DutyPhasePaths, type DutyPressureDrop } from './network-duty-accessories.js';
import { hasControlDrain } from './network-duty-control-valves.js';
import { pipeParameters, reportReturnPipe, type ReturnPipeResult } from './network-duty-return-pipes.js';

export const pressurizedControlDrainCondition =
  '减压阀或顺序阀的 Y 口可经理想支路接同一油箱的主回油取压点，按零流量压力参考。换向阀排油工作位按理想通路，串联管和附件按缸排油量计损。Y 压力取油箱压力加接点下游压降，缸背压计入全程损失。非零 Y 泄流、并联回油、其他压力源与动态切换待核。';

export interface ControlDrainBoundary {
  readonly pressurePa: number;
  readonly reference: 'tank' | 'return';
  readonly coupled: boolean;
  readonly pipeDropPa: number;
  readonly pipes: readonly ReturnPipeResult[];
}

function controlReturnPath(
  project: NetworkProject,
  paths: DutyPhasePaths,
  component: NetworkComponent,
  tPort: string,
  tank: string,
) {
  const route = paths.uniquePath(tPort, tank);
  if (
    !route?.every(
      (arc) =>
        arc.ideal ||
        arc.physicalPipe ||
        arc.component?.typeId === 'return-filter' ||
        arc.component?.typeId === 'flow-meter',
    )
  )
    return undefined;
  if (
    project.design.connections.some((edge) => edge.kind === 'pipe' && !route.some((arc) => arc.physicalPipe === edge))
  )
    return undefined;
  if (![tPort, ...route.map((arc) => arc.to)].some((node) => paths.idealReachable(component.id + ':Y', node)))
    return undefined;
  return route;
}

export function pressurizedControlDrainPipeEligible(project: NetworkProject, connectionId: string): boolean {
  const components = project.design.components;
  const controls = components.filter(hasControlDrain);
  const valves = components.filter((part) => part.typeId === 'valve');
  const pumps = components.filter((part) => part.typeId === 'pump');
  const tanks = components.filter((part) => part.typeId === 'tank');
  const [control] = controls;
  const [valve] = valves;
  const [pump] = pumps;
  const [tank] = tanks;
  if (
    !control ||
    !valve ||
    !pump ||
    !tank ||
    controls.length !== 1 ||
    valves.length !== 1 ||
    pumps.length !== 1 ||
    tanks.length !== 1 ||
    pump.definition.id !== 'teaching:pump' ||
    components.filter((part) => part.typeId === 'cylinder').length !== 1
  )
    return false;
  const graph = dutyPhasePaths(project, { name: 'Y 回油管', valves: [], actions: [] }, false);
  if (!graph.ok || !graph.value.uniquePath(tank.id + ':T', pump.id + ':S')?.every((arc) => arc.ideal)) return false;
  const route = controlReturnPath(project, graph.value, control, valve.id + ':T', tank.id + ':T');
  const pipe = route?.find((arc) => arc.physicalPipe?.id === connectionId)?.physicalPipe;
  return pipe !== undefined && pipeParameters(project, pipe, 'Y 取压回油管').ok;
}

export function resolveControlDrain(
  project: NetworkProject,
  paths: DutyPhasePaths,
  input: {
    readonly component: NetworkComponent;
    readonly pump: NetworkComponent;
    readonly tankId: string;
    readonly tankPa: number;
    readonly outlet: string;
    readonly returnBasePa: number;
    readonly efficiency: number;
    readonly returnFlow: number;
    readonly seriesDrops: readonly DutyPressureDrop[];
  },
): Result<ControlDrainBoundary> {
  const { component, pump, tankPa } = input;
  const tank = input.tankId + ':T';
  const y = component.id + ':Y';
  const fail = (message: string): Result<never> => ({
    ok: false,
    diagnostics: [
      diagnostic(
        'DUTY_UNSUPPORTED',
        '/duty/control-drain',
        (component.label || component.id) + ' [' + component.id + ']：' + message,
      ),
    ],
  });
  const cylinderReturn = paths.uniquePath(input.outlet, tank);
  const yDirect = paths.idealReachable(y, tank);
  if (yDirect && cylinderReturn && !cylinderReturn.some((arc) => arc.physicalPipe))
    return { ok: true, value: { pressurePa: tankPa, reference: 'tank', coupled: false, pipeDropPa: 0, pipes: [] } };
  if (pump.definition.id !== 'teaching:pump' || !paths.uniquePath(tank, pump.id + ':S')?.every((arc) => arc.ideal))
    return fail('有压 Y 回油限单定量泵及唯一理想吸油通路。');
  const valveReturn =
    cylinderReturn?.findIndex((arc) => arc.component?.typeId === 'valve' && arc.to === arc.component.id + ':T') ?? -1;
  const tPort = cylinderReturn?.[valveReturn]?.to;
  if (!cylinderReturn || !tPort || !cylinderReturn.slice(0, valveReturn).every((arc) => arc.ideal))
    return fail('有压 Y 回油要求缸排油经理想连接进入换向阀，T 口至油箱为唯一回油通路。');
  const route = controlReturnPath(project, paths, component, tPort, tank);
  if (!route)
    return fail(
      'Y 泄油口须经理想支路接同一油箱或唯一主回油通路的已知压力点。断开、独立有损 Y 支管、回油旁路或其他物理管接法待核。',
    );
  if (input.efficiency !== 1 || Math.abs(input.returnBasePa - tankPa) > 1e-6)
    return fail('有压 Y 回油要求缸容积效率为 1，回油基础压力填油箱压力，避免重复计损。');

  let pressure = tankPa;
  let pressurePa = yDirect ? tankPa : undefined;
  let pipeDropPa = 0;
  const pipes: ReturnPipeResult[] = [];
  for (const arc of [...route].reverse()) {
    if (arc.physicalPipe) {
      const law = pipeParameters(project, arc.physicalPipe, 'Y 取压回油管');
      if (!law.ok) return law;
      const result = reportReturnPipe(law.value, input.returnFlow, pressure, 'Y 取压回油管');
      if (!result.ok) return result;
      pressure = result.value.upstreamPressurePa;
      pipeDropPa += result.value.pressureDropPa;
      pipes.unshift(result.value);
    } else if (!arc.ideal) {
      const drop = input.seriesDrops.find((item) => item.from === arc.from && item.to === arc.to)?.dropPa;
      if (drop === undefined) return fail('主回油附件缺少已核算压降，Y 口压力待核。');
      pressure += drop;
    }
    if (paths.idealReachable(y, arc.from)) pressurePa = pressure;
  }
  if (pressurePa === undefined || !Number.isFinite(pressure) || pressure > 70e6)
    return fail('Y 口或主回油压力超出可核算范围。');
  return { ok: true, value: { pressurePa, reference: yDirect ? 'tank' : 'return', coupled: true, pipeDropPa, pipes } };
}
