import path from 'node:path';

/** File binding owns this identity. No project-authored labels or instructions. */
export interface NetworkToolTarget {
  readonly directory: string;
  readonly projectId: string;
  readonly documentSessionId: string;
}

export function matchesToolTarget(input: unknown, target: NetworkToolTarget | null, connectionId: string): boolean {
  if (!target || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (Object.keys(input).sort().join(',') !== 'connectionId,directory,projectId') return false;
  if (!('directory' in input) || !('projectId' in input) || !('connectionId' in input)) return false;
  return (
    typeof input.directory === 'string' &&
    path.isAbsolute(input.directory) &&
    path.resolve(input.directory).toLowerCase() === path.resolve(target.directory).toLowerCase() &&
    input.projectId === target.projectId &&
    input.connectionId === connectionId
  );
}
