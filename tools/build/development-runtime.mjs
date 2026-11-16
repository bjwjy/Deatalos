import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { root } from './paths.mjs';

const require = createRequire(import.meta.url);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Keep the shared Electron installation untouched; only the advanced source launcher uses this copy. */
export async function advancedDevelopmentExecutable() {
  const original = require('electron');
  if (process.platform !== 'win32') return original;
  const source = path.dirname(original);
  const iconPath = path.join(root, 'apps/desktop/resources/icons/deatalos.ico');
  const electronVersion = JSON.parse(await readFile(require.resolve('electron/package.json'), 'utf8')).version;
  const executableStat = await stat(original);
  const inputs = {
    format: 'DeatalosDevelopmentRuntime-v2',
    electronVersion,
    source,
    executableSize: executableStat.size,
    executableModified: executableStat.mtimeMs,
    iconSha256: hash(await readFile(iconPath)),
  };
  const inputHash = hash(JSON.stringify(inputs));
  const cacheRoot = path.join(root, 'artifacts/runtime/deatalos');
  const destination = path.join(cacheRoot, inputHash.slice(0, 24));
  // Keep the basename: Electron uses it to distinguish source launches from packaged apps.
  const executable = path.join(destination, 'electron.exe');
  const readCached = async () => {
    try {
      const manifest = JSON.parse(await readFile(path.join(destination, 'runtime.json'), 'utf8'));
      if (manifest.inputHash !== inputHash) throw new Error('Development runtime identity mismatch');
      await stat(executable);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  if (await readCached()) return executable;
  await mkdir(cacheRoot, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(cacheRoot, '.prepare-'));
  const staging = path.join(stagingRoot, 'runtime');
  // Stage the complete official runtime, including locales, license and default app.
  await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
  await mkdir(path.join(staging, 'resources/icons'), { recursive: true });
  await copyFile(iconPath, path.join(staging, 'resources/icons/deatalos.ico'));
  const stagedExecutable = path.join(staging, 'electron.exe');
  const { editWindowsResources } = require('app-builder-lib/out/util/resEdit.js');
  await editWindowsResources({
    file: stagedExecutable,
    iconPath,
    fileVersion: electronVersion,
    productVersion: electronVersion,
    versionStrings: { ProductName: 'Deatalos', FileDescription: 'Deatalos development runtime' },
  });
  await writeFile(
    path.join(staging, 'runtime.json'),
    JSON.stringify({ inputHash, inputs, executableSha256: hash(await readFile(stagedExecutable)) }, null, 2) + '\n',
  );
  try {
    await rename(staging, destination);
    await rmdir(stagingRoot);
  } catch (error) {
    // A concurrent launch can finish the same immutable cache first.
    // Retain this isolated staging directory for diagnosis instead of deleting other work.
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !(await readCached())) throw error;
  }
  return executable;
}
