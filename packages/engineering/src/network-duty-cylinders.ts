import { diagnostic, type NetworkComponent, type Result } from '@hyd/domain';

export const dutyBufferedCylinderTypes: ReadonlySet<string> = new Set([
  'cushioned-cylinder',
  'cushioned-double-rod-cylinder',
]);

export const bufferedDutyConditions = [
  '缓冲缸按给定行程位置做稳态点核算，位置从完全缩回端起算。两端缓冲段及机械端位不参与本核算。',
  '缓冲单杆缸按方向互换无杆腔与有杆腔面积，缓冲双出杆缸两侧均用保存的有效环形面积。',
  '公式和结果只适用于所列位置及已选阀位、阻性负载和损失条件。进入缓冲段后的减速、峰值压力与吸能需另行校核。',
] as const;
export const springDutyConditions = [
  '单作用缸只使用 A 口，按给定行程位置计算弹簧力。输入的总阻性负载包含未由机械效率覆盖的摩擦等阻力，缸内弹簧力由模型另计。',
  '液压伸出时 A 口接泵，供油压力按折算阻力与弹簧力计算。弹簧回程时 A 口独立回油箱，泵与缸隔离，泵支路须有明确限压。',
  '回程按所填 A 腔压力与目标速度核对力裕量。回油量采用扫掠面积乘速度，要求容积效率为 1。回程力不足时所填目标不能成立。',
  '回程结果用于判断该位置的力平衡。实际回程速度、全行程、泵卸荷或溢流功率需独立验证，回程不计入缸的泵规格需求。',
] as const;

export function dutyCylinderAreas(component: NetworkComponent) {
  const geometry = component.parameters.geometry;
  return component.typeId === 'cushioned-double-rod-cylinder'
    ? { areaA: geometry?.equalAnnularAreaM2, areaB: geometry?.equalAnnularAreaM2 }
    : { areaA: geometry?.capAreaM2, areaB: geometry?.rodSideAreaM2 };
}

export interface DutyTravel {
  readonly positionM: number;
  readonly strokeM: number;
  readonly lowerM: number;
  readonly upperM: number;
}

export function dutyCylinderTravel(
  component: NetworkComponent,
  positionM: number | undefined,
  phaseName: string,
): Result<DutyTravel> {
  const fail = (message: string): Result<never> => ({
    ok: false,
    diagnostics: [
      diagnostic('DUTY_UNSUPPORTED', '/duty/position', `${phaseName} / ${component.label || component.id}：${message}`),
    ],
  });
  const strokeM = component.parameters.geometry?.strokeM;
  if (strokeM === undefined) return fail('缺少保存行程。');
  if (positionM === undefined) return fail('请填写从完全缩回端起算的核算位置。');
  if (positionM <= 0 || positionM >= strokeM) return fail('核算位置须在行程内部，机械端位和行程外不能按稳态运动计算。');
  const buffered = dutyBufferedCylinderTypes.has(component.typeId);
  const lowerM = buffered ? component.parameters.cushion?.retractCushionLengthM : 0;
  const extend = buffered ? component.parameters.cushion?.extendCushionLengthM : 0;
  if (lowerM === undefined || extend === undefined) return fail('缺少保存的两端缓冲长度。');
  const upperM = strokeM - extend;
  if (upperM - lowerM <= 1e-12) return fail('两端缓冲段相接或重叠，当前没有可核算的缓冲区外行程。');
  if (positionM < lowerM || positionM > upperM)
    return fail(
      `位置在缓冲段内。缓冲区外范围为 ${Number((lowerM * 1000).toPrecision(8))}～${Number((upperM * 1000).toPrecision(8))} mm。`,
    );
  return { ok: true, value: { positionM, strokeM, lowerM, upperM } };
}
