import {
  captureNetworkValvePreset,
  emptyNetworkValveLibrary,
  parseNetworkValveLibrary,
  putNetworkValvePreset,
  type NetworkValveLibrary,
  type NetworkValvePreset,
} from '@hyd/application';
import {
  defaultValveActuation,
  diagnostic,
  type NetworkComponent,
  type NetworkProject,
  type Result,
} from '@hyd/domain';

const key = 'hydraulic-workbench-valve-library-v1';
export interface ValveLibrary {
  readonly entries: readonly NetworkValvePreset[];
  find(reference: string): NetworkValvePreset | undefined;
  isSaved(project: NetworkProject, componentId: string): boolean;
  toggle(project: NetworkProject, componentId: string, name: string): Result<'saved' | 'removed'>;
  remove(reference: string): Result<true>;
  subscribe(listener: () => void): void;
}
function configurationKey(component: NetworkComponent, position: NetworkValvePreset['initialPosition']): string {
  const rules = [...(component.parameterRules ?? [])].sort(
    (a, b) => a.group.localeCompare(b.group) || a.key.localeCompare(b.key),
  );
  return JSON.stringify([
    component.definition,
    component.parameters,
    component.valveActuation ?? defaultValveActuation,
    rules,
    position,
  ]);
}
function presetKey(entry: NetworkValvePreset): string {
  return configurationKey(entry.component, entry.initialPosition);
}
/** Browser persistence adapter. Owns only personal presets, never engineering history. */
export function createValveLibrary(notify: (message: string) => void): ValveLibrary {
  let library = emptyNetworkValveLibrary,
    writable = true;
  const listeners: (() => void)[] = [];
  try {
    const text = localStorage.getItem(key);
    if (text) {
      if (text.length > 1048576) throw new Error('Valve library exceeds capacity');
      const parsed = parseNetworkValveLibrary(JSON.parse(text));
      if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join('；'));
      library = parsed.value;
    }
  } catch {
    writable = false;
    notify('常用阀元件库读取失败，原数据已保留；请检查本机存储。');
  }
  function persist(next: NetworkValveLibrary): Result<true> {
    if (!writable)
      return {
        ok: false,
        diagnostics: [
          diagnostic('VALVE_LIBRARY_STORAGE', '/valveLibrary', '常用阀元件库当前无法安全写入，原数据保留。'),
        ],
      };
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      return {
        ok: false,
        diagnostics: [diagnostic('VALVE_LIBRARY_STORAGE', '/valveLibrary', '收藏保存失败，请检查本机存储空间和权限。')],
      };
    }
    library = next;
    for (const listener of listeners) listener();
    return { ok: true, value: true };
  }
  function findConfiguration(project: NetworkProject, componentId: string): NetworkValvePreset | undefined {
    const component = project.design.components.find((item) => item.id === componentId);
    const initial = project.design.initialConditions.find((item) => item.componentId === componentId);
    if (!component || initial?.kind !== 'valve') return undefined;
    const configuration = configurationKey(component, initial.positionId);
    return library.entries.find((item) => presetKey(item) === configuration);
  }
  function removeConfiguration(entry: NetworkValvePreset): Result<true> {
    const configuration = presetKey(entry);
    return persist({ ...library, entries: library.entries.filter((item) => presetKey(item) !== configuration) });
  }
  return {
    get entries() {
      const seen = new Set<string>();
      return library.entries.filter((entry) => {
        const configuration = presetKey(entry);
        if (seen.has(configuration)) return false;
        seen.add(configuration);
        return true;
      });
    },
    find(reference) {
      return library.entries.find((entry) => 'valve-preset:' + entry.id === reference);
    },
    subscribe(listener) {
      listeners.push(listener);
    },
    remove(reference) {
      const entry = library.entries.find((item) => 'valve-preset:' + item.id === reference);
      return entry
        ? removeConfiguration(entry)
        : { ok: false, diagnostics: [diagnostic('VALVE_PRESET_MISSING', '/valveLibrary', '该收藏已经不存在。')] };
    },
    isSaved(project, componentId) {
      return findConfiguration(project, componentId) !== undefined;
    },
    toggle(project, componentId, name) {
      const existing = findConfiguration(project, componentId);
      if (existing) {
        const removed = removeConfiguration(existing);
        return removed.ok ? { ok: true, value: 'removed' } : removed;
      }
      const captured = captureNetworkValvePreset(
        project,
        componentId,
        'preset_' + crypto.randomUUID().replaceAll('-', ''),
        name,
      );
      if (!captured.ok) return captured;
      const next = putNetworkValvePreset(library, captured.value);
      if (!next.ok) return next;
      const saved = persist(next.value);
      return saved.ok ? { ok: true, value: 'saved' } : saved;
    },
  };
}
