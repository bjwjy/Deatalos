import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root } from './paths.mjs';

/** Windows-only adapter; source/CI on other platforms retains the legacy client. */
export async function buildToolClient() {
  if (process.platform !== 'win32') return;
  const source = path.join(root, 'apps/desktop/native/tool-client');
  const output = path.join(root, 'apps/desktop/dist/agent');
  await mkdir(output, { recursive: true });
  const files = (await readdir(source)).filter((name) => name.endsWith('.cs')).sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(await readFile(path.join(source, file)));
  const input = hash.digest('hex');
  const executable = path.join(output, 'HydraulicTool.exe');
  const manifestFile = path.join(output, 'tool-client-build.json');
  try {
    const previous = JSON.parse(await readFile(manifestFile, 'utf8'));
    const binaryHash = createHash('sha256')
      .update(await readFile(executable))
      .digest('hex');
    if (previous.input === input && previous.sha256 === binaryHash) return;
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
  const compiler = path.join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const result = spawnSync(
    compiler,
    [
      '/nologo',
      '/target:exe',
      '/optimize+',
      '/platform:anycpu',
      '/reference:System.Security.dll',
      '/reference:System.Web.Extensions.dll',
      `/out:${executable}`,
      ...files.map((name) => path.join(source, name)),
    ],
    { cwd: root, windowsHide: true, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Windows tool client compilation failed: ' + result.stdout + result.stderr);
  await writeFile(
    manifestFile,
    JSON.stringify(
      {
        input,
        sha256: createHash('sha256')
          .update(await readFile(executable))
          .digest('hex'),
        framework: '.NET Framework 4.x; Windows current-user DPAPI',
      },
      null,
      2,
    ) + '\n',
  );
}
