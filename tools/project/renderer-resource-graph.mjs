import fs from 'node:fs/promises';
import path from 'node:path';
import { API } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import * as ts from 'typescript/unstable/ast';

/** Check emitted browser imports against the exact protocol allowlist without executing product code. */
export async function checkRendererResourceGraph(
  directory,
  resources,
  entries = ['/index.html', '/network.html', '/probe.html'],
) {
  const origin = 'hydapp://workbench';
  const queue = entries.map((url) => ({ url, importer: '<entry>' }));
  // Use the same pinned TypeScript 7 parser API as the existing source/payload audits.
  const scripts = {};
  const virtualName = (url) => path.resolve(directory, '__resource_graph_ast__', url.slice(1)).replaceAll('\\', '/');
  for (const [url, mime] of resources) {
    if (!mime.startsWith('text/javascript')) continue;
    try {
      scripts[virtualName(url)] = await fs.readFile(path.join(directory, url.slice(1)), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const config = virtualName('/tsconfig.json');
  const names = Object.keys(scripts);
  scripts[config] = JSON.stringify({
    compilerOptions: { allowJs: true, noEmit: true, noLib: true, types: [] },
    files: names,
  });
  const api = new API({ cwd: path.resolve(directory), fs: createVirtualFileSystem(scripts) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config], openFiles: names });
    const seen = new Set(),
      issues = [];
    let checkedModules = 0;
    function dependency(importer, specifier, documentRelative = false) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        issues.push(`${importer}: unsupported browser dependency ${specifier}`);
        return;
      }
      const url = new URL(specifier, origin + (documentRelative ? '/' : importer));
      if (
        url.protocol !== 'hydapp:' ||
        url.host !== 'workbench' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        issues.push(`${importer}: unsupported local resource URL ${specifier}`);
        return;
      }
      queue.push({ url: url.pathname, importer });
    }
    for (let index = 0; index < queue.length; index++) {
      const { url, importer } = queue[index];
      if (!resources.has(url)) {
        issues.push(`${importer} -> ${url}: missing protocol allowlist entry`);
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      let text;
      try {
        text = await fs.readFile(path.join(directory, url.slice(1)), 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        issues.push(`${importer} -> ${url}: missing emitted resource`);
        continue;
      }
      if (resources.get(url).startsWith('text/html')) {
        for (const match of text.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
          if (!match[1].startsWith('data:')) dependency(url, match[1]);
        }
      } else if (resources.get(url).startsWith('text/javascript')) {
        checkedModules++;
        const name = virtualName(url);
        const source = snapshot.getDefaultProjectForFile(name).program.getSourceFile(name);
        if (!source) throw new Error('Cannot parse emitted browser module: ' + url);
        function visit(node) {
          if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
          ) {
            dependency(url, node.moduleSpecifier.text);
          }
          if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
          ) {
            dependency(url, node.arguments[0].text);
          }
          if (
            ts.isNewExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'Worker' &&
            node.arguments?.[0] &&
            ts.isStringLiteral(node.arguments[0])
          ) {
            dependency(url, node.arguments[0].text, true);
          }
          node.forEachChild(visit);
        }
        visit(source);
      }
    }
    return { checkedResources: seen.size, checkedModules, issues: [...new Set(issues)] };
  } finally {
    api.close();
  }
}
