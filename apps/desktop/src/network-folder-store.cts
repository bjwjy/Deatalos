import { mkdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, boundedRead, digest, FileFailure, fingerprint, type AtomicHooks } from './atomic-file.cjs';
import type { NetworkSaveCapture, NetworkArtifact } from '@hyd/application' with { 'resolution-mode': 'import' };
import type { NetworkFolderEntry } from '@hyd/project-io' with { 'resolution-mode': 'import' };
import { createNewOutputDirectory } from './new-output.cjs';
import { syncNetworkAiSupport } from './network-ai-support.cjs';

export const exportRootName = '导出_Exports';
export const exportCategoryNames = Object.freeze({
  drawings: '原理图_Drawings',
  data: '数据_Data',
  curves: '曲线_Curves',
  calculations: '计算书_Calculations',
  diagnostics: '诊断_Diagnostics',
});

/** Every child is checked; renderer-supplied paths and filesystem links are never followed. */
async function child(root: string, names: readonly string[], create = false): Promise<string> {
  let current = root;
  for (const name of names) {
    if (!name || name === '.' || name === '..' || /[\\/:\0]/.test(name))
      throw new FileFailure('PATH_INVALID', '工程内路径无效。');
    current = path.join(current, name);
    if (create)
      await mkdir(current).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
    const stat = await lstat(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(current)).toLowerCase() !== current.toLowerCase()
    )
      throw new FileFailure('FILE_KIND_INVALID', '工程子目录不能是链接或目录联接。');
  }
  return current;
}
export interface FolderCapture {
  readonly entry: NetworkFolderEntry;
  readonly bytes: Buffer;
  readonly fingerprint: string;
}
export async function readFolder(file: string): Promise<FolderCapture> {
  const { parseNetworkFolderEntry } = await import('@hyd/project-io');
  const before = await fingerprint(file);
  const parsed = parseNetworkFolderEntry(JSON.parse((await boundedRead(file, 16000)).toString('utf8')));
  if (!parsed.ok) throw new FileFailure('FOLDER_INVALID', '工程入口版本或内容无效。');
  const folder = await child(path.dirname(file), ['data', parsed.value.saveId]);
  const reads = await Promise.allSettled([
    boundedRead(path.join(folder, 'project.hydx')),
    boundedRead(path.join(folder, 'AI.md')),
  ]);
  const dataRead = reads[0],
    guideRead = reads[1];
  if (dataRead.status === 'rejected') throw dataRead.reason;
  if (guideRead.status === 'rejected') throw guideRead.reason;
  const bytes = dataRead.value,
    guide = guideRead.value;
  if (digest(bytes) !== parsed.value.documentSha256 || digest(guide) !== parsed.value.guideSha256)
    throw new FileFailure('FILE_CONFLICT', '保存批次的数据或AI说明已变化，未打开工程。');
  if (!before || before !== (await fingerprint(file))) throw new FileFailure('FILE_CONFLICT', '工程入口读取时变化。');
  return { entry: parsed.value, bytes, fingerprint: before };
}
export async function createFolder(
  selected: string,
  current: () => boolean,
  naming: 'unique' | 'exact' = 'unique',
): Promise<string> {
  const proposed = selected.slice(0, -path.extname(selected).length);
  let root: string;
  if (naming === 'exact') {
    if ((await fingerprint(selected)) !== null) throw new FileFailure('FILE_CONFLICT', '已有同名工程文件。');
    if (!current()) throw new FileFailure('RESPONSE_STALE', '新建工程请求已退役。');
    await mkdir(proposed);
    root = proposed;
  } else root = await createNewOutputDirectory(proposed, current, ['.hydproj']);
  await child(root, ['data'], true);
  for (const name of Object.values(exportCategoryNames)) await child(root, [exportRootName, name], true);
  return path.join(root, '工程.hydproj');
}
export async function writeFolder(
  file: string,
  capture: NetworkSaveCapture,
  bytes: Uint8Array,
  expected: string | null,
  current: () => boolean,
  hooks: AtomicHooks,
): Promise<void> {
  const { networkFolderGuide } = await import('@hyd/project-io');
  if (expected !== null) await readFolder(file);
  const support = await syncNetworkAiSupport((names) => child(path.dirname(file), names, true), current);
  try {
    const saveId = randomUUID();
    const data = await child(path.dirname(file), ['data']);
    const snapshot = path.join(data, saveId);
    await mkdir(snapshot);
    const guide = networkFolderGuide(capture.document, capture.revision, saveId, support.path);
    await atomicWrite(path.join(snapshot, 'project.hydx'), bytes, null, current);
    await atomicWrite(path.join(snapshot, 'AI.md'), Buffer.from(guide), null, current);
    const entry: NetworkFolderEntry = {
      format: 'HydraulicProjectFolder',
      version: 1,
      projectId: capture.document.projectId,
      saveId,
      documentSha256: digest(bytes),
      guideSha256: digest(guide),
    };
    await atomicWrite(file, Buffer.from(JSON.stringify(entry, null, 2) + '\n'), expected, current, hooks);
  } catch (cause) {
    await support.rollback();
    throw cause;
  }
}
export async function archiveFolder(
  file: string,
  artifact: NetworkArtifact,
  category: 'drawings' | 'data' | 'curves' | 'calculations' | 'diagnostics',
  expected: string | null,
  current: () => boolean,
  hooks: AtomicHooks,
  encodedBytes?: Uint8Array,
): Promise<string> {
  if (
    (artifact.format === 'pdf' ||
      artifact.format === 'png' ||
      artifact.format === 'jpg' ||
      artifact.format === 'docx' ||
      artifact.format === 'html' ||
      artifact.format === 'hydcurve') &&
    !encodedBytes
  )
    throw new FileFailure('ARTIFACT_ENCODING_REQUIRED', '正式文件必须先完成二进制编码，未归档。');
  const bytes = encodedBytes ?? Buffer.from(artifact.text);
  const { exportLimits } = await import('@hyd/application');
  const saved = await readFolder(file);
  if (saved.fingerprint !== expected)
    throw new FileFailure('FILE_CONFLICT', '工程入口已被外部替换，请重新打开或另存后再归档。');
  const root = path.dirname(file);
  const parent = await child(root, [exportRootName, exportCategoryNames[category]], true);
  // Explicit allow-list; suggestedName is metadata, never an operating-system path.
  const proposed = path.basename(artifact.suggestedName).replace(/[^\p{L}\p{N}_.-]/gu, '_');
  const extension = path.extname(proposed);
  const stem = proposed.slice(0, -extension.length);
  if (extension !== '.' + artifact.format || !stem || stem === '.' || stem === '..' || stem.endsWith('.'))
    throw new FileFailure('PATH_INVALID', '成果名称不能是空名称、目录别名或以点结尾。');
  const directory = await createNewOutputDirectory(path.join(parent, stem), current, [extension]);
  const name = path.basename(directory) + extension;
  const target = path.join(directory, name);
  await atomicWrite(target, bytes, null, current, hooks, exportLimits.bytes);
  const source =
    artifact.format === 'pdf' ||
    artifact.format === 'png' ||
    artifact.format === 'jpg' ||
    artifact.format === 'docx' ||
    artifact.format === 'html' ||
    artifact.format === 'hydcurve' ||
    artifact.format === 'md'
      ? Buffer.from(JSON.stringify({ format: 'HydraulicFormalExportSource', version: 1, artifact }) + '\n')
      : null;
  if (source) await atomicWrite(path.join(directory, 'source.json'), source, null, current, {}, exportLimits.ipcBytes);
  await atomicWrite(
    path.join(directory, 'index.json'),
    Buffer.from(
      JSON.stringify(
        {
          format: 'HydraulicProjectArchive',
          version: 1,
          snapshotId: artifact.snapshotId,
          category,
          file: name,
          sha256: digest(bytes),
          ...(source ? { sourceFile: 'source.json', sourceSha256: digest(source) } : {}),
        },
        null,
        2,
      ),
    ),
    null,
    current,
  );
  return target;
}
