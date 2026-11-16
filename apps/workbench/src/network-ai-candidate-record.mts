import {
  networkToolParameterChanges,
  networkToolParameterRows,
  planNetworkToolCommands,
  type NetworkToolCommand,
  type NetworkToolProposal,
} from '@hyd/application';
import type { NetworkProject } from '@hyd/domain';
import type { CandidateKind, CandidateRecord } from './network-ai-history-store.mjs';

export const candidateLabels = { parameter: '参数修改', layout: '元件调整' } as const;
export function isParameterCommand(command: NetworkToolCommand): boolean {
  return (
    command.kind === 'parameter' ||
    command.kind === 'project-parameter' ||
    command.kind === 'initial-parameter' ||
    command.kind === 'pipe-parameter'
  );
}
function isReusable(command: NetworkToolCommand): boolean {
  return (
    isParameterCommand(command) || command.kind === 'move' || command.kind === 'route' || command.kind === 'arrange'
  );
}

/** Remember target contracts, so a recycled ID or a changed definition cannot reinterpret a saved number. */
function targets(document: NetworkProject, commands: readonly NetworkToolCommand[]): string {
  const design = document.design;
  const rows = networkToolParameterRows(document);
  const component = (id: string) => design.components.find((item) => item.id === id)?.definition ?? null;
  const connection = (id: string) => {
    const item = design.connections.find((value) => value.id === id);
    return item ? [item.from, item.to, item.kind === 'pipe' ? item.model : item.kind] : null;
  };
  return JSON.stringify(
    commands.map((command) => {
      switch (command.kind) {
        case 'parameter':
        case 'initial-parameter':
        case 'project-parameter':
        case 'pipe-parameter': {
          const target =
            command.kind === 'parameter'
              ? 'component'
              : command.kind === 'initial-parameter'
                ? 'initial'
                : command.kind === 'pipe-parameter'
                  ? 'pipe'
                  : 'project';
          const row = rows.find(
            (entry) =>
              entry.target === target &&
              entry.id === command.id &&
              entry.key === command.key &&
              (command.kind !== 'parameter' || entry.group === command.group),
          );
          return [row?.unit ?? null, target === 'pipe' ? connection(command.id) : component(command.id)];
        }
        case 'move':
          return component(command.id);
        case 'route':
          return connection(command.route.connectionId);
        case 'arrange': {
          const ids = command.request.kind === 'routing' ? command.request.connectionIds : null;
          return (ids ?? design.connections.map((item) => item.id)).map((id) => [id, connection(id)]);
        }
        default:
          return null;
      }
    }),
  );
}

export function recordCandidate(
  proposal: NetworkToolProposal,
  document: NetworkProject,
  origin: string,
  createdAt: number,
): CandidateRecord {
  const commands = proposal.plan?.commands ?? [];
  const kinds: CandidateKind[] = [];
  if (commands.some(isParameterCommand)) kinds.push('parameter');
  if (!kinds.length || commands.some((command) => !isParameterCommand(command))) kinds.push('layout');
  const label = kinds.length === 2 ? '混合提交' : kinds.map((kind) => candidateLabels[kind]).join('');
  const parameters = proposal.plan ? networkToolParameterChanges(document, proposal.plan.document) : [];
  const title =
    proposal.operation === 'undo'
      ? '撤销建议'
      : proposal.operation === 'redo'
        ? '重做建议'
        : parameters[0] && kinds.length === 1
          ? label + ' · ' + parameters[0].object
          : label;
  const details = parameters.map(
    (row) => `${row.object} / ${row.label}   ${row.before ?? '未设置'} → ${row.after ?? '未设置'} ${row.unit}`,
  );
  if (kinds.includes('layout')) {
    const commandsText = commands.filter((command) => !isParameterCommand(command));
    if (commandsText.length) details.push(JSON.stringify(commandsText, null, 2));
    else details.push(...proposal.changes.map(({ section, id }) => section + ' · ' + id));
  }
  if (!details.length) details.push(...proposal.changes.map(({ section, id }) => section + ' · ' + id));
  return {
    id: proposal.id,
    kinds,
    title,
    origin,
    createdAt,
    state: 'pending',
    detail: details.join('\n'),
    replay:
      commands.length && commands.every(isReusable)
        ? { commands: JSON.stringify(commands), targets: targets(document, commands) }
        : null,
  };
}

export function candidateReplay(entry: CandidateRecord, document: NetworkProject) {
  if (!entry.replay) return { message: '此记录没有可复用的参数或布局方案。' };
  let commands: unknown;
  try {
    commands = JSON.parse(entry.replay.commands);
  } catch {
    return { message: '收藏数据无法读取。' };
  }
  const planned = planNetworkToolCommands(document, commands);
  if (!planned.ok) return { message: planned.diagnostics.map((item) => item.message).join('；') };
  if (!planned.value.commands.every(isReusable) || targets(document, planned.value.commands) !== entry.replay.targets)
    return { message: '收藏的目标、模型或参数单位已变化，请重新生成方案。' };
  return { commands: planned.value.commands };
}
