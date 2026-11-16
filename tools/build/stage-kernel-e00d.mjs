import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './paths.mjs';
export async function stageKernel(destination = path.join(root, 'apps/desktop/dist/kernel-runtime')) {
  const source = path.join(root, 'artifacts/tool-cache/E00C/headless');
  const manifest = JSON.parse(
    await readFile(path.join(root, 'artifacts/tool-cache/E00C/headless-manifest.json'), 'utf8'),
  );
  const files = [];
  async function copy(from, relative, expected) {
    const bytes = await readFile(from),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    if (expected && sha256 !== expected) throw new Error('Pinned E00C resource drift: ' + relative);
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    // A running desktop may hold a DLL open. Keep the pinned bytes in place
    // when they already match; a different or unreadable target must still fail.
    let same = false;
    try {
      same =
        createHash('sha256')
          .update(await readFile(target))
          .digest('hex') === sha256;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!same) await copyFile(from, target);
    return { path: relative, bytes: bytes.length, sha256 };
  }
  for (const entry of manifest.files) files.push(await copy(path.join(source, entry.path), entry.path, entry.sha256));
  const extension = JSON.parse(
    await readFile(path.join(root, 'artifacts/tool-cache/E04B/native/manifest.json'), 'utf8'),
  );
  for (const entry of extension.sources) {
    const digest = createHash('sha256')
      .update(await readFile(path.join(root, entry.path)))
      .digest('hex');
    if (digest !== entry.sha256) throw new Error('Native sources changed; run tools/build/build-kernel-e04b.ps1');
  }
  // Keep loaded native images immutable. Rebuilding while a desktop is open
  // must never replace its executable/DLL or force that window to exit.
  const nativeDirectory = 'native/' + createHash('sha256').update(JSON.stringify(extension.files)).digest('hex');
  for (const entry of extension.files)
    files.push(
      await copy(
        path.join(root, 'artifacts/tool-cache/E04B/native', entry.path),
        nativeDirectory + '/' + entry.path,
        entry.sha256,
      ),
    );
  const notices = [];
  const licenseSources = [
    ['HopsanCore/dependencies/rapidxml/license.txt', 'RapidXML-license.txt'],
    ['HopsanCore/dependencies/sundials/src/cvode/LICENSE', 'SUNDIALS-LICENSE.txt'],
    ['mingw64/licenses/gcc/COPYING', 'GCC-COPYING.txt'],
    ['mingw64/licenses/gcc/COPYING3', 'GCC-COPYING3.txt'],
    ['mingw64/licenses/gcc/COPYING.RUNTIME', 'GCC-Runtime-Exception.txt'],
    ['mingw64/licenses/winpthreads/COPYING', 'winpthreads-COPYING.txt'],
  ];
  notices.push(await copy(path.join(source, 'licenses/HopsanCore-LICENSE.txt'), 'licenses/HopsanCore-LICENSE.txt'));
  for (const [file, name] of licenseSources)
    notices.push(
      await copy(path.join(root, 'artifacts/tool-cache/E00C/runtime/Hopsan-2.24.4-win64', file), 'licenses/' + name),
    );
  notices.push(await copy(path.join(root, 'apps/desktop/native/MODELS.txt'), 'licenses/E04B-models.txt'));
  await writeFile(
    path.join(destination, 'resources.json'),
    JSON.stringify(
      {
        format: 'HydraulicKernelResources',
        version: 1,
        core: '2.24.4.20260918.1254',
        architecture: 'x64',
        files,
        notices,
        modelSet: extension.modelSet,
        nativeDirectory,
        nativeBuild: extension,
        provenance:
          'Pinned E00C core/default components plus E04B fixed host and local constitutive extension. Sources: apps/desktop/native/. No GUI/compiler/Qt in payload. Development assembly only; distribution review remains F09/G3.',
      },
      null,
      2,
    ),
  );
  return { destination, files, notices };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await stageKernel()));
