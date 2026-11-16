import {
  componentDisplayName,
  networkCreationParameters,
  type NetworkComponent,
  type NetworkDefinition,
} from '@hyd/domain';
import { element, escapeHtml } from './network-dom.mjs';
import { libraryExplanation, libraryPictogram } from './network-library-symbols.mjs';
import { networkDefinition } from '@hyd/domain';
import type { NetworkValvePreset } from '@hyd/application';
import type { ValveLibrary } from './network-valve-library.mjs';
import { networkSymbol } from './network-symbols.mjs';
import { pressureGaugePictogram } from './network-controller-symbols.mjs';

export type LibraryMode = 'array' | 'scroll';
const groups = [
  {
    label: '供油与回油',
    types: ['pump', 'tank', 'return-filter', 'pressure-source', 'volume', 'accumulator', 'pressure-intensifier'],
  },
  {
    label: '执行元件',
    types: [
      'cylinder',
      'motor',
      'single-acting-cylinder',
      'cushioned-cylinder',
      'cushioned-double-rod-cylinder',
      'limited-rotary-actuator',
    ],
  },
  { label: '方向控制', types: ['valve', 'check-valve', 'manual-shutoff', 'pilot-check', 'pilot-check-close'] },
  {
    label: '压力控制',
    types: [
      'relief',
      'pressure-reducing',
      'pressure-reducing-relieving',
      'sequence-valve',
      'counterbalance',
      'pilot-unloading-valve',
      'shock-makeup-valve',
    ],
  },
  {
    label: '流量控制',
    types: [
      'throttle',
      'one-way-throttle',
      'pressure-compensated-flow',
      'three-way-flow-control',
      'flow-divider-combiner',
      'synchronizing-flow-divider',
    ],
  },
  { label: '液压逻辑', types: ['shuttle-valve', 'two-pressure-valve'] },
  {
    label: '测量仪表',
    types: ['pressure-gauge', 'flow-meter', 'differential-pressure-gauge', 'adjustable-pressure-switch'],
  },
  { label: '动态控制', types: ['dynamic-controller'] },
];
interface LibraryEntry {
  readonly id: string;
  readonly name: string;
  readonly typeId: string;
  readonly explanation: string;
  readonly pictogram: string;
  readonly favorite: boolean;
}
/** Library presentation hides historical valve variants, not their registered definitions. */
export function componentLibraryEntries(
  definitions: readonly NetworkDefinition[],
  presets: readonly NetworkValvePreset[],
): readonly LibraryEntry[] {
  const system = definitions
    .filter(
      (definition) =>
        definition.evidence !== 'unverified' &&
        (definition.typeId !== 'valve' || definition.id === 'teaching:directional-3-4'),
    )
    .map((definition) => ({
      id: definition.id,
      name: definition.typeId === 'valve' ? '换向阀' : componentDisplayName(definition.typeId, definition.id),
      typeId: definition.typeId,
      explanation: libraryExplanation(definition),
      pictogram: libraryPictogram(definition),
      favorite: false,
    }));
  const pilotPreview = libraryComponentPreview('teaching:pilot-check-internal', definitions, [], 870);
  const pilotGlyph = pilotPreview ? networkSymbol(pilotPreview, [], [], { labels: false, details: false }) : '';
  return [
    ...system,
    {
      id: 'instrument:pressure-gauge',
      name: '压力表',
      typeId: 'pressure-gauge',
      explanation: '独立放置，单测压口接液压油口或节点；各控制器均可引用读数',
      pictogram: pressureGaugePictogram(),
      favorite: false,
    },
    ...(pilotPreview !== null
      ? [
          {
            id: 'assembly:pilot-lock-pair',
            name: '双向液压锁（组合）',
            typeId: 'pilot-check',
            favorite: false,
            explanation: '点击放置两只液控单向阀及可见交叉先导线；四个主通路口需实际接线，不是平衡阀',
            pictogram:
              '<svg viewBox="-150 -60 300 120" aria-hidden="true"><g transform="translate(-65,0)">' +
              pilotGlyph +
              '</g><g transform="translate(65,0)">' +
              pilotGlyph +
              '</g></svg>',
          },
        ]
      : []),
    ...presets.map((entry) => {
      if (!networkDefinition(entry.component.definition.id, entry.component.definition.version))
        throw new Error('Preset definition unavailable');
      return {
        id: 'valve-preset:' + entry.id,
        name: entry.name,
        typeId: 'valve',
        explanation: '收藏的常用阀配置',
        favorite: true,
        pictogram:
          '<svg viewBox="-250 -100 500 200" aria-hidden="true" focusable="false">' +
          networkSymbol(entry.component, [], [], { labels: false, details: false }) +
          '</svg>',
      };
    }),
  ];
}
const nameOf = (entry: LibraryEntry) => entry.name;
/** Transient drawing input only; defaults come from the same public factory as placement. */
export function libraryComponentPreview(
  reference: string,
  definitions: readonly NetworkDefinition[],
  presets: readonly NetworkValvePreset[],
  densityKgPerM3: number,
): NetworkComponent | null {
  const preset = presets.find((entry) => 'valve-preset:' + entry.id === reference);
  if (preset) return preset.component;
  const definition = definitions.find((entry) => entry.id === reference);
  if (!definition) return null;
  return {
    id: 'library-preview',
    typeId: definition.typeId,
    label: '',
    definition: { id: definition.id, version: definition.version },
    model: definition.model,
    parameters: networkCreationParameters(definition, densityKgPerM3),
  };
}
function card(definition: LibraryEntry, attributes: string): string {
  const name = escapeHtml(nameOf(definition));
  const carousel = attributes.includes('data-carousel-item');
  const outer = carousel
    ? attributes.replace('class="cover-card"', 'class="cover-card library-item"')
    : 'class="library-item"';
  return `<div ${outer} ${definition.favorite ? 'data-valve-preset="true"' : ''}><button class="library-select" ${carousel ? '' : attributes} ${definition.id.startsWith('assembly:') ? 'data-library-assembly' : 'data-library-definition'}="${escapeHtml(definition.id)}" title="${name}：${escapeHtml(definition.explanation)}" aria-label="${definition.favorite ? '添加' : definition.typeId === 'valve' ? '配置' : '添加'}${name}">${definition.pictogram}<span class="library-card-name">${name}</span></button>${definition.favorite ? `<button type="button" class="library-favorite-star library-remove" data-remove-preset="${escapeHtml(definition.id)}" aria-label="取消收藏${name}" title="取消收藏">★</button>` : ''}</div>`;
}

