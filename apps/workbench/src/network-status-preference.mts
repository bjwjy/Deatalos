import { checkJson, ContractReader, immutable, type Result } from '@hyd/domain';
export type StatusPanelId =
  | 'run'
  | 'controls'
  | 'properties'
  | 'results'
  | 'pipe'
  | 'curve'
  | 'history'
  | 'labels'
  | 'route'
  | 'sizing'
  | 'duty'
  | 'layout'
  | 'ai'
  | 'diagnostics'
  | 'pressure'
  | 'step'
  | 'exports';
interface PanelDefinition {
  readonly id: StatusPanelId;
  readonly label: string;
  readonly nodeId: string;
  readonly ownerId?: string;
  readonly calculation?: boolean;
}
export const statusPanelDefinitions: readonly PanelDefinition[] = Object.freeze([
  { id: 'run', label: '运行状态', nodeId: 'runStatusPanel' },
  { id: 'curve', label: '曲线预览', nodeId: 'sidebarCurve' },
  { id: 'properties', label: '元件快捷参数', nodeId: 'shortcutParameters' },
  { id: 'results', label: '运行数据', nodeId: 'shortcutResults' },
  { id: 'controls', label: '手动控制', nodeId: 'instanceControls' },
  { id: 'sizing', label: '基础计算', nodeId: 'shortcutSizing' },
  { id: 'ai', label: 'AI候选', nodeId: 'shortcutAI' },
  { id: 'diagnostics', label: '诊断', nodeId: 'shortcutDiagnostics' },
]);
export interface StatusPreference {
  readonly version: 1;
  readonly visible: readonly StatusPanelId[];
}
export const defaultStatusPreference: StatusPreference = immutable({
  version: 1,
  visible: ['run', 'curve', 'properties'],
});
export const statusPreferenceKey = 'hydraulic-network-status-panels-v1';
export function parseStatusPreference(input: unknown): Result<StatusPreference> {
  const safe = checkJson(input);
  if (!safe.ok) return safe;
  const r = new ContractReader(),
    o = r.object(input, '', ['version', 'visible']);
  r.constant(o.version, 1, '/version');
  const visible: StatusPanelId[] = [];
  const retired = ['pipe', 'history', 'labels', 'route', 'duty', 'layout', 'pressure', 'step', 'exports'];
  const seen = new Set<unknown>();
  for (const [i, raw] of r.array(o.visible, '/visible', statusPanelDefinitions.length + retired.length).entries()) {
    if (seen.has(raw)) r.fail('STATUS_PREFERENCE_INVALID', '/visible/' + i, '状态栏项目不能重复。');
    seen.add(raw);
    // Migrate only explicitly retired cards; their complete functions retain their menu entries.
    if (typeof raw === 'string' && retired.includes(raw)) continue;
    const definition = statusPanelDefinitions.find((item) => item.id === raw);
    if (!definition) {
      r.fail('STATUS_PREFERENCE_INVALID', '/visible/' + i, '未知状态栏项目。');
      continue;
    }
    if (visible.includes(definition.id)) r.fail('STATUS_PREFERENCE_INVALID', '/visible/' + i, '状态栏项目不能重复。');
    visible.push(definition.id);
  }
  return r.finish(immutable({ version: 1, visible }));
}
