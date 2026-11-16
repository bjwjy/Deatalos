import type { DisplayDiagnostic } from '@hyd/domain';
import type { ExportArtifact } from './export-artifact.js';
import { csvCell } from './export-csv.js';

/** Never serializes messages, causes, user labels, paths, HTTP data or environment. */
export function networkDiagnosticArchive(items: readonly DisplayDiagnostic[], snapshotId: string): ExportArtifact {
  const names = new Set([
    'files',
    'export',
    'design',
    'components',
    'connections',
    'nodes',
    'parameters',
    'initialConditions',
    'runtime',
    'simulation',
    'pressure',
    'flow',
    'model',
    'layout',
    'service',
  ]);
  const rows: (string | number)[][] = [
    ['section', 'object_id', 'tick', 'time_s', 'field', 'label', 'unit', 'value', 'reason', 'source'],
    [
      'diagnostics',
      '',
      '',
      '',
      'scope',
      '',
      '',
      '当前会话：最近20次界面诊断及当前运行诊断；最多200项',
      '',
      '本机；不上传',
    ],
    ['diagnostics', '', '', '', 'privacy', '', '', '已省略自由文本、路径、用户标签、控制台、环境和鉴权信息', '', ''],
    ['diagnostics', '', '', '', 'total', '', '', items.length, '', ''],
    ['diagnostics', '', '', '', 'truncated', '', '', String(items.length > 200), '', ''],
  ];
  for (const item of items.slice(-200)) {
    const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(item.code) ? item.code : 'UNCLASSIFIED';
    const field = (item.field ?? '')
      .split('/')
      .slice(0, 12)
      .map((p) => (names.has(p) || /^\d{1,6}$/.test(p) ? p : '<id>'))
      .join('/');
    rows.push(['diagnostic', '', '', '', field, code, '', item.severity ?? 'info', '', '本机应用']);
  }
  return {
    version: 1,
    snapshotId,
    format: 'csv',
    suggestedName: '应用诊断.csv',
    text: '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n',
  };
}
