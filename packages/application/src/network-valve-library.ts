import {
  checkJson,
  ContractReader,
  diagnostic,
  parseNetworkComponent,
  networkValvePositions,
  type NetworkComponent,
  type NetworkProject,
  type ValvePositionId,
  type Result,
  uniqueValveName,
  directionalValveBaseName,
} from '@hyd/domain';

export interface NetworkValvePreset {
  readonly id: string;
  readonly name: string;
  readonly component: NetworkComponent;
  readonly initialPosition: ValvePositionId;
}
export interface NetworkValveLibrary {
  readonly format: 'HydraulicWorkbenchValveLibrary';
  readonly version: 1;
  readonly entries: readonly NetworkValvePreset[];
}
export const emptyNetworkValveLibrary: NetworkValveLibrary = Object.freeze({
  format: 'HydraulicWorkbenchValveLibrary',
  version: 1,
  entries: Object.freeze([]),
});
export function parseNetworkValveLibrary(input: unknown): Result<NetworkValveLibrary> {
  const bounded = checkJson(input);
  if (!bounded.ok) return bounded;
  const r = new ContractReader(),
    raw = r.object(input, '/valveLibrary', ['format', 'version', 'entries']);
  r.constant(raw.format, 'HydraulicWorkbenchValveLibrary', '/valveLibrary/format');
  r.constant(raw.version, 1, '/valveLibrary/version');
  const items = r.array(raw.entries, '/valveLibrary/entries', 64);
  const entries: NetworkValvePreset[] = [];
  for (const [i, item] of items.entries()) {
    const field = '/valveLibrary/entries/' + i;
    const value = r.object(item, field, ['id', 'name', 'component', 'initialPosition']);
    const id = r.id(value.id, field + '/id'),
      name = r.text(value.name, field + '/name', 1, 60);
    const parsed = parseNetworkComponent(value.component);
    if (!parsed.ok) {
      r.diagnostics.push(...parsed.diagnostics);
      continue;
    }
    if (parsed.value.typeId !== 'valve') {
      r.fail('VALVE_PRESET_INVALID', field, '收藏内容必须为换向阀。');
      continue;
    }
    const initialPosition = value.initialPosition;
    if (
      (initialPosition !== 'extend' && initialPosition !== 'neutral' && initialPosition !== 'retract') ||
      !networkValvePositions(parsed.value).includes(initialPosition)
    ) {
      r.fail('VALVE_PRESET_INVALID', field, '收藏的初始阀位无效。');
      continue;
    }
    if (!name.trim() || entries.some((entry) => entry.id === id || entry.name === name))
      r.fail('VALVE_PRESET_INVALID', field, '收藏名称不能为空或重复，标识不能重复。');
    entries.push({ id, name, component: parsed.value, initialPosition });
  }
  return r.finish({ format: 'HydraulicWorkbenchValveLibrary', version: 1, entries });
}
export function captureNetworkValvePreset(
  project: NetworkProject,
  componentId: string,
  id: string,
  name: string,
): Result<NetworkValvePreset> {
  const component = project.design.components.find((item) => item.id === componentId);
  const initial = project.design.initialConditions.find((item) => item.componentId === componentId);
  if (!component || initial?.kind !== 'valve')
    return { ok: false, diagnostics: [diagnostic('VALVE_PRESET_INVALID', '/valveLibrary', '所选换向阀已不存在。')] };
  const parsed = parseNetworkValveLibrary({
    ...emptyNetworkValveLibrary,
    entries: [
      { id, name: directionalValveBaseName(component, name.trim()), component, initialPosition: initial.positionId },
    ],
  });
  if (!parsed.ok) return parsed;
  const entry = parsed.value.entries[0];
  if (!entry) throw new Error('Parsed valve preset missing');
  return { ok: true, value: entry };
}
/** Repeated configurations get a distinct numbered name; nothing is overwritten. */
export function putNetworkValvePreset(
  library: NetworkValveLibrary,
  entry: NetworkValvePreset,
): Result<NetworkValveLibrary> {
  const name = uniqueValveName(
    entry.name,
    library.entries.map((item) => item.name),
  );
  return parseNetworkValveLibrary({
    ...library,
    entries: [...library.entries, { ...entry, name }],
  });
}
export function removeNetworkValvePreset(library: NetworkValveLibrary, id: string): Result<NetworkValveLibrary> {
  if (!library.entries.some((item) => item.id === id))
    return { ok: false, diagnostics: [diagnostic('VALVE_PRESET_MISSING', '/valveLibrary', '该收藏已经不存在。')] };
  return parseNetworkValveLibrary({ ...library, entries: library.entries.filter((item) => item.id !== id) });
}
