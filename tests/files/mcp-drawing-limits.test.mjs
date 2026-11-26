import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

const output = path.resolve(process.env.HYD_MCP_TEST_OUTPUT ?? 'artifacts/verification/mcp-drawing-limits');
await mkdir(output, { recursive: true });

async function startPeer(t, workspace, env = process.env, extraArgs = []) {
  const entry = env.HYD_TEST_MCP_ENTRY ?? path.resolve('apps/desktop/dist/network-mcp.cjs');
  if (!path.isAbsolute(entry)) throw Error('MCP test entry must be absolute');
  const child = spawn(process.execPath, [entry, '--workspace', workspace, ...extraArgs], {
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  const reader = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    child.stdin.end();
    const [code] = await closed;
    assert.equal(code, 0, stderr);
  });
  let id = 0;
  const send = (body) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...body }) + '\n');
  async function request(method, params) {
    const current = ++id;
    send({ id: current, method, params });
    const line = await reader.next();
    assert.equal(line.done, false, stderr);
    const message = JSON.parse(line.value);
    assert.equal(message.id, current);
    assert.equal(message.error, undefined, JSON.stringify(message));
    return message.result;
  }
  const init = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'mcp-project-smoke', version: '1' },
  });
  assert.equal(init.protocolVersion, '2025-11-25');
  send({ method: 'notifications/initialized' });
  return {
    init,
    request,
    async call(name, args, isError = false) {
      const result = await request('tools/call', { name: 'hydraulic_' + name, arguments: args });
      assert.equal(result.isError, isError, JSON.stringify(result));
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      return isError ? result.structuredContent.diagnostics : result.structuredContent.value;
    },
  };
}

test('MCP command limits match discovery and atomic saved-project creation', async (t) => {
  const { sizedDrawing } = await import('../fixtures/E1.2S03/four-branch-drawing.mjs');
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const workspace = await mkdtemp(path.join(output, 'drawing-boundaries-'));
  const peer = await startPeer(t, workspace, {
    ...process.env,
    HYD_TOOLS_REGISTRY_DIR: path.join(workspace, 'registry'),
  });
  const { tools } = await peer.request('tools/list', {});
  const ajv = new Ajv2020({ strict: false });
  const validator = (name) => ajv.compile(tools.find((t) => t.name === 'hydraulic_' + name).inputSchema);
  const create = validator('create_project'),
    preview = validator('live_preview');
  const base = { documentSessionId: 'limit-check', revision: 0, physicsRevision: 0, runtimeIdentity: null };
  for (const count of [30, 31, 120, 121]) {
    const commands = sizedDrawing(count),
      project = '边界-' + count;
    assert.equal(create({ project, commands }), count <= 120);
    assert.equal(preview({ project, input: { operation: 'edit', base, commands } }), count <= 120);
    const result = await peer.call('create_project', { project, commands }, count > 120);
    if (count <= 120) assert.ok(result.entryPath);
    else {
      assert.equal(result[0].code, 'RESOURCE_LIMIT');
      assert.ok(!(await readdir(workspace)).includes(project));
    }
  }
  const commands = sizedDrawing(120);
  commands[75] = { kind: 'move', id: 'absent', x: 0, y: 0 };
  const project = '无效批次';
  const result = await peer.call('create_project', { project, commands }, true);
  assert.equal(result[0].code, 'TOOL_COMMAND_INVALID');
  assert.ok(!(await readdir(workspace)).includes(project));
});
