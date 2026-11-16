import { isLinearActuatorType, isNetworkActuatorType, type NetworkProject } from '@hyd/domain';
import { dutyPhasePaths } from './network-duty-accessories.js';

export function dutyMainTank(project: NetworkProject, pumpId: string) {
  const tanks = project.design.components.filter((c) => c.typeId === 'tank');
  if (tanks.length === 1) return tanks[0];
  if (tanks.length !== 2 || !project.design.components.some((c) => c.definition.id === 'teaching:pilot-check'))
    return undefined;
  const paths = dutyPhasePaths(project, { name: '主油箱识别', valves: [], actions: [] }, true);
  if (!paths.ok) return undefined;
  const suction = tanks.filter((tank) => paths.value.idealReachable(tank.id + ':T', pumpId + ':S'));
  return suction.length === 1 ? suction[0] : undefined;
}

export type DutyAutomaticNumber =
  | { readonly kind: 'project' | 'assumption'; readonly value: number; readonly source: string }
  | { readonly kind: 'unavailable'; readonly source: string };

export interface DutyAutomaticAction {
  readonly componentId: string;
  readonly speed: DutyAutomaticNumber;
  readonly resistingLoad: DutyAutomaticNumber;
  readonly supplyLossPa: DutyAutomaticNumber;
  readonly returnPressurePa: DutyAutomaticNumber;
  readonly mechanicalEfficiency: DutyAutomaticNumber;
  readonly volumetricEfficiency: DutyAutomaticNumber;
}

export interface DutyAutomaticDefaults {
  readonly global: {
    readonly angularSpeedRadPerS: DutyAutomaticNumber;
    readonly pumpVolumetricEfficiency: DutyAutomaticNumber;
    readonly totalEfficiency: DutyAutomaticNumber;
    readonly pressureLimitPa: DutyAutomaticNumber;
  };
  readonly actions: readonly DutyAutomaticAction[];
}

/** Versioned teaching inputs, never inferred measurements or a promise of supply capacity.
 * Geometry and topology remain the saved design. Manual targets never enter this function. */
export function networkDutyAutomaticDefaults(project: NetworkProject, pumpId: string): DutyAutomaticDefaults {
  const assumed = (value: number, source: string): DutyAutomaticNumber => ({
    kind: 'assumption',
    value,
    source: '教学自动配置 v1：' + source,
  });
  const pump = project.design.components.find((c) => c.id === pumpId && c.typeId === 'pump');
  const speed = pump?.parameters.drive?.angularSpeedRadPerS;
  const sources = project.design.components.filter((c) => c.typeId === 'pressure-source');
  const source = sources.length === 1 ? sources[0] : undefined;
  const pressure = source?.parameters.hydraulic?.pressurePa;
  const tank = dutyMainTank(project, pumpId);
  const returnPressure = tank?.parameters.hydraulic?.pressurePa;
  return {
    global: {
      angularSpeedRadPerS:
        speed === undefined
          ? { kind: 'unavailable', source: '请指定具有保存转速的目标泵' }
          : { kind: 'project', value: speed, source: (pump?.label || pumpId) + ' 的保存转速' },
      pumpVolumetricEfficiency: assumed(1, '理想泵容积效率1；不是原生泄漏效率'),
      totalEfficiency: assumed(1, '理想泵总效率1；不代表实际轴功率损失'),
      pressureLimitPa:
        pressure === undefined
          ? assumed(2e6, '供油预算2 MPa；是试算条件，非实际供油保证，不改变溢流阀')
          : {
              kind: 'project',
              value: pressure,
              source: (source?.label || '唯一压力源') + ' 的同基准压力设定；仅作可覆盖预算',
            },
    },
    actions: project.design.components
      .filter((c) => isNetworkActuatorType(c.typeId))
      .map((c) => ({
        componentId: c.id,
        speed: isLinearActuatorType(c.typeId)
          ? assumed(0.001, '目标速度1 mm/s；不是保存的运行速度')
          : assumed(2 * Math.PI, '目标转速60 r/min；不是保存的运行转速'),
        resistingLoad: isLinearActuatorType(c.typeId)
          ? assumed(200, '稳态总阻力0.2 kN；未采用设计静态外载或惯性')
          : assumed(0.1, '稳态总阻矩0.1 N·m；未采用设计静态外载或惯性'),
        supplyLossPa: assumed(0, '忽略供油阀管压降；不是实测或物理管计算值'),
        returnPressurePa:
          returnPressure === undefined
            ? { kind: 'unavailable', source: '无法确定唯一油箱压力，请明确回油腔压力' }
            : assumed(returnPressure, '忽略回油压降，回油腔按' + (tank?.label || '唯一油箱') + '压力；非实际腔压'),
        mechanicalEfficiency: assumed(1, '理想执行器机械效率1'),
        volumetricEfficiency: assumed(1, '理想执行器容积效率1'),
      })),
  };
}
