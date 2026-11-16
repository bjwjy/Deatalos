import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { API } from 'typescript/unstable/sync';
import * as ast from 'typescript/unstable/ast';

const core = ['domain', 'engine', 'engineering', 'application', 'project-io'];
const dependencies = {
  domain: [],
  engine: ['domain'],
  engineering: ['domain'],
  'project-io': ['domain'],
  application: ['domain', 'engine', 'engineering'],
  workbench: core,
  desktop: core,
};
const roots = [...core.map((name) => `packages/${name}/src`), 'apps/workbench/src', 'apps/desktop/src'];
export async function productSources(directory) {
  const files = [];
  async function walk(relative) {
    let entries;
    try {
      entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    } catch (cause) {
      if (cause.code === 'ENOENT') return;
      throw cause;
    }
    for (const entry of entries) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Source link not supported: ' + file);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) files.push(file);
    }
  }
  for (const root of roots) await walk(root);
  return files.sort();
}
const normalized = (file) => file.replaceAll('\\', '/');
const isInside = (root, file) => file.startsWith(root + '/');
const owner = (file) => file.split('/')[1];
const sourceRoot = (file) => file.split('/').slice(0, 3).join('/');
export async function checkSourceQuality(directory = process.cwd()) {
  directory = path.resolve(directory);
  const files = await productSources(directory),
    issues = [],
    graph = new Map();
  const report = (file, node, rule, detail) =>
    issues.push({
      file,
      line: node ? node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 : 1,
      rule,
      detail,
    });
  const api = new API({ cwd: directory });
  try {
    const absolute = files.map((file) => normalized(path.join(directory, file)));
    const snapshot = api.updateSnapshot({ openFiles: absolute });
    for (let i = 0; i < files.length; i++) {
      const file = files[i],
        role = owner(file),
        boundary = sourceRoot(file),
        pure = core.includes(role),
        edges = [];
      const tree = snapshot.getDefaultProjectForFile(absolute[i]).program.getSourceFile(absolute[i]);
      if (!tree) throw new Error('Cannot parse ' + file);
      const source = await readFile(path.join(directory, file), 'utf8'),
        imports = [];
      function visit(node) {
        if ((ast.isImportDeclaration(node) || ast.isExportDeclaration(node)) && node.moduleSpecifier)
          imports.push({
            node,
            specifier: node.moduleSpecifier.text,
            typeOnly: node.isTypeOnly || node.importClause?.isTypeOnly,
          });
        if (ast.isImportTypeNode(node) && node.argument?.literal)
          imports.push({ node, specifier: node.argument.literal.text, typeOnly: true });
        if (ast.isImportEqualsDeclaration(node) && node.moduleReference?.expression)
          imports.push({ node, specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly });
        if (ast.isCallExpression(node) && ['import', 'require'].includes(node.expression.getText(tree))) {
          const arg = node.arguments[0];
          if (!arg || !ast.isStringLiteral(arg))
            report(file, node, 'dynamic-import', 'Import/require must use a static module specifier');
          else imports.push({ node, specifier: arg.text, typeOnly: false });
        }
        if (ast.isTypeNode(node) && node.getText(tree) === 'any') report(file, node, 'unsafe-type', 'Explicit any');
        if (
          (ast.isAsExpression(node) || ast.isTypeAssertion(node)) &&
          (ast.isAsExpression(node.expression) || ast.isTypeAssertion(node.expression))
        )
          report(file, node, 'unsafe-type', 'Chained assertion');
        if (pure) {
          if (ast.isPropertyAccessExpression(node)) {
            const text = node.getText(tree).replaceAll(/\s/g, '');
            if (
              /^(?:window|process|ipcRenderer|localStorage|indexedDB|performance)\./.test(text) ||
              /^document\.(?:querySelector|createElement|getElementById|addEventListener|body)\b/.test(text) ||
              /^(?:Date\.now|Math\.random|crypto\.randomUUID|globalThis\.(?:fetch|window|process|document))$/.test(text)
            )
              report(file, node, 'core-effect', text);
          }
          if (
            ast.isCallExpression(node) &&
            ['fetch', 'setTimeout', 'setInterval', 'require'].includes(node.expression.getText(tree))
          )
            report(file, node, 'core-effect', 'Platform call');
          if (ast.isNewExpression(node) && node.expression.getText(tree) === 'Date' && !node.arguments?.length)
            report(file, node, 'core-effect', 'Implicit clock');
        }
        node.forEachChild(visit);
      }
      visit(tree);
      for (const match of source.matchAll(/^\s*\/[/\*].*@ts-(?:ignore|nocheck)\b/gm))
        report(file, null, 'type-suppression', match[0].trim());
      for (const { node, specifier, typeOnly } of imports) {
        if (typeof specifier !== 'string') {
          report(file, node, 'import', 'Invalid specifier');
          continue;
        }
        if (specifier.startsWith('@hyd/')) {
          if (!dependencies[role].some((name) => specifier === '@hyd/' + name))
            report(file, node, 'dependency', specifier);
        } else if (specifier.startsWith('.')) {
          // Bounded legacy renderer composition: generated public imports/examples.
          if (
            role === 'workbench' &&
            /^\.\/modules\/(domain|engine|engineering|application|project-io)\/index\.js$/.test(specifier)
          )
            continue;
          if (file === 'apps/workbench/src/app.js' && specifier === './examples.js') continue;
          const resolved = normalized(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
          if (!isInside(boundary, resolved)) {
            report(file, node, 'private-import', specifier);
            continue;
          }
          const candidates = [
            resolved,
            resolved
              .replace(/\.js$/, '.ts')
              .replace(/\.mjs$/, '.mts')
              .replace(/\.cjs$/, '.cts'),
          ];
          const target = candidates.find((candidate) => files.includes(candidate));
          if (!target) report(file, node, 'unresolved-import', specifier);
          else if (!typeOnly) edges.push(target);
        } else if (
          role !== 'desktop' ||
          !(
            specifier === 'electron' ||
            specifier.startsWith('node:') ||
            // S10: PDF page-box encoding is confined to this desktop adapter.
            (file === 'apps/desktop/src/formal-renderer.cts' && specifier === 'pdf-lib')
          )
        )
          report(file, node, 'platform-import', specifier);
      }
      graph.set(file, edges);
    }
  } finally {
    api.close();
  }
  const active = new Set(),
    done = new Set();
  function visit(file, chain = []) {
    if (active.has(file)) {
      issues.push({ file, line: 1, rule: 'cycle', detail: [...chain, file].join(' -> ') });
      return;
    }
    if (done.has(file)) return;
    active.add(file);
    for (const target of graph.get(file) ?? []) visit(target, [...chain, file]);
    active.delete(file);
    done.add(file);
  }
  for (const file of files) visit(file);
  return { files: files.length, issues };
}
