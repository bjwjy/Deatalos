import { preferredCylinderBoresMm, teachingCylinderRodMm } from './network-selection-policy.js';

// Private port of legacy preliminary sizing: assumptions and candidate series unchanged.
export function sizeLegacy(
  force: number,
  speed: number,
  pressure: number,
  stroke: number,
  rpm: number,
  etaV: number,
  etaTotal: number,
) {
  if (
    ![force, speed, pressure, stroke, rpm, etaV, etaTotal].every(Number.isFinite) ||
    force <= 0 ||
    speed <= 0 ||
    pressure <= 1.5 ||
    stroke <= 0 ||
    rpm <= 0 ||
    etaV <= 0 ||
    etaV > 1 ||
    etaTotal <= 0 ||
    etaTotal > etaV
  ) {
    throw Error('请填写正数，压力预算须大于 1.5 MPa，泵效率须满足 0 < 总效率 ≤ 容积效率 ≤ 1。');
  }
  // 1 MPa supply allowance, 0.5 MPa back pressure, rod/bore 0.6, eta 0.95.
  const effectiveP = pressure - 1 - 0.5 * (1 - 0.6 ** 2);
  const theoretical = Math.sqrt((4 * force * 1000) / (Math.PI * effectiveP * 1e6 * 0.95)) * 1000;
  const bore = preferredCylinderBoresMm.find((d) => {
    const rod = teachingCylinderRodMm(d);
    return ((Math.PI / 4) * ((pressure - 1) * d * d - 0.5 * (d * d - rod * rod)) * 0.95) / 1000 >= force;
  });
  if (!bore) throw Error('所需缸径超出本版 500 mm 候选上限。');
  const rod = teachingCylinderRodMm(bore),
    area = (Math.PI * (bore / 1000) ** 2) / 4;
  const Q = ((area * speed) / 1000) * 60000,
    disp = (Q * 1000) / (rpm * etaV);
  const disps = [4, 6.3, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500];
  const pump = disps.find((d) => d >= disp);
  if (!pump) throw Error('泵排量超出本版候选上限。');
  const actualQ = (pump * rpm * etaV) / 1000;
  return {
    bore,
    rod,
    stroke,
    theoretical,
    Q,
    displacement: disp,
    pump,
    actualQ,
    actualSpeed: (actualQ / 60000 / area) * 1000,
    power: (pressure * actualQ) / 60 / etaTotal,
    pressure,
    force,
    etaTotal,
  };
}
