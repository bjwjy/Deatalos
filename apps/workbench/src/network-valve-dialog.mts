import {
  directionalFunctionOptions,
  type DirectionalValveSettings,
  type DirectionalValveSpec,
  type ValveEndActuation,
} from '@hyd/domain';
import { escapeHtml as esc } from './network-dom.mjs';
import { directionalFunctionPictogram } from './network-valve-symbols.mjs';
const slotName = (slot: string) => (slot === 'extend' ? '左位' : slot === 'retract' ? '右位' : '中位');
function driveMarkup(side: 'left' | 'right', value: ValveEndActuation): string {
  const select = (field: string, title: string, options: readonly (readonly [string, string])[], current: string) =>
    `<label>${title}<select data-valve-drive="${side}.${field}">${options.map(([id, label]) => `<option value="${id}" ${id === current ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
  return `<fieldset><legend>${side === 'left' ? '左端' : '右端'}驱动</legend><div class="valve-drive-checks"><label><input type="checkbox" data-valve-drive="${side}.springReturn" ${value.springReturn ? 'checked' : ''}>弹簧复位</label><label><input type="checkbox" data-valve-drive="${side}.pilotStage" ${value.pilotStage ? 'checked' : ''}>先导式</label></div>${select(
    'manual',
    '手控',
    [
      ['none', '无'],
      ['button', '按钮'],
      ['lever', '手柄'],
      ['pedal', '脚踏'],
    ],
    value.manual,
  )}${select(
    'mechanical',
    '机控',
    [
      ['none', '无'],
      ['plunger', '顶杆'],
      ['roller', '滚轮'],
    ],
    value.mechanical,
  )}${select(
    'fluid',
    '液控/电控',
    [
      ['none', '无'],
      ['hydraulic', '液控'],
      ['solenoid', '电磁'],
    ],
    value.fluid,
  )}</fieldset>`;
}
export function valveDriveMarkup(settings: DirectionalValveSettings): string {
  return `<div class="valve-end-controls">${driveMarkup('left', settings.valveActuation.left)}${driveMarkup('right', settings.valveActuation.right)}</div>`;
}

export function valveDialogMarkup(settings: DirectionalValveSettings, advanced: string, adding: boolean): string {
  return `<header class="dialog-head"><h2 id="valveSettingsTitle">换向阀</h2><button id="valveSettingsClose" type="button" aria-label="关闭换向阀设置">×</button></header><div class="dialog-body"><div class="valve-config-layout"><section><h3>通数</h3><div class="valve-structure-buttons" id="valveWayButtons">${[2, 3, 4, 5].map((n) => `<button type="button" data-way="${n}">${directionalFunctionPictogram(n, 0)}<span>${['', '', '二', '三', '四', '五'][n]}通</span></button>`).join('')}</div><select hidden id="valvePortCount">${[2, 3, 4, 5].map((n) => `<option value="${n}">${n}通</option>`).join('')}</select><h3>位数</h3><div class="valve-structure-buttons" id="valvePositionButtons">${[2, 3].map((n) => `<button type="button" data-positions="${n}"><span class="valve-slot-blocks">${'<i></i>'.repeat(n)}</span><span>${n === 2 ? '二' : '三'}位</span></button>`).join('')}</div><select hidden id="valvePositionCount"><option value="2">二位</option><option value="3">三位</option></select><label>名称<input id="valveSettingsName" maxlength="60" value="${esc(settings.label)}"></label><details><summary>模型参数</summary><div class="valve-settings-grid"><label>等效两口开口面积 m²<input id="valveSettingsArea" type="number" step="any" value="${settings.maximumAreaM2}"></label><label>流量系数<input id="valveSettingsCoefficient" type="number" step="any" value="${settings.flowCoefficient}"></label>${advanced}</div></details></section><section class="valve-preview-column"><h3>符号预览</h3><div id="valveSettingsPreview"></div><div id="valveSettingsFunctions"></div><label>常态位置<select id="valveSettingsInitial"></select></label>${valveDriveMarkup(settings)}</section></div><p id="valveSettingsStatus" role="status"></p></div><div class="dialog-actions"><div><button id="valveSettingsFavorite" class="primary" type="button">收藏</button><button id="valveSettingsCancel" type="button">取消</button><button id="valveSettingsApply" class="primary" type="button">${adding ? '添加到画布' : '应用'}</button></div></div>`;
}
export function syncValveFunctionPickers(dialog: HTMLElement, ports: number): void {
  for (const select of dialog.querySelectorAll<HTMLSelectElement>('[data-valve-function]')) {
    const slot = select.dataset.valveFunction,
      code = Number(select.value),
      fn = directionalFunctionOptions(ports).find((item) => item.code === code);
    const trigger = dialog.querySelector<HTMLButtonElement>(`[data-function-trigger="${slot}"]`);
    if (trigger && fn) {
      trigger.innerHTML = directionalFunctionPictogram(ports, code) + '<span aria-hidden="true">▾</span>';
      trigger.setAttribute('aria-label', slotName(slot ?? '') + '机能：' + fn.label + '；点击选择');
    }
    for (const option of dialog.querySelectorAll(`[data-choice-slot="${slot}"]`))
      option.setAttribute('aria-selected', String(option.getAttribute('data-choice-code') === select.value));
  }
}
/** Native top-layer popovers stay above the scrolling dialog body. */
export function mountValveFunctionPickers(
  container: HTMLElement,
  spec: DirectionalValveSpec,
  changed: () => void,
): void {
  const options = directionalFunctionOptions(spec.ports.length);
  container.innerHTML = spec.slots
    .map(
      (slot, i) =>
        `<div class="valve-function-field"><span>${slotName(slot)}</span><select hidden aria-hidden="true" data-valve-function="${slot}">${options.map((fn) => `<option value="${fn.code}" ${fn.code === spec.defaults[i] ? 'selected' : ''}>${esc(fn.label)}</option>`).join('')}</select><button type="button" class="valve-function-trigger" data-function-trigger="${slot}" aria-expanded="false" aria-haspopup="listbox" aria-controls="valve-menu-${slot}"></button><div id="valve-menu-${slot}" class="valve-function-menu" popover="auto" role="listbox" aria-label="${slotName(slot)}机能">${options.map((fn) => `<button type="button" role="option" aria-label="${esc(fn.label)}" data-choice-slot="${slot}" data-choice-code="${fn.code}">${directionalFunctionPictogram(spec.ports.length, fn.code)}<span>${esc(fn.label)}</span></button>`).join('')}</div></div>`,
    )
    .join('');
  for (const trigger of container.querySelectorAll<HTMLButtonElement>('[data-function-trigger]')) {
    const menu = container.querySelector<HTMLElement>('#' + trigger.getAttribute('aria-controls'));
    if (!menu) throw new Error('Graphical valve menu missing');
    const open = () => {
      if (menu.matches(':popover-open')) {
        menu.hidePopover();
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const placeAbove = below < 340 && above > below;
      const height = Math.min(340, placeAbove ? above : below);
      const width = Math.min(380, window.innerWidth - 16);
      menu.style.width = width + 'px';
      menu.style.maxHeight = height + 'px';
      menu.style.left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8) + 'px';
      menu.style.top = (placeAbove ? rect.top - height - 4 : rect.bottom + 4) + 'px';
      menu.showPopover();
      if (placeAbove) menu.style.top = rect.top - menu.getBoundingClientRect().height - 4 + 'px';
      menu.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    };
    trigger.addEventListener('click', open);
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        open();
      }
    });
    menu.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(menu.matches(':popover-open'))));
    menu.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
    menu.addEventListener('keydown', (event) => {
      const choices = [...menu.querySelectorAll<HTMLButtonElement>('button')],
        index = choices.indexOf(document.activeElement instanceof HTMLButtonElement ? document.activeElement : trigger);
      const next =
        event.key === 'ArrowDown'
          ? index + 1
          : event.key === 'ArrowUp'
            ? index - 1
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? choices.length - 1
                : null;
      if (next !== null) {
        event.preventDefault();
        choices[(next + choices.length) % choices.length]?.focus();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        menu.hidePopover();
        trigger.focus();
      }
    });
  }
  for (const option of container.querySelectorAll<HTMLButtonElement>('[data-choice-code]'))
    option.addEventListener('click', () => {
      const slot = option.dataset.choiceSlot,
        select = container.querySelector<HTMLSelectElement>(`[data-valve-function="${slot}"]`);
      if (!select) return;
      select.value = option.dataset.choiceCode ?? '';
      option.closest<HTMLElement>('[popover]')?.hidePopover();
      changed();
      container.querySelector<HTMLButtonElement>(`[data-function-trigger="${slot}"]`)?.focus();
    });
}
