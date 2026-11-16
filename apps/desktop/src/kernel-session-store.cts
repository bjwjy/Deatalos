import { mkdir, mkdtemp, readdir, lstat, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NetworkIdentity } from '@hyd/domain' with { 'resolution-mode': 'import' };
import { atomicWrite, boundedRead, codeOf, fingerprint, type AtomicHooks } from './atomic-file.cjs';
import { NativeFault } from './native-channel.cjs';

const maximumSessions = 32;
const markerBytes = 8192;
const ownedName = /^hyd-[A-Za-z0-9]+$/;
const reservations = new Map<string, Promise<void>>();
export class SessionFault extends NativeFault {
  readonly field = '/kernel/sessions';
  readonly suggestion = '保留工程、历史目录和诊断记录；退出仍在运行的窗口后重试。不要清空会话目录或修改释放标记。';
}
type ReleaseState =
  | { readonly kind: 'released'; readonly fingerprint: string; readonly time: number }
  | { readonly kind: 'protected'; readonly reason: string };
interface CatalogEntry {
  readonly name: string;
  readonly state: ReleaseState;
}
interface CatalogReport {
  readonly format: 'HydraulicSessionCatalog';
  readonly version: 1;
  readonly limit: 32;
  readonly entries: readonly CatalogEntry[];
  readonly reclaimed: readonly string[];
  readonly reclaimFailures: readonly { readonly name: string; readonly reason: string }[];
}
function reasonLabel(reason: string): string {
  if (reason === 'missing-release-marker') return '没有释放标记，可能仍在运行';
  if (reason === 'empty-release-marker') return '释放标记为空';
  if (reason === 'invalid-release-json') return '释放标记JSON损坏或未写完整';
  if (reason === 'unrecognized-release-schema-or-version') return '释放标记格式或版本不支持';
  if (reason === 'release-write-in-progress-or-interrupted') return '释放标记写入尚未完成或曾中断';
  if (reason === 'release-marker-changed' || reason === 'release-proof-changed') return '释放依据发生变化';
  if (reason.startsWith('release-marker-unreadable:')) return '释放标记不能安全读取（' + reason.split(':')[1] + '）';
  return '回收未完成（' + reason + '）';
}
function validRelease(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!('format' in value) || value.format !== 'HydraulicKernelReleased') return false;
  if (!('version' in value) || value.version !== 1) return false;
  if (Object.keys(value).some((key) => !['format', 'version', 'identity', 'failedAcquisition'].includes(key)))
    return false;
  if ('failedAcquisition' in value && (value.failedAcquisition !== true || 'identity' in value)) return false;
  // Legacy v1 markers may contain only format/version. Identity is evidence, never a path or executable.
  if ('identity' in value && value.identity !== null) {
    const identity = value.identity;
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
    if (!('documentSessionId' in identity) || typeof identity.documentSessionId !== 'string') return false;
    if (!('simulationSessionId' in identity) || typeof identity.simulationSessionId !== 'string') return false;
    for (const key of ['physicsRevision', 'tick', 'timeS', 'controlSequence', 'requestSequence']) {
      const item: unknown = Object.getOwnPropertyDescriptor(identity, key)?.value;
      if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) return false;
      if (key !== 'timeS' && !Number.isSafeInteger(item)) return false;
    }
  }
  return true;
}
async function releaseState(directory: string): Promise<ReleaseState> {
  const marker = path.join(directory, 'released.json');
  try {
    try {
      await lstat(marker + '.hyd-lock');
      return { kind: 'protected', reason: 'release-write-in-progress-or-interrupted' };
    } catch (cause) {
      if (codeOf(cause) !== 'ENOENT') throw cause;
    }
    const stamp = await fingerprint(marker, markerBytes);
    if (stamp === null) return { kind: 'protected', reason: 'missing-release-marker' };
    const bytes = await boundedRead(marker, markerBytes);
    if (!bytes.length) return { kind: 'protected', reason: 'empty-release-marker' };
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { kind: 'protected', reason: 'invalid-release-json' };
    }
    if (!validRelease(value)) return { kind: 'protected', reason: 'unrecognized-release-schema-or-version' };
    if ((await fingerprint(marker, markerBytes)) !== stamp)
      return { kind: 'protected', reason: 'release-marker-changed' };
    return { kind: 'released', fingerprint: stamp, time: (await lstat(marker)).mtimeMs };
  } catch (cause) {
    return { kind: 'protected', reason: 'release-marker-unreadable:' + codeOf(cause) };
  }
}
async function ownedDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && ownedName.test(entry.name))
      .map((entry) => entry.name);
  } catch (cause) {
    throw new SessionFault(
      'SESSION_CATALOG_FAILED',
      `历史会话目录扫描失败（${codeOf(cause)}）；本次仿真尚未启动，未清理未知目录。`,
    );
  }
}
async function ownedDirectory(root: string, directory: string): Promise<void> {
  const parent = await realpath(root);
  const resolved = path.resolve(directory);
  const info = await lstat(resolved);
  if (
    path.dirname(resolved) !== path.resolve(root) ||
    !ownedName.test(path.basename(resolved)) ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    path.dirname(await realpath(resolved)) !== parent
  )
    throw new SessionFault('SESSION_PATH_INVALID', '历史会话目录不是所属普通子目录，已保留，未回收。');
}
async function pruneReleased(root: string): Promise<CatalogReport> {
  const names = await ownedDirectories(root);
  const entries: CatalogEntry[] = [];
  const reclaimed: string[] = [];
  const reclaimFailures: { name: string; reason: string }[] = [];
  if (names.length >= maximumSessions) {
    for (const name of names) entries.push({ name, state: await releaseState(path.join(root, name)) });
    const released = entries
      .filter((entry) => entry.state.kind === 'released')
      .sort((a, b) => {
        if (a.state.kind !== 'released' || b.state.kind !== 'released') return 0;
        return a.state.time - b.state.time;
      });
    let remaining = names.length;
    for (const entry of released) {
      if (remaining < maximumSessions) break;
      const directory = path.join(root, entry.name);
      try {
        await ownedDirectory(root, directory);
        const current = await releaseState(directory);
        if (
          current.kind !== 'released' ||
          entry.state.kind !== 'released' ||
          current.fingerprint !== entry.state.fingerprint
        ) {
          reclaimFailures.push({ name: entry.name, reason: 'release-proof-changed' });
          continue;
        }
        // Only a revalidated, ordinary direct child with a recognized completed marker may be removed.
        await rm(directory, { recursive: true, force: false });
        reclaimed.push(entry.name);
        remaining--;
      } catch (cause) {
        reclaimFailures.push({ name: entry.name, reason: codeOf(cause) });
      }
    }
    if (remaining >= maximumSessions) {
      const protectedEntries = entries.filter((entry) => entry.state.kind === 'protected');
      const details = [
        ...protectedEntries.map(
          (entry) =>
            `${entry.name}/released.json：${entry.state.kind === 'protected' ? reasonLabel(entry.state.reason) : ''}`,
        ),
        ...reclaimFailures.map((entry) => `${entry.name}：${reasonLabel(entry.reason)}`),
      ]
        .slice(0, 3)
        .join('；');
      throw new SessionFault(
        'SESSION_LIMIT',
        `会话目录仍有${remaining}份，达到32份安全上限；${protectedEntries.length}份活动或释放状态未知，${reclaimFailures.length}份未能安全回收。本次仿真尚未启动，工程未修改。${details}`,
      );
    }
  }
  return { format: 'HydraulicSessionCatalog', version: 1, limit: 32, entries, reclaimed, reclaimFailures };
}
async function reserve(root: string): Promise<string> {
  try {
    await mkdir(root, { recursive: true });
  } catch (cause) {
    throw new SessionFault('SESSION_CATALOG_FAILED', `会话根目录无法准备（${codeOf(cause)}）；本次仿真尚未启动。`);
  }
  const report = await pruneReleased(root);
  const directory = await mkdtemp(path.join(root, 'hyd-'));
  // Also check other processes. A losing reservation is still empty and has never launched a resource.
  if ((await ownedDirectories(root)).length > maximumSessions) {
    await ownedDirectory(root, directory);
    await rmdir(directory);
    throw new SessionFault(
      'SESSION_LIMIT',
      '另一运行窗口正在占用会话容量；本次空预留已撤回，未启动内核。保留历史并稍后重试。',
    );
  }
  try {
    await writeFile(path.join(directory, 'catalog.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  } catch (cause) {
    throw new SessionFault(
      'SESSION_CATALOG_FAILED',
      `新会话整理记录写入失败（${codeOf(cause)}）；未启动内核，目录已保留。`,
    );
  }
  return directory;
}
/** Serialize capacity decisions within this host; no persistent lock can strand a later startup after a crash. */
export async function reserveKernelSession(root: string): Promise<string> {
  const key = path.resolve(root);
  const previous = reservations.get(key) ?? Promise.resolve();
  const pending = previous
    .then(() => reserve(key))
    .catch((cause: unknown) => {
      if (cause instanceof SessionFault) throw cause;
      throw new SessionFault(
        'SESSION_CATALOG_FAILED',
        `会话容量预留未完成（${codeOf(cause)}）；未能启动新的内核，请保留历史目录和诊断。`,
      );
    });
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  reservations.set(key, settled);
  try {
    return await pending;
  } finally {
    if (reservations.get(key) === settled) reservations.delete(key);
  }
}
/** Called only after confirmed native release (or before native acquisition began). */
export async function writeKernelRelease(
  directory: string,
  evidence: { readonly identity: NetworkIdentity | null } | { readonly failedAcquisition: true },
  hooks: AtomicHooks = {},
): Promise<void> {
  const marker = path.join(directory, 'released.json');
  try {
    await atomicWrite(
      marker,
      Buffer.from(JSON.stringify({ format: 'HydraulicKernelReleased', version: 1, ...evidence })),
      null,
      () => true,
      hooks,
      markerBytes,
    );
  } catch (cause) {
    throw new SessionFault(
      'SESSION_RELEASE_WRITE_FAILED',
      `原生资源已释放，但${path.basename(directory)}/released.json未能完整发布（${codeOf(cause)}）；历史目录已保留，不能认定可以回收。`,
    );
  }
}