/** Selection-only views share one registered inventory and the existing engineering add command. */
export function setupComponentLibrary(
  definitions: readonly NetworkDefinition[],
  initialMode: LibraryMode,
  add: (definitionId: string) => void,
  presets?: ValveLibrary,
): { readonly setMode: (mode: LibraryMode) => void } {
  const input = element('librarySearch');
  if (!(input instanceof HTMLInputElement)) throw new Error('Library search must be an input');
  const search = input;
  const tools = element('componentTools');
  let mode = initialMode;
  let selectedGroup = 0;
  const selections = new Map<number, number>();

  function setupCarousel(body: HTMLElement, found: readonly LibraryEntry[], groupIndex: number): void {
    const viewport = body.querySelector<HTMLElement>('.carousel-viewport');
    if (!viewport || !found.length) throw new Error('Carousel requires a viewport and registered entries');
    let current = Math.min(selections.get(groupIndex) ?? 0, found.length - 1);
    const buttons = [...viewport.querySelectorAll<HTMLElement>('[data-carousel-item]')];
    const dots = [...body.querySelectorAll<HTMLButtonElement>('[data-carousel-dot]')];
    const render = () => {
      const active = found[current];
      if (!active) throw new Error('Carousel selection outside registered entries');
      viewport.dataset.activeDefinition = active.id;
      for (const [index, button] of buttons.entries()) {
        const definition = found[index];
        if (!definition) throw new Error('Carousel entry outside registered inventory');
        let offset = (index - current + found.length) % found.length;
        if (offset > found.length / 2) offset -= found.length;
        const distance = Math.abs(offset);
        button.style.setProperty('--cover-offset', String(offset));
        button.style.setProperty('--cover-scale', String(1 - distance * 0.13));
        button.style.zIndex = String(5 - distance);
        button.style.opacity = distance > 2 ? '0' : String(1 - distance * 0.22);
        button.style.pointerEvents = distance > 2 ? 'none' : 'auto';
        for (const control of button.querySelectorAll<HTMLButtonElement>('button'))
          control.tabIndex = offset === 0 ? 0 : -1;
        button.setAttribute('aria-current', String(offset === 0));
        button.setAttribute('aria-label', (offset === 0 ? '添加' : '切换至') + nameOf(definition));
        button.title =
          nameOf(definition) +
          '：' +
          definition.explanation +
          (offset === 0 ? '；点击添加到画布' : '；点击切换至此元件');
      }
      for (const [index, dot] of dots.entries()) dot.setAttribute('aria-current', String(index === current));
      const status = body.querySelector('[data-carousel-status]');
      if (status) status.textContent = `${nameOf(active)}，${current + 1}/${found.length}`;
      selections.set(groupIndex, current);
    };
    const move = (delta: number) => {
      current = (current + delta + found.length) % found.length;
      render();
    };
    for (const [index, button] of buttons.entries())
      button.addEventListener('click', () => {
        const definition = found[index];
        if (!definition) throw new Error('Carousel entry missing');
        if (index === current) add(definition.id);
        else {
          current = index;
          render();
        }
      });
    for (const [index, dot] of dots.entries())
      dot.addEventListener('click', () => {
        current = index;
        render();
      });
    body.querySelector('[data-carousel-prev]')?.addEventListener('click', () => move(-1));
    body.querySelector('[data-carousel-next]')?.addEventListener('click', () => move(1));
    let wheel = 0,
      lastMove = -Infinity;
    viewport.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (found.length < 2) return;
        const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
        if (!delta || performance.now() - lastMove < 160) return;
        wheel += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
        if (Math.abs(wheel) >= 48) {
          move(Math.sign(wheel));
          wheel = 0;
          lastMove = performance.now();
        }
      },
      { passive: false },
    );
    viewport.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      move(event.key === 'ArrowRight' ? 1 : -1);
      buttons[current]?.querySelector<HTMLButtonElement>('.library-select')?.focus({ preventScroll: true });
    });
    render();
  }

  function render(): void {
    const query = search.value.trim().toLocaleLowerCase();
    const inventory = componentLibraryEntries(definitions, presets?.entries ?? []);
    const entries = groups.map((group, index) => ({
      group,
      index,
      found: inventory
        .filter(
          (definition) =>
            group.types.includes(definition.typeId) &&
            `${nameOf(definition)} ${definition.id} ${group.label}`.toLocaleLowerCase().includes(query),
        )
        .sort(
          (a, b) =>
            Number(a.favorite) - Number(b.favorite) || group.types.indexOf(a.typeId) - group.types.indexOf(b.typeId),
        ),
    }));
    const matching = entries.filter((entry) => entry.found.length);
    if (!matching.some((entry) => entry.index === selectedGroup)) selectedGroup = matching[0]?.index ?? 0;
    element('componentLibrary').dataset.libraryMode = mode;
    tools.innerHTML = matching
      .map(({ group, index, found }) => {
        const content =
          mode === 'array'
            ? `<div class="tools">${found.map((definition) => card(definition, `data-add="${escapeHtml(definition.id)}"`)).join('')}</div>`
            : `<div class="carousel-body" data-carousel-group="${index}"><div class="carousel-viewport" role="group" aria-label="${group.label}；滚轮或左右键切换，点击中央卡片添加">${found.map((definition, i) => card(definition, `class="cover-card" data-carousel-item="${i}"`)).join('')}</div><div class="carousel-navigation"><button data-carousel-prev aria-label="上一个元件" title="上一个元件">‹</button><div class="carousel-dots">${found.map((definition, i) => `<button data-carousel-dot="${i}" aria-label="选择${escapeHtml(nameOf(definition))}" title="${escapeHtml(nameOf(definition))}"></button>`).join('')}</div><button data-carousel-next aria-label="下一个元件" title="下一个元件">›</button></div><span class="sr-only" data-carousel-status role="status" aria-live="polite"></span></div>`;
        return `<details class="library-group" ${mode === 'scroll' ? 'name="carousel-category"' : ''} ${mode === 'array' || index === selectedGroup ? 'open' : ''}><summary class="category-trigger"><span>${escapeHtml(group.label)}</span><span class="category-count">${found.length}</span></summary>${content}</details>`;
      })
      .join('');
    const feedback = element('libraryCount');
    feedback.hidden = matching.length > 0;
    feedback.textContent = matching.length ? '' : '没有匹配元件，请清空搜索重试。';
    for (const button of tools.querySelectorAll<HTMLButtonElement>('[data-add]'))
      button.addEventListener('click', () => {
        if (button.dataset.add) add(button.dataset.add);
      });
    if (mode === 'scroll')
      for (const entry of matching) {
        const body = tools.querySelector<HTMLElement>(`[data-carousel-group="${entry.index}"]`);
        if (!body) throw new Error('Carousel category missing');
        setupCarousel(body, entry.found, entry.index);
        body.closest('details')?.addEventListener('toggle', (event) => {
          if (event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.open)
            selectedGroup = entry.index;
        });
      }
    for (const star of tools.querySelectorAll<HTMLButtonElement>('[data-remove-preset]')) {
      star.addEventListener('pointerdown', (event) => event.stopPropagation());
      star.addEventListener('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
        const result = presets?.remove(star.dataset.removePreset ?? '');
        if (result && !result.ok) {
          feedback.hidden = false;
          feedback.textContent = result.diagnostics.map((item) => item.message).join('；');
        }
      });
    }
  }
  input.addEventListener('input', render);
  presets?.subscribe(render);
  render();
  return {
    setMode(next) {
      mode = next;
      render();
    },
  };
}
