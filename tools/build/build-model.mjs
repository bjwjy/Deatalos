import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './paths.mjs';

for (const name of [
  'packages/domain',
  'packages/project-io',
  'packages/engine',
  'packages/engineering',
  'packages/application',
  'apps/workbench',
]) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', `${name}/tsconfig.json`],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const { projectSchema, networkProjectSchema } = await import('@hyd/project-io');
await mkdir(path.join(root, 'packages/project-io/schema'), { recursive: true });
await writeFile(
  path.join(root, 'packages/project-io/schema/project-v2.schema.json'),
  JSON.stringify(projectSchema(), null, 2) + '\n',
);
await writeFile(
  path.join(root, 'packages/project-io/schema/project-v3.schema.json'),
  JSON.stringify(networkProjectSchema(), null, 2) + '\n',
);
