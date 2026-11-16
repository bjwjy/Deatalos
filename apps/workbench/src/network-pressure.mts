import { diagnostic, type NetworkReading, type Result } from '@hyd/domain';

export interface PressureBands {
  readonly version: 1 | 2;
  /** SI Pa transitions: v1 includes the upper bound; v2 includes the next lower bound. Zero is implicit. */
  readonly boundariesPa: readonly number[];
  /** Absent in legacy v1 preferences; use the original palette. */
  readonly colors?: PressurePalette;
}
export const defaultPressureBands: PressureBands = { version: 1, boundariesPa: [2e5] };
export const pressureColors = {
  low: '#246db0',
  elevated: '#07828a',
  medium: '#b87908',
  high: '#c33535',
  negative: '#834aa5',
  unknown: '#7a8792',
  error: '#a52d23',
} as const;
export type PressurePalette = { readonly [K in keyof typeof pressureColors]: string };
export function defaultPressurePalette(count: number): PressurePalette {
  return count === 4 ? { ...pressureColors } : { ...pressureColors, medium: pressureColors.high };
}
export function pressurePalette(bands: PressureBands): PressurePalette {
  return bands.colors ?? (bands.version === 2 ? defaultPressurePalette(bands.boundariesPa.length + 1) : pressureColors);
}
export function pressureGrades(
  count: number,
): readonly { readonly key: keyof PressurePalette; readonly name: string }[] {
  const low = { key: 'low', name: '低压档' } as const;
  const medium = { key: 'elevated', name: '中压档' } as const;
  const high = { key: 'medium', name: '高压档' } as const;
  const ultra = { key: 'high', name: '超高压档' } as const;
  return count === 2 ? [low, high] : count === 3 ? [low, medium, high] : [low, medium, high, ultra];
}
export function parsePressureBands(input: unknown): Result<PressureBands> {
  if (
    !input ||
    typeof input !== 'object' ||
    !('version' in input) ||
    (input.version !== 1 && input.version !== 2) ||
    !('boundariesPa' in input) ||
    !Array.isArray(input.boundariesPa) ||
    Object.keys(input).some((key) => !['version', 'boundariesPa', 'colors'].includes(key))
  )
    return { ok: false, diagnostics: [diagnostic('PRESSURE_BANDS_INVALID', '/pressure', '压力分级格式无效。')] };
  const values: number[] = [];
  for (const value of input.boundariesPa) {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (input.version === 2 ? value <= 0 : value < 0) ||
      (values.length > 0 && value <= values[values.length - 1]!)
    )
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'PRESSURE_BANDS_INVALID',
            '/pressure/boundariesPa',
            input.version === 2
              ? '各档下限必须有限、严格递增，并高于低压档固定下限0。'
              : '分界值必须非负、有限且严格递增；区间不能重叠或倒序。',
          ),
        ],
      };
    values.push(value);
  }
  if (values.length < 1 || values.length > 3)
    return {
      ok: false,
      diagnostics: [diagnostic('PRESSURE_BANDS_INVALID', '/pressure/boundariesPa', '请选择2～4档，填写1～3个分界值。')],
    };
  if ('colors' in input) {
    const raw = input.colors;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalidColors();
    const colors = { ...pressureColors };
    const parsedColors: { -readonly [K in keyof PressurePalette]: string } = colors;
    const keys: readonly (keyof PressurePalette)[] = [
      'low',
      'elevated',
      'medium',
      'high',
      'negative',
      'unknown',
      'error',
    ];
    for (const key of keys) {
      const value: unknown = Reflect.get(raw, key);
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return invalidColors();
      // The fixed key list is owned by the palette; no input key becomes CSS.
      parsedColors[key] = value.toLowerCase();
    }
    if (Object.keys(raw).length !== keys.length) return invalidColors();
    return { ok: true, value: { version: input.version, boundariesPa: values, colors: parsedColors } };
  }
  return { ok: true, value: { version: input.version, boundariesPa: values } };
}
function invalidColors(): Result<PressureBands> {
  return {
    ok: false,
    diagnostics: [
      diagnostic('PRESSURE_COLORS_INVALID', '/pressure/colors', '颜色表必须完整，每项为六位十六进制颜色；未应用。'),
    ],
  };
}
export function pressureBand(
  value: NetworkReading['value'] | undefined,
  bands: PressureBands = defaultPressureBands,
): keyof typeof pressureColors {
  if (value?.kind !== 'known' || !Number.isFinite(value.value)) return 'unknown';
  if (value.value < 0) return 'negative';
  if (bands.version === 2) {
    const index = bands.boundariesPa.findIndex((lower) => value.value < lower);
    return pressureGrades(bands.boundariesPa.length + 1)[index < 0 ? bands.boundariesPa.length : index]!.key;
  }
  const index = bands.boundariesPa.findIndex((upper) => value.value <= upper);
  if (index === -1) return 'high';
  if (index === 0) return 'low';
  return bands.boundariesPa.length === 3 && index === 1 ? 'elevated' : 'medium';
}
export function pressureLegendFor(bands: PressureBands): string {
  if (bands.version === 2) {
    const colors = pressurePalette(bands);
    const ranges = pressureGrades(bands.boundariesPa.length + 1).map((grade, i) => {
      const lower = i === 0 ? 0 : bands.boundariesPa[i - 1]! / 1e6;
      const upper = bands.boundariesPa[i];
      return `${grade.name} ${lower}≤p${upper === undefined ? '' : '<' + upper / 1e6} MPa ${colors[grade.key]}`;
    });
    return `压力端点色（${ranges.length}档）：${ranges.join('；')}。下限归本档，负压 ${colors.negative}、未知 ${colors.unknown}、错误 ${colors.error}。仅示端点，不推测沿程分布；显示分档不改变实际读数，不是额定压力判据。零流量不代表零压力，选中橙色为编辑高亮。`;
  }
  const names =
    bands.boundariesPa.length === 1
      ? ['蓝', '红']
      : bands.boundariesPa.length === 2
        ? ['蓝', '橙', '红']
        : ['蓝', '青', '橙', '红'];
  const palette = pressurePalette(bands);
  const keys: readonly (keyof PressurePalette)[] =
    bands.boundariesPa.length === 1
      ? ['low', 'high']
      : bands.boundariesPa.length === 2
        ? ['low', 'medium', 'high']
        : ['low', 'elevated', 'medium', 'high'];
  const labels = keys.map((key, i) => (palette[key] === pressureColors[key] ? names[i] : palette[key]));
  const ranges = bands.boundariesPa.map(
    (upper, i) =>
      `${i === 0 ? '0' : '>' + bands.boundariesPa[i - 1]! / 1e6}～${upper / 1e6} MPa ${labels[i]}${i === 0 ? '（无压/近零显示档，实际读数不置零）' : ''}`,
  );
  ranges.push(`>${bands.boundariesPa.at(-1)! / 1e6} MPa ${labels.at(-1)}（有压）`);
  return `压力端点色（${names.length}档）：${ranges.join('；')}。上限归本档，负值 ${palette.negative}、未知 ${palette.unknown}。虚线连接彩色端点：两端压力不同，仅示端点，不推测沿程分布。阈值为教学显示，非额定压力判据。箭头只示流向；零流量不代表零压力。橙色选中标记为编辑高亮。`;
}
