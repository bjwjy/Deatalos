import { element, escapeHtml } from './network-dom.mjs';
import {
  defaultPressureBands,
  parsePressureBands,
  pressureLegendFor,
  type PressureBands,
  pressurePalette,
  pressureColors,
  pressureGrades,
  type PressurePalette,
  defaultPressurePalette,
} from './network-pressure.mjs';

const preferenceKey = 'hydraulic-network-pressure-v1';
const paletteKeys: readonly (keyof PressurePalette)[] = [
  'low',
  'elevated',
  'medium',
  'high',
  'negative',
  'unknown',
  'error',
];
export function createNetworkPressureSettings(changed: () => void, notify: (message: string) => void) {
  let applied = defaultPressureBands;
  let draftColors: { -readonly [K in keyof PressurePalette]: string } = { ...pressureColors };
  let customColors = new Set<keyof PressurePalette>();
  const status = (message: string) => {
    element('pressureSettingsStatus').textContent = message;
  };
  function summary(): void {
    let host = element('pressurePanel').querySelector<HTMLElement>('.white-pressure-summary');
    if (!host) {
      host = document.createElement('div');
      host.className = 'white-pressure-summary';
      element('pressureBoundaries').before(host);
    }
    host.innerHTML = [...element('pressureBoundaries').querySelectorAll<HTMLElement>('.pressure-grade-row')]
      .map((row) => {
        const label = row.querySelector('label')?.textContent?.replace('下限 / MPa', '') ?? '';
        const color = row.querySelector<HTMLInputElement>('input[type="color"]')?.value ?? '';
        const value = row.querySelector<HTMLInputElement>('input[type="number"]')?.value;
        return `<div><i style="background:${escapeHtml(color)}"></i><strong>${escapeHtml(label)}</strong><small>${escapeHtml(value === '' || value === undefined ? '待填写' : value + ' MPa 起')}</small></div>`;
      })
      .join('');
  }
  function fields(count: number, values: readonly number[]): void {
    element('pressureBoundaries').innerHTML =
      '<div class="white-pressure-table-head"><span>压力档位</span><span>颜色</span><span>下限 / MPa</span></div>' +
      pressureGrades(count)
        .map((grade, i) => {
          const value =
            i === 0
              ? '0'
              : values[i - 1] === undefined || !Number.isFinite(values[i - 1])
                ? ''
                : escapeHtml(String(values[i - 1]! / 1e6));
          return `<div class="pressure-grade-row"><label for="pressure-lower-${grade.key}">${grade.name}下限 / MPa</label><input data-pressure-color="${grade.key}" type="color" value="${draftColors[grade.key]}" aria-label="${grade.name}颜色"><input id="pressure-lower-${grade.key}" ${i === 0 ? 'readonly aria-readonly="true"' : 'data-pressure-boundary'} type="number" min="0" step="any" value="${value}" aria-label="${grade.name}下限 MPa"></div>`;
        })
        .join('');
    summary();
  }
  function readColors(): void {
    for (const key of paletteKeys) {
      const control = element('pressurePanel').querySelector<HTMLInputElement>(`[data-pressure-color="${key}"]`);
      if (control) draftColors[key] = control.value;
    }
  }
  function showColors(): void {
    for (const control of element('pressurePanel').querySelectorAll<HTMLInputElement>('input[data-pressure-color]')) {
      const entry = Object.entries(draftColors).find(([key]) => key === control.dataset.pressureColor);
      if (entry) control.value = entry[1];
    }
  }
  function showApplied(): void {
    (element('pressureBandCount') as HTMLSelectElement).value = String(applied.boundariesPa.length + 1);
    const source = pressurePalette(applied);
    draftColors = { ...source };
    if (applied.version === 1) {
      const oldKeys: readonly (keyof PressurePalette)[] =
        applied.boundariesPa.length === 1
          ? ['low', 'high']
          : applied.boundariesPa.length === 2
            ? ['low', 'medium', 'high']
            : ['low', 'elevated', 'medium', 'high'];
      for (const [i, grade] of pressureGrades(applied.boundariesPa.length + 1).entries())
        draftColors[grade.key] = source[oldKeys[i]!];
    }
    const defaults = defaultPressurePalette(applied.boundariesPa.length + 1);
    customColors = new Set(
      applied.colors ? paletteKeys : paletteKeys.filter((key) => draftColors[key] !== defaults[key]),
    );
    fields(applied.boundariesPa.length + 1, applied.boundariesPa);
    element('pressureApplied').textContent = pressureLegendFor(applied);
    showColors();
  }
  function apply(candidate: unknown): void {
    const parsed = parsePressureBands(candidate);
    if (!parsed.ok) {
      status(parsed.diagnostics.map((d) => d.message).join('；') + '未应用，保留原分级。');
      return;
    }
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(parsed.value));
    } catch {
      status('本机压力分级保存失败；未应用，保留原分级。');
      return;
    }
    applied = parsed.value;
    showApplied();
    element('pressurePanel').addEventListener('input', summary);
    status('已应用并保存到本机；工程与运行未改变。');
    changed();
    const dialog = element('pressureSettings');
    if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
  }
  function setup(): void {
    const dialog = element('pressureSettings');
    if (!(dialog instanceof HTMLDialogElement)) throw new Error('Pressure settings must be a dialog');
    element('closePressureSettings').addEventListener('click', () => dialog.close());
    try {
      const text = localStorage.getItem(preferenceKey);
      if (text !== null) {
        const raw: unknown = JSON.parse(text),
          parsed = parsePressureBands(raw);
        if (parsed.ok) applied = parsed.value;
        else {
          const message = '本机压力分级损坏，当前使用默认两档；请从视图菜单检查后重新应用。';
          status(message);
          notify(message);
        }
      }
    } catch {
      const message = '本机压力分级读取失败，当前使用默认两档；请从视图菜单检查后重新应用。';
      status(message);
      notify(message);
    }
    showApplied();
    element('pressurePanel').addEventListener('input', (event) => {
      if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'color') return;
      const control = event.target;
      const key = paletteKeys.find((key) => key === control.dataset.pressureColor);
      if (key) customColors.add(key);
    });
    element('pressureBandCount').addEventListener('change', () => {
      readColors();
      const inputs = [
        ...element('pressureBoundaries').querySelectorAll<HTMLInputElement>('input[data-pressure-boundary]'),
      ];
      const values = inputs.map((input) => (input.value.trim() === '' ? NaN : Number(input.value) * 1e6));
      const count = Number((element('pressureBandCount') as HTMLSelectElement).value);
      const defaults = defaultPressurePalette(count);
      for (const key of paletteKeys) if (!customColors.has(key)) draftColors[key] = defaults[key];
      fields(
        count,
        values.map((v) => (Number.isFinite(v) ? v : NaN)),
      );
      status('尚未确认；请填写各档下限，低压档固定为0。');
    });
    element('applyPressureBands').addEventListener('click', () => {
      const inputs = [
        ...element('pressureBoundaries').querySelectorAll<HTMLInputElement>('input[data-pressure-boundary]'),
      ];
      if (inputs.some((input) => input.value.trim() === '')) {
        status('各档下限不能为空；未确认，保留原分级。');
        return;
      }
      readColors();
      apply({
        version: 2,
        boundariesPa: inputs.map((input) => Number(input.value) * 1e6),
        colors: { ...draftColors },
      });
    });
    element('resetPressureBands').addEventListener('click', () => {
      draftColors = { ...defaultPressurePalette(Number((element('pressureBandCount') as HTMLSelectElement).value)) };
      customColors.clear();
      showColors();
      status('已恢复默认颜色；档数与下限保持，点击确认后应用。');
    });
  }
  return {
    setup,
    get bands(): PressureBands {
      return applied;
    },
  };
}
