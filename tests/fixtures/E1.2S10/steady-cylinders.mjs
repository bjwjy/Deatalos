import { parseNetworkProject } from '@hyd/domain';
import { good } from '../E04B/graphs.mjs';
import { pumpedCylinder } from '../E26/third-batch-actuators.mjs';

const titles = {
  'cushioned-cylinder': '缓冲单杆缸',
  'cushioned-double-rod-cylinder': '缓冲双出杆缸',
  'single-acting-cylinder': '单作用缸',
};

export const cylinderTypes = Object.keys(titles);
export function steadyCylinderCircuit(type) {
  const document = structuredClone(pumpedCylinder(type, true));
  document.title = titles[type] + '稳态核算';
  const pump = document.design.components.find((part) => part.id === 'pump');
  pump.parameters.hydraulic.displacementM3PerRev = 6e-6;
  pump.parameters.drive.angularSpeedRadPerS = 50 * Math.PI;
  document.design.components.find((part) => part.id === 'part').label = titles[type];
  const positions = { pump: [300, 420], tank: [610, 565], direction: [610, 350], part: [610, 185] };
  for (const item of document.layout.components) [item.x, item.y] = positions[item.componentId];
  return good(parseNetworkProject(document));
}

export function steadyCylinderRequest(type, directions = ['forward', 'reverse']) {
  const single = type === 'single-acting-cylinder';
  return {
    pumpId: 'pump',
    angularSpeedRadPerS: 50 * Math.PI,
    pumpVolumetricEfficiency: 0.9,
    totalEfficiency: 0.8,
    pressureLimitPa: 3e6,
    phases: directions.map((direction) => ({
      name: direction === 'forward' ? '稳态伸出' : single ? '弹簧回程' : '稳态缩回',
      valves: [{ componentId: 'direction', positionId: direction === 'forward' ? 'extend' : 'retract' }],
      actions: [
        {
          componentId: 'part',
          direction,
          positionM: 0.05,
          speed: 0.05,
          resistingLoad: single ? 200 : 1000,
          supplyLossPa: 1.5e5,
          returnPressurePa: 2e5,
          mechanicalEfficiency: 1,
          volumetricEfficiency: 1,
        },
      ],
    })),
  };
}
