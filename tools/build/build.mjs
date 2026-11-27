import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root } from './paths.mjs';
import { checkRendererResourceGraph } from '../project/renderer-resource-graph.mjs';

const modelBuild = spawnSync(process.execPath, [path.join(root, 'tools/build/build-model.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (modelBuild.error) throw modelBuild.error;
if (modelBuild.status !== 0) process.exit(modelBuild.status ?? 1);
const compile = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'apps/desktop/tsconfig.json'],
  { cwd: root, stdio: 'inherit' },
);
if (compile.error) throw compile.error;
if (compile.status !== 0) process.exit(compile.status ?? 1);

const source = path.join(root, 'apps/workbench/src');
const output = path.join(root, 'apps/desktop/dist/renderer');
await mkdir(output, { recursive: true });
const template = await readFile(path.join(source, 'index.template.html'), 'utf8');
const { diagramStyles } = await import('../../apps/workbench/src/diagram.mjs');
const html = template
  .replace("script-src 'unsafe-inline'", "script-src 'self'")
  .replace("base-uri 'none'", "base-uri 'none'; object-src 'none'; form-action 'none'")
  .replace('__STYLES__', () => '');
const styles = await readFile(path.join(source, 'styles.css'), 'utf8');
const scripts = ['parameter-specs.js', 'friction.js', 'engine.js', 'app.js'];
await writeFile(
  path.join(output, 'index.html'),
  html
    .replace('<style></style>', () => `<style>${styles}</style><style id="diagram-styles">${diagramStyles}</style>`)
    .replace(
      '<script>__SCRIPTS__</script>',
      scripts.map((file) => `<script ${file === 'app.js' ? 'type="module" ' : ''}src="./${file}"></script>`).join('\n'),
    ),
);
for (const file of scripts.filter((file) => file !== 'parameter-specs.js'))
  await copyFile(path.join(source, file), path.join(output, file));
const { legacyParameterView } = await import('@hyd/domain');
await writeFile(
  path.join(output, 'parameter-specs.js'),
  `(function(){'use strict';const view=${JSON.stringify(legacyParameterView())};function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}}freeze(view);Object.defineProperty(window,'HydParameterSpecs',{value:view});})();\n`,
);
// ESM modules keep package public imports explicit, rewritten only at browser composition.
const { readdir } = await import('node:fs/promises');
const packageNames = ['domain', 'project-io', 'engine', 'engineering', 'application'];
// Main uses the same public ESM packages without runtime node_modules dependencies.
const hostModules = path.join(root, 'apps/desktop/dist/model');
await mkdir(hostModules, { recursive: true });
await writeFile(path.join(hostModules, 'package.json'), '{"type":"module"}\n');
for (const name of packageNames) {
  const destination = path.join(output, 'modules', name);
  await mkdir(destination, { recursive: true });
  for (const file of await readdir(path.join(root, 'packages', name, 'dist'))) {
    if (!file.endsWith('.js')) continue;
    const code = (await readFile(path.join(root, 'packages', name, 'dist', file), 'utf8')).replace(
      /(['"])@hyd\/([^'"]+)\1/g,
      (_match, quote, target) => {
        if (!packageNames.includes(target)) throw new Error(`Unexpected browser dependency: ${target}`);
        return `${quote}../${target}/index.js${quote}`;
      },
    );
    await writeFile(path.join(destination, file), code);
    await mkdir(path.join(hostModules, name), { recursive: true });
    await writeFile(path.join(hostModules, name, file), code);
  }
}
for (const file of await readdir(path.join(root, 'apps/desktop/dist'))) {
  if (!file.endsWith('.cjs')) continue;
  const hostFile = path.join(root, 'apps/desktop/dist', file);
  await writeFile(
    hostFile,
    (await readFile(hostFile, 'utf8')).replace(
      /(['"])@hyd\/([^'"]+)\1/g,
      (_match, quote, name) => `${quote}./model/${name}/index.js${quote}`,
    ),
  );
}
// Published workbench modules are copied from the same explicit registry used by the protocol.
const { rendererResources } = await import('../../apps/desktop/dist/renderer-resources.cjs');
const workbenchModules = [...rendererResources().keys()]
  .filter((url) => /^\/[^/]+\.mjs$/.test(url) && url !== '/diagram.mjs')
  .map((url) => url.slice(1));
for (const file of workbenchModules) {
  const code = (await readFile(path.join(root, 'apps/workbench/dist', file), 'utf8')).replace(
    /(['"])@hyd\/([^'"]+)\1/g,
    (_match, quote, target) => {
      if (!packageNames.includes(target)) throw new Error(`Unexpected bridge dependency: ${target}`);
      return `${quote}./modules/${target}/index.js${quote}`;
    },
  );
  await writeFile(path.join(output, file), code);
}
for (const css of [
  'network-workspace.css',
  'network-buttons.css',
  'network-v13-main.css',
  'network-v13-planet.css',
  'network-v13-top.css',
  'network-v13-press.css',
  'network-v13-run.css',
  'network-v13-save.css',
  'network-v13-dialogs.css',
  'network-teaching-demo.css',
  'network-v13-compat.css',
  'network-v13-shortcuts.css',
])
  await copyFile(path.join(source, css), path.join(output, css));
let networkTemplate = await readFile(path.join(source, 'network.template.html'), 'utf8');
// Inline the pre-rendered glass materials under the workbench's data-only image policy.
for (const theme of ['silver', 'oat', 'coral']) {
  const material = await readFile(path.join(source, 'materials', 'glass-' + theme + '.webp'));
  networkTemplate = networkTemplate.replace(
    '__GLASS_' + theme.toUpperCase() + '__',
    'data:image/webp;base64,' + material.toString('base64'),
  );
}
const brandIcon = await readFile(path.join(root, 'apps/desktop/resources/icons/deatalos.png'));
await writeFile(
  path.join(output, 'network.html'),
  networkTemplate.replace('__DEATALOS_ICON__', () => `data:image/png;base64,${brandIcon.toString('base64')}`),
);
const { parseProject, createDraft } = await import('@hyd/project-io');
const examples = {};
for (const [key, file] of [
  ['cylinder', 'cylinder'],
  ['motor', 'motor'],
  ['reference', 'reference-arm'],
]) {
  const parsed = parseProject(
    await readFile(path.join(root, 'HydraulicWorkbench_v1.0/examples', `${file}.json`), 'utf8'),
    { projectId: `example-${file}`, timestamp: '2026-10-16T00:00:00.000Z', appVersion: '0.4.0' },
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  examples[key] = parsed.value.document;
}
const blank = createDraft({ projectId: 'example-blank', timestamp: '2026-10-16T00:00:00.000Z', appVersion: '0.4.0' });
if (!blank.ok) throw new Error(JSON.stringify(blank.diagnostics));
examples.blank = blank.value;
await writeFile(path.join(output, 'examples.js'), `export const examples = ${JSON.stringify(examples)};\n`);
await copyFile(
  path.join(root, 'apps/workbench/third-party/fluids-LICENSE.txt'),
  path.join(output, 'fluids-LICENSE.txt'),
);
await copyFile(path.join(source, 'diagram.mjs'), path.join(root, 'apps/workbench/dist/diagram.mjs'));
await copyFile(path.join(source, 'diagram.mjs'), path.join(output, 'diagram.mjs'));
for (const file of ['probe.html', 'probe.js']) {
  await copyFile(path.join(root, 'apps/desktop/probe', file), path.join(output, file));
}
await mkdir(path.join(root, 'apps/desktop/dist/agent'), { recursive: true });
await (await import('./build-tool-client.mjs')).buildToolClient();
// Retire known generated clients from incremental builds.
for (const name of ['HydraulicTool.exe', 'Invoke-HydraulicTool.ps1'])
  await rm(path.join(root, 'apps/desktop/dist/agent', name), {force:true});
if (!process.argv.includes('--no-native')) await (await import('./stage-kernel-e00d.mjs')).stageKernel();

await mkdir(path.join(root, 'apps/desktop/dist/third-party'), { recursive: true });
await copyFile(
  path.join(root, 'apps/desktop/third-party/pdf-lib-LICENSE.md'),
  path.join(root, 'apps/desktop/dist/third-party/pdf-lib-LICENSE.md'),
);

const { offlineCurveTemplate } = await import('../../apps/workbench/dist/offline-curve-reader.mjs');
await writeFile(path.join(root, 'apps/desktop/dist/offline-curve-template.html'), offlineCurveTemplate());

// Compilation cannot prove the browser can load public re-exports and worker dependencies.
const resourceGraph = await checkRendererResourceGraph(output, rendererResources());
if (resourceGraph.issues.length) throw new Error('Renderer resource graph failed:\n' + resourceGraph.issues.join('\n'));
console.log('Renderer resource graph: ' + JSON.stringify(resourceGraph));
console.log('Built strict desktop host and legacy-compatible renderer.');
