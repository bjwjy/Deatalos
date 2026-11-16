import { lstat, open, realpath, rename, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class FileFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'IO_FAILED';
}
export async function boundedRead(file: string, maximum = 2_000_000): Promise<Buffer> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink())
    throw new FileFailure('FILE_KIND_INVALID', '必须选择普通文件，不能使用符号链接。');
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new FileFailure('FILE_SIZE_LIMIT', '文件超出读取预算。');
    // Stable small entries need only their declared size plus the overflow byte.
    // A file may grow after stat: expand up to the SAME maximum + 1 sentinel,
    // rather than returning a truncated prefix or allocating the full budget.
    let buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    for (;;) {
      if (total === buffer.length) {
        const expanded = Buffer.alloc(Math.min(maximum + 1, Math.max(4096, buffer.length * 2)));
        buffer.copy(expanded, 0, 0, total);
        buffer = expanded;
      }
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum) throw new FileFailure('FILE_SIZE_LIMIT', '文件超出读取预算。');
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}
export const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export async function fingerprint(file: string, maximum = 2_000_000): Promise<string | null> {
  try {
    const bytes = await boundedRead(file, maximum),
      stat = await lstat(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${digest(bytes)}`;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  }
}
export async function targetPath(selected: string): Promise<string> {
  if (!path.isAbsolute(selected) || /[\0\r\n]/.test(selected))
    throw new FileFailure('PATH_INVALID', '请选择有效的绝对路径。');
  const file = path.join(await realpath(path.dirname(selected)), path.basename(selected));
  if (process.platform === 'win32' && path.basename(file).includes(':'))
    throw new FileFailure('PATH_INVALID', '不支持备用数据流。');
  return file;
}
export interface AtomicHooks {
  beforeWrite?(): Promise<void>;
  beforeReplace?(): Promise<void>;
}
/** Same-directory temporary + flush/close + recheck + rename. No delete-before-replace.
 * Hooks are construction-time test dependencies, never exposed by IPC/environment flags. */
export async function atomicWrite(
  file: string,
  bytes: Uint8Array,
  expected: string | null,
  current: () => boolean,
  hooks: AtomicHooks = {},
  maximum = 2_000_000,
): Promise<void> {
  if (bytes.byteLength > maximum) throw new FileFailure('FILE_SIZE_LIMIT', '写入内容超出预算，未修改目标文件。');
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.hyd-tmp`);
  const lock = `${file}.hyd-lock`;
  let ownsTemporary = false,
    ownsLock = false;
  try {
    const lease = await open(lock, 'wx');
    ownsLock = true;
    try {
      await lease.writeFile(`${process.pid}\n`);
    } finally {
      await lease.close();
    }
    if ((await fingerprint(file, maximum)) !== expected)
      throw new FileFailure('FILE_CONFLICT', '文件已被外部修改或移走，请重新打开或另存。');
    if (!current()) throw new FileFailure('RESPONSE_STALE', '工程会话已改变，已停止写入。');
    const handle = await open(temporary, 'wx');
    ownsTemporary = true;
    try {
      await hooks.beforeWrite?.();
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await hooks.beforeReplace?.();
    if (!current()) throw new FileFailure('RESPONSE_STALE', '工程会话已改变，未替换目标。');
    if ((await fingerprint(file, maximum)) !== expected)
      throw new FileFailure('FILE_CONFLICT', '写入期间目标发生外部修改，原文件保留。');
    if (expected === null) {
      // Exclusive link creation prevents overwriting a newly appeared target.
      await link(temporary, file);
      await unlink(temporary);
      ownsTemporary = false;
    } else {
      await rename(temporary, file);
      ownsTemporary = false;
    }
  } finally {
    if (ownsTemporary)
      await unlink(temporary).catch((error) => {
        if (codeOf(error) !== 'ENOENT') console.error('Temporary cleanup failed', codeOf(error), temporary);
      });
    if (ownsLock)
      await unlink(lock).catch((error) => {
        if (codeOf(error) !== 'ENOENT') console.error('Lock cleanup failed', codeOf(error), lock);
      });
  }
}
