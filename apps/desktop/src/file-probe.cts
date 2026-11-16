import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const probeBytes = Buffer.from('液压辅助软件 F01 文件往返试验\r\n{"probeVersion":1}\r\n', 'utf8');
const maximumBytes = 64 * 1024;

export type ProbeResult =
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly code: string; readonly message: string }
  | {
      readonly status: 'ok';
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
      readonly matchesSample: boolean;
    };

export function failure(code: string, message: string): ProbeResult {
  return { status: 'error', code, message };
}

function ioFailure(error: unknown): ProbeResult {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'IO_ERROR';
  console.error('F01 sample I/O failed:', code);
  return failure(code, code === 'EEXIST' ? '试验不覆盖已有文件，请使用新文件名。' : '样本读写失败，请检查路径和权限。');
}

async function samplePath(directory: string, selected: string): Promise<string | null> {
  // F01 accepts only direct children of a main-process-owned isolated directory.
  // realpath also rejects a selected symlink pointing outside the sample directory.
  const actualRoot = await realpath(directory);
  const absolute = path.resolve(selected);
  if (!path.basename(absolute).endsWith('.hyd-f01.json')) return null;
  const parent = await realpath(path.dirname(absolute));
  if (path.relative(actualRoot, parent) !== '') return null;
  return path.join(parent, path.basename(absolute));
}

function success(file: string, bytes: Buffer): ProbeResult {
  return {
    status: 'ok',
    path: file,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    matchesSample: bytes.equals(probeBytes),
  };
}

export async function saveSample(directory: string, selected: string): Promise<ProbeResult> {
  try {
    await mkdir(directory, { recursive: true });
    const file = await samplePath(directory, selected);
    if (!file) return failure('OUTSIDE_SAMPLE_DIRECTORY', '请选择样本目录内的新 .hyd-f01.json 文件。');
    // Exclusive create prevents this spike from overwriting a project or existing sample.
    const handle = await open(file, 'wx');
    try {
      await handle.writeFile(probeBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return success(file, probeBytes);
  } catch (error: unknown) {
    return ioFailure(error);
  }
}

export async function openSample(directory: string, selected: string): Promise<ProbeResult> {
  try {
    const file = await samplePath(directory, await realpath(selected));
    if (!file) return failure('OUTSIDE_SAMPLE_DIRECTORY', '只能读取样本目录中的 .hyd-f01.json 文件。');
    const handle = await open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maximumBytes)
        return failure('INVALID_SAMPLE_SIZE', '样本必须是最多 64 KiB 的普通文件。');
      // Bounded read remains bounded even if another process grows the file after stat.
      const buffer = Buffer.alloc(maximumBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maximumBytes) return failure('INVALID_SAMPLE_SIZE', '样本超过 64 KiB。');
      return success(file, buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    return ioFailure(error);
  }
}
