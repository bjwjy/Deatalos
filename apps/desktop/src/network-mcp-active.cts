import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { boundedRead, codeOf, FileFailure } from './atomic-file.cjs';
import { callLiveProject, jsonObject, mcpFailure, validProjectName } from './network-mcp-project.cjs';

/** Registry records identify candidates. MCP authenticates each live call and checks the target identity. */
export async function activeProjects(root: string, includeOpen: boolean) {
  const registry =
    process.env.HYD_TOOLS_REGISTRY_DIR ?? path.join(process.env.APPDATA ?? '', 'HydraulicWorkbench', 'mcp-active');
  if (!path.isAbsolute(registry))
    throw new FileFailure('REGISTRY_INVALID', '连接登记目录必须是本机绝对路径，请检查 MCP 登记目录设置。');
  let files: string[];
  try {
    const canonical = await realpath(registry);
    if (canonical.toLowerCase() !== path.resolve(registry).toLowerCase())
      throw new FileFailure('REGISTRY_INVALID', '登记目录是链接，请使用工作台的实际登记目录。');
    files = (await readdir(registry)).filter((file) => file.toLowerCase().endsWith('.json'));
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
    files = [];
  }
  if (files.length > 128)
    throw new FileFailure('REGISTRY_LIMIT', '活动登记超过 128 条，请关闭不用的工作台并检查残留登记。');
  const projects = new Map<
    string,
    {
      project: string;
      directory: string;
      count: number;
      projectId: string;
      connectionId: string;
      discoveryPath: string;
    }
  >();
  for (const file of files) {
    let row: unknown;
    try {
      row = JSON.parse((await boundedRead(path.join(registry, file), 16384)).toString('utf8'));
    } catch (error) {
      if (codeOf(error) === 'ENOENT') continue;
      if (error instanceof SyntaxError)
        throw new FileFailure('REGISTRY_INVALID', '连接登记内容损坏，请在目标工作台重新开启 AI 接入。');
      throw error;
    }
    // An explicitly shared registry can contain records from an older workbench.
    if (jsonObject(row) && row.format === 'HydraulicToolsTarget') continue;
    if (
      !jsonObject(row) ||
      row.format !== 'DeatalosMcpTarget' ||
      row.version !== 1 ||
      typeof row.discoveryPath !== 'string' ||
      !path.isAbsolute(row.discoveryPath) ||
      path.basename(row.discoveryPath) !== 'mcp-connection.json' ||
      typeof row.projectId !== 'string' ||
      typeof row.connectionId !== 'string' ||
      typeof row.directory !== 'string' ||
      !/^[a-z]:[\\/]/i.test(row.directory)
    )
      throw new FileFailure('REGISTRY_INVALID', '连接登记内容无效，请在目标工作台重新开启 AI 接入。');
    const directory = path.resolve(row.directory);
    if (!includeOpen && path.dirname(directory).toLowerCase() !== root.toLowerCase()) continue;
    const project = path.basename(directory);
    if (!validProjectName(project)) continue;
    const key = project.toLowerCase();
    const previous = projects.get(key);
    if (previous) previous.count++;
    else
      projects.set(key, {
        project,
        directory,
        count: 1,
        projectId: row.projectId,
        connectionId: row.connectionId,
        discoveryPath: row.discoveryPath,
      });
  }
  return projects;
}

export async function listActiveProjects(root: string, includeOpen: boolean, args: Record<string, unknown>) {
  const offset = args.offset ?? 0;
  if (
    Object.keys(args).some((key) => key !== 'offset') ||
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    args.offset === null
  )
    return mcpFailure('MCP_ARGUMENT_INVALID', 'offset 须为非负整数。');
  const entries = [...(await activeProjects(root, includeOpen)).values()].sort((a, b) =>
    a.project.localeCompare(b.project),
  );
  const page = entries.slice(offset, offset + 4);
  const projects = await Promise.all(
    page.map(async (target) => {
      const { project, count } = target;
      if (count > 1) return { project, status: 'ambiguous' };
      const reply = await callLiveProject(target, {
        protocol: 'HydraulicTools',
        version: 1,
        requestId: randomUUID(),
        method: 'view_read',
        params: {},
      });
      if (reply.ok === true) return { project, status: 'connected' };
      const issue = Array.isArray(reply.diagnostics) ? reply.diagnostics.find(jsonObject) : undefined;
      return {
        project,
        status: 'unavailable',
        diagnostic:
          issue && typeof issue.code === 'string'
            ? { code: issue.code, message: issue.message, suggestion: issue.suggestion }
            : {
                code: 'LIVE_TOOL_FAILED',
                message: '当前工作台未返回有效诊断。',
                suggestion: '请检查目标工作台的 AI 接入状态。',
              },
      };
    }),
  );
  return {
    ok: true,
    value: {
      projects,
      ...(entries.length === 0 ? { suggestion: '请在目标工程的工作台开启「允许 AI 操作」，再查找工程。' } : {}),
      total: entries.length,
      nextOffset: offset + page.length < entries.length ? offset + page.length : null,
    },
  };
}
