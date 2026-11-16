import {
  checkJson,
  ContractReader,
  parseNetworkControlBatch,
  type NetworkControl,
  type NetworkProject,
  type NetworkSnapshot,
  type Result,
} from '@hyd/domain';

export type NetworkOnlineControl =
  | NetworkControl
  | {
      readonly kind: 'target-flow';
      readonly componentId: string;
      readonly targetM3PerS: number;
    };
export interface NetworkFlowRegulatorView {
  readonly componentId: string;
  readonly targetM3PerS: number;
  readonly actualM3PerS: number | null;
  readonly status: 'regulating' | 'reached' | 'saturated' | 'pressure-unavailable' | 'measurement-unavailable';
}
/** High-level intents never enter the native accepted-control protocol. */
export function parseNetworkOnlineControlBatch(
  project: NetworkProject,
  input: unknown,
): Result<readonly NetworkOnlineControl[]> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader();
  const controls = r.array(input, '/batch', 30).flatMap((raw, i): NetworkOnlineControl[] => {
    if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'target-flow') {
      const field = '/batch/' + i,
        o = r.object(raw, field, ['kind', 'componentId', 'targetM3PerS']);
      const componentId = r.id(o.componentId, field + '/componentId');
      if (!project.design.components.some((c) => c.id === componentId && c.typeId === 'throttle'))
        r.fail('CONTROL_INVALID', field, '目标流量闭环仅支持双向节流阀；单向旁通阀不能保证反向调节。');
      return [
        { kind: 'target-flow', componentId, targetM3PerS: r.number(o.targetM3PerS, field + '/targetM3PerS', -10, 10) },
      ];
    }
    const parsed = parseNetworkControlBatch(project, [raw]);
    if (!parsed.ok) {
      r.diagnostics.push(...parsed.diagnostics);
      return [];
    }
    if (parsed.value.some((c) => c.kind === 'displacement' && c.source === 'controller'))
      r.fail('CONTROL_INVALID', '/batch/' + i, '百分比给定须由已绑定的动态控制器发送。');
    return [...parsed.value];
  });
  r.unique(
    controls.map((c) => c.componentId),
    '/batch',
  );
  return r.finish(controls);
}
export function readNetworkFlowRegulators(
  r: ContractReader,
  input: unknown,
  project: NetworkProject,
): readonly NetworkFlowRegulatorView[] {
  return r.array(input, '/flowRegulators', 30).map((raw, i) => {
    const field = '/flowRegulators/' + i,
      o = r.object(raw, field, ['componentId', 'targetM3PerS', 'actualM3PerS', 'status']);
    const componentId = r.id(o.componentId, field + '/componentId');
    if (!project.design.components.some((c) => c.id === componentId && c.typeId === 'throttle'))
      r.fail('CONTROL_INVALID', field, '闭环状态的元件无效。');
    const statuses = ['regulating', 'reached', 'saturated', 'pressure-unavailable', 'measurement-unavailable'] as const;
    const status = statuses.find((s) => s === o.status);
    if (!status) r.fail('PROTOCOL_INVALID', field, '未知闭环状态。');
    return {
      componentId,
      targetM3PerS: r.number(o.targetM3PerS, field, -10, 10),
      actualM3PerS: o.actualM3PerS === null ? null : r.number(o.actualM3PerS, field, -1e12, 1e12),
      status: status ?? 'measurement-unavailable',
    };
  });
}
/** One bounded feedback correction per 10 ms logical tick. No wall clock or hidden hydraulic source.
 * Gain is the local orifice sensitivity at measured pressure; feedback uses accepted port flow.
 * The 0.35 gain, 10% full-stroke slew limit and hard bounds avoid integral windup. */
export function networkFlowCorrection(
  project: NetworkProject,
  point: NetworkSnapshot,
  componentId: string,
  targetM3PerS: number,
): { readonly view: NetworkFlowRegulatorView; readonly control: NetworkControl | null } {
  const component = project.design.components.find((c) => c.id === componentId && c.typeId === 'throttle');
  const applied = point.appliedControls.find((c) => c.componentId === componentId);
  const read = (quantity: 'pressure' | 'flow', portId: string) => {
    const v = point.readings.find(
      (r) =>
        r.quantity === quantity &&
        r.location.kind === 'port' &&
        r.location.componentId === componentId &&
        r.location.portId === portId,
    )?.value;
    return v?.kind === 'known' ? v.value : null;
  };
  const actual = read('flow', 'A'),
    a = read('pressure', 'A'),
    b = read('pressure', 'B');
  const view = (status: NetworkFlowRegulatorView['status']): NetworkFlowRegulatorView => ({
    componentId,
    targetM3PerS,
    actualM3PerS: actual,
    status,
  });
  const maximum = component?.parameters.hydraulic?.maximumAreaM2,
    coefficient = component?.parameters.hydraulic?.flowCoefficient;
  if (
    !component ||
    applied?.kind !== 'opening-area' ||
    maximum === undefined ||
    coefficient === undefined ||
    actual === null ||
    a === null ||
    b === null
  )
    return { view: view('measurement-unavailable'), control: null };
  let area = applied.areaM2,
    status: NetworkFlowRegulatorView['status'] = 'regulating';
  if (targetM3PerS === 0) {
    area = 0;
    status = Math.abs(actual) < 1e-9 ? 'reached' : 'regulating';
  } else if ((a - b) * Math.sign(targetM3PerS) <= 1) {
    area = 0;
    status = 'pressure-unavailable';
  } else {
    const gain = coefficient * Math.sqrt((2 * Math.abs(a - b)) / project.design.fluid.densityKgPerM3);
    const correction = (0.35 * (Math.abs(targetM3PerS) - actual * Math.sign(targetM3PerS))) / gain;
    area = Math.max(0, Math.min(maximum, area + Math.max(-maximum * 0.1, Math.min(maximum * 0.1, correction))));
    const tolerance = Math.max(1e-9, Math.abs(targetM3PerS) * 0.001);
    if (Math.abs(actual - targetM3PerS) <= tolerance) {
      area = applied.areaM2;
      status = 'reached';
    } else if (applied.areaM2 === maximum && area === maximum) status = 'saturated';
  }
  return {
    view: view(status),
    control:
      Math.abs(area - applied.areaM2) > Math.max(1e-15, maximum * 1e-9)
        ? { kind: 'opening-area', componentId, areaM2: area }
        : null,
  };
}
