import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, codeOf, FileFailure, type AtomicHooks } from './atomic-file.cjs';

const attempts = 10_000;
function numbered(proposed: string, index: number, kind: 'file' | 'directory'): string {
  if (index === 0) return proposed;
  const extension = kind === 'file' ? path.extname(proposed) : '';
  return proposed.slice(0, proposed.length - extension.length) + index + extension;
}
async function occupied(file: string): Promise<boolean> {
  try {
    await lstat(file); // Any object reserves a name, including a directory or link.
    return true;
  } catch (cause) {
    if (codeOf(cause) === 'ENOENT') return false;
    throw cause;
  }
}
function ensureCurrent(current: () => boolean): void {
  if (!current()) throw new FileFailure('RESPONSE_STALE', '工程会话已改变，未创建新产物。');
}
/** Exclusive atomic publication; existing files/directories are never replacement targets. */
export async function writeNewOutput(
  proposed: string,
  bytes: Uint8Array,
  current: () => boolean,
  hooks: AtomicHooks = {},
  maximum = 2_000_000,
): Promise<string> {
  for (let index = 0; index < attempts; index++) {
    ensureCurrent(current);
    const candidate = numbered(proposed, index, 'file');
    if (await occupied(candidate)) continue;
    try {
      await atomicWrite(candidate, bytes, null, current, hooks, maximum);
      return candidate;
    } catch (cause) {
      const code = codeOf(cause);
      // A competitor may hold the lease or publish after the preliminary check.
      if (
        code === 'EEXIST' ||
        ((code === 'FILE_CONFLICT' || code === 'FILE_KIND_INVALID') && (await occupied(candidate)))
      )
        continue;
      throw cause;
    }
  }
  throw new FileFailure('FILE_NAME_LIMIT', '可用文件编号超过10000次尝试，请更换名称或位置。');
}
/** mkdir is the exclusive claim. Optional sibling extensions also reserve a project name. */
export async function createNewOutputDirectory(
  proposed: string,
  current: () => boolean,
  siblingExtensions: readonly string[] = [],
): Promise<string> {
  for (let index = 0; index < attempts; index++) {
    ensureCurrent(current);
    const candidate = numbered(proposed, index, 'directory');
    let reserved = false;
    for (const extension of siblingExtensions) {
      if (await occupied(candidate + extension)) {
        reserved = true;
        break;
      }
    }
    if (reserved) continue;
    ensureCurrent(current);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (cause) {
      if (codeOf(cause) !== 'EEXIST') throw cause;
    }
  }
  throw new FileFailure('FILE_NAME_LIMIT', '可用目录编号超过10000次尝试，请更换名称或位置。');
}
