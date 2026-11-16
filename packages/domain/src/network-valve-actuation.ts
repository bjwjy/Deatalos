import { ContractReader, immutable } from './reader.js';
export const valveManualOptions = ['none', 'button', 'lever', 'pedal'] as const;
export const valveMechanicalOptions = ['none', 'plunger', 'roller'] as const;
export const valveFluidOptions = ['none', 'hydraulic', 'solenoid'] as const;
export interface ValveEndActuation {
  readonly springReturn: boolean;
  readonly pilotStage: boolean;
  readonly manual: (typeof valveManualOptions)[number];
  readonly mechanical: (typeof valveMechanicalOptions)[number];
  readonly fluid: (typeof valveFluidOptions)[number];
}
export interface ValveActuation {
  readonly version: 1;
  readonly left: ValveEndActuation;
  readonly right: ValveEndActuation;
}
export const defaultValveActuation: ValveActuation = immutable({
  version: 1,
  left: { springReturn: true, pilotStage: false, manual: 'none', mechanical: 'none', fluid: 'solenoid' },
  right: { springReturn: true, pilotStage: false, manual: 'none', mechanical: 'none', fluid: 'solenoid' },
});
function option<T extends string>(reader: ContractReader, value: unknown, values: readonly T[], field: string): T {
  const selected = values.find((item) => item === value);
  if (selected !== undefined) return selected;
  reader.fail('VALVE_ACTUATION_INVALID', field, '不支持的换向阀驱动方式。');
  const first = values[0];
  if (first === undefined) throw new Error('Empty actuation option set');
  return first;
}
export function readValveActuation(reader: ContractReader, input: unknown, field: string): ValveActuation {
  const raw = reader.object(input, field, ['version', 'left', 'right']);
  reader.constant(raw.version, 1, field + '/version');
  const end = (value: unknown, path: string): ValveEndActuation => {
    const side = reader.object(value, path, ['springReturn', 'pilotStage', 'manual', 'mechanical', 'fluid']);
    for (const key of ['springReturn', 'pilotStage'])
      if (typeof side[key] !== 'boolean')
        reader.fail('VALVE_ACTUATION_INVALID', path + '/' + key, '驱动选项须为开关值。');
    return {
      springReturn: side.springReturn === true,
      pilotStage: side.pilotStage === true,
      manual: option(reader, side.manual, valveManualOptions, path + '/manual'),
      mechanical: option(reader, side.mechanical, valveMechanicalOptions, path + '/mechanical'),
      fluid: option(reader, side.fluid, valveFluidOptions, path + '/fluid'),
    };
  };
  return { version: 1, left: end(raw.left, field + '/left'), right: end(raw.right, field + '/right') };
}
const labels: Readonly<Record<string, string>> = {
  none: '',
  button: '按钮',
  lever: '手柄',
  pedal: '脚踏',
  plunger: '顶杆',
  roller: '滚轮',
  hydraulic: '液控',
  solenoid: '电磁',
};
export function directionalValveAutoName(positionCount: number, portCount: number, actuation: ValveActuation): string {
  const digits = ['', '', '二', '三', '四', '五'];
  const end = (value: ValveEndActuation) =>
    [value.manual, value.mechanical, value.fluid]
      .map((key) => labels[key])
      .filter(Boolean)
      .join('/');
  const left = end(actuation.left),
    right = end(actuation.right);
  const drive =
    left === right
      ? left
        ? '双' + left
        : '无外控'
      : [left ? '左' + left : '', right ? '右' + right : ''].filter(Boolean).join('·');
  const spring =
    actuation.left.springReturn && actuation.right.springReturn
      ? '双弹簧复位'
      : actuation.left.springReturn
        ? '左弹簧复位'
        : actuation.right.springReturn
          ? '右弹簧复位'
          : '';
  return `${actuation.left.pilotStage || actuation.right.pilotStage ? '先导式' : ''}${drive}${spring}${digits[positionCount]}位${digits[portCount]}通换向阀`;
}
/** Uses the first free suffix, preserving all existing names. */
export function uniqueValveName(base: string, occupied: readonly string[]): string {
  const names = new Set(occupied);
  if (!names.has(base)) return base;
  for (let index = 1; index <= occupied.length + 1; index++) if (!names.has(base + index)) return base + index;
  throw new Error('Bounded valve naming exhausted');
}
