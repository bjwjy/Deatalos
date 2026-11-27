import { createFrameTool, createMcpFrame } from './network-mcp-frame.cjs';
import { activeProjects, listActiveProjects } from './network-mcp-active.cjs';
import { compactToolSchema } from './network-mcp-schema.cjs';
import { McpProjectReceipts } from './network-mcp-receipts.cjs';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { stdin, stdout, stderr } from 'node:process';
import { codeOf, FileFailure } from './atomic-file.cjs';
import {
  callLiveProject,
  createMcpProject,
  existingProjectDirectory,
  jsonObject,
  mcpFailure,
  readMcpProject,
  validProjectName,
} from './network-mcp-project.cjs';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const maximumFrameBytes = 1024 * 1024;
const liveMethods = [
  'view_read',
  'view_navigate',
  'diagnose',
  'diagnostic_locate',
  'settings_read',
  'settings_prepare',
  'settings_status',
  'settings_cancel',
  'capabilities',
  'capture',
  'read',
  'preview',
  'proposal',
  'cancel',
  'simulate',
  'calculate',
  'curve_capture',
  'curve_prepare',
  'cylinder_compare',
  'export_batch_retry',
  'curve_read',
  'file_prepare',
  'export_batch_prepare',
  'file_status',
  'file_cancel',
  'recovery_list',
  'curve_history',
];
const liveDescriptions: Readonly<Record<string, string>> = {
  view_read: '读取画布当前临时视图与工程持久viewport及base，不修改工程。',
  view_navigate:
    '带当前base执行临时fit或明确viewport，只改变相机，不保存、不置脏。持久视图改用preview命令{kind:viewport,centerX,centerY,zoom}，检查布局差异并在工作台确认，可一次撤销；已有手动fit会保存置脏，不能混称只读。',
  diagnose:
    '对当前base执行既有运行前静态映射检查并更新工作台诊断，返回当前批次摘要；不启动仿真，不把静态通过认证为真实运行成功。',
  diagnostic_locate:
    '带当前base、diagnosticSnapshot.currentBatchId和该批rows的rowIndex定位当前诊断。仅临时选择/移动相机，不保存；历史批次拒绝，缺图形目标返回原因。',
  settings_read:
    '只读当前本机设置与允许值，包括连线范围、显示标签、出图默认格式/纸幅、曲线范围、恢复副本、配色和默认导出目录。',
  settings_prepare:
    '按settings_read定义提交changes[{key,value}]并沿operationKey幂等，工作台显示原值→新值后明确确认。只改本机偏好，不改物理或工程dirty；目录仅choose本机选择或project随工程归档，不接受远程路径。降低恢复份数会淘汰旧副本。逐项回执区分applied/persisted，partial保留已应用部分。',
  settings_status: '查询同连接本机设置操作逐项真实回执；partial或persisted:false/null不能说全部持久化成功。',
  settings_cancel: '取消尚未确认的设置变更；应用开始后须核对逐项结果。',
  curve_history:
    '只读列出本机当前工程的至多三份持久曲线历史摘要；将选中的historyId传给curve_capture。不会把旧运行数据标为当前结果。',
  recovery_list:
    '只读列出当前电脑的恢复副本编号、标题、时间和修订；不返回文档或路径。使用 file_prepare 的 kind:project, mode:restore 和 recoveryId 提出恢复，由工作台确认。',
  cylinder_compare:
    '只读回答当前工程两缸的位置、速度及同一步差值，返回绝对差峰值和时间、样本数。仅两个缸时 input:{} 即可；更多缸传 cylinderIds:[左ID,右ID]。可传 fromTick，条件运行区间使用 conditionRun.startTick。差值为左减右，单位 m、m/s；everyTick 为 false 时仅报告采样峰值。',
  export_batch_retry:
    '同连接内补写原三文件归档失败或跳过的项，传 operationId 和本次 retryKey。保留成功文件，重复请求沿用同一编号，用 file_status 查询回执。',
  curve_capture:
    '冻结当前运行采样，或带curve_history返回的historyId明确选择持久历史；返回sourceId、原始运行身份、时间范围、可用量值与截断状态。历史保持原工程/运行身份，不当作当前求解值。最多保留两份来源（含导入），不会推进仿真。',
  curve_prepare:
    '运行/历史sourceId带request规划量值、范围及精简预算；导入sourceId改带curveIndex选择原有冻结曲线，不补造样本。返回curveId、身份/单位及分段数，最多八份计划，CSV每段单独导出。导入来源由file_prepare kind:curve-import在本机确认选取4,000,000字节内文件，file_status完成后给sourceId/曲线摘要，不传文件内容或路径。',
  curve_read: '分页读取 curveId 的真实样本、逐点运行身份、SI 值、显示单位及缺失原因。导出使用相同冻结曲线。',
  file_prepare:
    'kind:curve-import 打开本机确认及文件选择器，受控读取最多4,000,000字节曲线文件；查询file_status的completed/outcome.source取得sourceId及curveIndex，再curve_prepare/curve_read读取，不改工程或运行。' +
    '用户要求导出时，用 destination:project 直接写入当前工程并查询 file_status 回报路径；drawing 为原理图，book 为计算书。工程切换、保存和选择外部位置仍由工作台确认。kind:project 的 mode 为 open/new/import/restore：打开或导入由本机选择文件，新建为空白并本机选新位置，恢复须带 recovery_list 返回的 recoveryId；import/restore 采用未保存副本，须另存。四种切换及 kind:save, mode:as 在切换后旧控制连接退役，均用 hydraulic_project_status 查询；工程切换只有 completed 且 adopted:true 才已采用，awaiting-adoption 不可重试。新工程须重新授权AI/仿真。mode:current原位保存。kind:catalog 使用 catalog 的 calculationId，支持当前设计 docx/md；kind:book使用 calculate 的 calculationId及records.selection；kind:curve使用curve_prepare的curveId，每个CSV segment单独导出及查回执，单段不代表全部完成。重试沿用operationKey，返回operationId后查询真实回执。',
  file_status: '查询文件操作的待确认、取消、过期或真实文件回执；只有 completed 表示已写入。',
  export_batch_prepare:
    '一次提交 PDF 原理图、CSV 冻结曲线指定分段和 Word 当前设计计算书，固定归档到当前工程。传 base、operationKey、curveId、segment、calculationId。自动逐件写入工程归档目录，用 file_status 查询所有回执；partial 表示仅部分文件有成功回执。',
  file_cancel: '取消未确认的文件操作；已开始写入时请查询真实结果。',
  capabilities: '确认目标工作台已开启 AI，读取可用业务操作和命令契约。',
  capture: '捕获当前工作台会话及未保存设计，返回 captureId、base 和运行来源。',
  read: '分页读取同次 capture 的设计、元件库、压力表/探针（probes）、诊断、运行结果或实际采样。',
  preview:
    '【硬性要求】用当前 capture 的 base 提交编辑、撤销或重做候选，由用户在工作台确认。【普通信息】成功回执的 commandCount 为本批实际命令数，replacedProposal 列出被本批取代的同类候选或为 null。新增文字用 text/put 和 replace:false，完整示例见 commands.items.examples。支持元件旋转/左右镜像、选区移动/删除/工程内复制及文本；复制各类 IDs 按源工程数组顺序分配（不是 selection 顺序），内部连线自动纳入，外部连线不复制；含控制程序的元件暂拒绝复制，不使用系统剪贴板。另支持 probe-edit、controller-program 和既有 branch-connect，另有motor-control原子设置马达模式/曲线及switch-output设置压力开关输出；null仅清除指定可选配置。控制程序不执行脚本；物理管内部接点仅沿现有变量马达 X 取压支持域。',
  proposal: '按编号查询候选最新状态、命令数与本批替换的候选。应用后重新捕获实际工程。',
  cancel: '撤销尚未被工作台接受的候选。',
  calculate:
    '复用当前工程的辅助计算与选型，返回计算结果、冻结 calculationId/records 和未应用参数建议；使用当前 capture 的 base，应用建议须另行 preview 并在工作台确认。 duty-report {duty,pendingPhases}, duty-independent {groups:[{pumpId,duty,pendingPhases}]}, duty-combined {pumps,phases,pendingPhases} reuse current-design report owners, preserve incomplete coverage and return records.selection=current; never apply changes.',
  simulate:
    '按条件运行 {kind:"run-until",ticks:最大步数,condition:{componentId,comparison:"gte"或"lte",positionM:距缩回端的绝对位置米}}。用 capture 查 conditionRun 的停止原因，再用 cylinder_compare 查询两缸。用实时capture的base控制本次仿真：运行、暂停、单步、复位、换向、节流开口（m²）或目标流量（m³/s）。run-for带ticks整数1至10000，按现有0.01s固定步/1倍速在宿主调度器限tick暂停，保留控制器序列；须先暂停，已运行时拒绝重复启动。返回limit.targetTick及scheduled表示已调度，须重新capture/read确认已暂停、实际tick和诊断，不能把启动回执说成运行完成。取消/撤权暂停剩余有限运行；本次连接必须开启仿真授权。 sequence-stop stops the current automatic sequence and releases its ownership while preserving time and valve states; does not reset. Manual displacement: {kind:"displacement",componentId,source:"manual",value} in m3/rev; existing range and controller ownership checks apply.',
};
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const project = { type: 'string', minLength: 1, maxLength: 80, description: '配置工作区下的一级工程目录名称。' };

async function toolsFor(root: string, includeOpen: boolean) {
  const receipts = new McpProjectReceipts();
  const { multiCircuitGuidance } = await import('@hyd/project-io');
  const { NetworkTools, networkToolCatalogDefinition, networkToolCommandLimit, parseNetworkToolRequest } =
    await import('@hyd/application');
  const drawingInstructions =
    '【建议】' +
    multiCircuitGuidance +
    `【普通信息】单次绘图候选最多 ${networkToolCommandLimit} 条命令。wiringCheck 是静态接线检查。`;
  const { networkCreationDefinitions } = await import('@hyd/domain');
  const envelopes = new NetworkTools().capabilities().requestSchema.oneOf;
  const preview = envelopes.find((item) => {
    const method = item.properties.method;
    return jsonObject(method) && method.const === 'preview';
  })?.properties.params;
  if (!jsonObject(preview) || !jsonObject(preview.properties) || !jsonObject(preview.properties.commands))
    throw new Error('MCP_COMMAND_SCHEMA_MISSING');
  const liveProject = {
    ...project,
    description: '已打开且允许 AI 操作的工程名称，可用 hydraulic_list_projects 查询。',
  };
  const tools = [
    await createFrameTool(),
    {
      name: 'hydraulic_list_projects',
      description:
        '分页查找已登记的工作台，返回工程名称和实时连接状态。connected 可调用，ambiguous 表示同名窗口，unavailable 表示登记已失效或暂时无法访问。',
      inputSchema: schema({ offset: { type: 'integer', minimum: 0 } }, []),
      annotations: { readOnlyHint: true },
    },
    {
      name: 'hydraulic_project_status',
      description:
        '查询本客户端已提出的另存为或工程切换回执，切换后仍可查；工程切换仅 completed 且 adopted:true 表示工作台已实际采用。awaiting-adoption 表示宿主已切换，接收情况未知，不要重试；persisted:null须核对实际文件。不授予新工程权限，仅支持同一MCP进程内operationId。',
      inputSchema: schema({ operationId: { type: 'string', minLength: 1, maxLength: 100 } }, ['operationId']),
      annotations: { readOnlyHint: true },
    },
    {
      name: 'hydraulic_catalog',
      description: '读取可创建元件的定义、油口和参数约束。工作台关闭时也可调用。可按定义 ID 精确查询。',
      inputSchema: schema({ definitionId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, []),
      annotations: { readOnlyHint: true },
    },
    {
      name: 'hydraulic_create_project',
      description:
        '在配置工作区内保存新的文件夹工程。可提交一批初始绘图命令。同名工程保持原样。' +
        `每批最多 ${networkToolCommandLimit} 条。`,
      inputSchema: schema({ project, commands: { ...preview.properties.commands, minItems: 1 } }, ['project']),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    {
      name: 'hydraulic_read_saved_project',
      description: '读取已经保存的工程设计和布局。工作台关闭时也可调用。',
      inputSchema: schema({ project }, ['project']),
      annotations: { readOnlyHint: true },
    },
    ...envelopes.flatMap((item) => {
      const literal = item.properties.method;
      const method = jsonObject(literal) ? literal.const : null;
      if (typeof method !== 'string' || !liveMethods.includes(method)) return [];
      return [
        {
          name: 'hydraulic_live_' + method,
          description: (liveDescriptions[method] ?? '') + (method === 'preview' ? drawingInstructions : ''),
          inputSchema: schema({ project: liveProject, input: item.properties.params }, ['project', 'input']),
          annotations:
            method === 'preview' ||
            method === 'cancel' ||
            method === 'simulate' ||
            method === 'file_prepare' ||
            method === 'export_batch_prepare' ||
            method === 'export_batch_retry' ||
            method === 'file_cancel' ||
            ['view_navigate', 'diagnose', 'diagnostic_locate', 'settings_prepare', 'settings_cancel'].includes(method)
              ? { destructiveHint: method === 'simulate' }
              : { readOnlyHint: true },
        },
      ];
    }),
  ].map((tool) => ({ ...tool, inputSchema: compactToolSchema(tool.inputSchema) }));

  async function invoke(name: string, args: Record<string, unknown>) {
    if (name === 'hydraulic_create_frame') return createMcpFrame(root, args);
    if (name === 'hydraulic_list_projects') return listActiveProjects(root, includeOpen, args);
    if (name === 'hydraulic_project_status') {
      if (Object.keys(args).join(',') !== 'operationId')
        return mcpFailure('MCP_ARGUMENT_INVALID', '回执查询仅接受operationId。');
      return receipts.read(args.operationId);
    }
    if (name === 'hydraulic_catalog') {
      const { definitionId, offset = 0 } = args;
      if (
        Object.keys(args).some((key) => key !== 'definitionId' && key !== 'offset') ||
        (definitionId !== undefined && (typeof definitionId !== 'string' || definitionId.length > 100)) ||
        typeof offset !== 'number' ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        return mcpFailure('MCP_ARGUMENT_INVALID', '元件定义或分页偏移无效。');
      const definitions =
        definitionId === undefined
          ? networkCreationDefinitions
          : networkCreationDefinitions.filter((entry) => entry.id === definitionId);
      if (definitionId !== undefined && !definitions.length)
        return mcpFailure('DEFINITION_NOT_FOUND', '当前元件库没有此创建定义。');
      return {
        ok: true,
        value: {
          definitions: definitions.slice(offset, offset + 12).map(networkToolCatalogDefinition),
          total: definitions.length,
          nextOffset: offset + 12 < definitions.length ? offset + 12 : null,
        },
      };
    }
    if (!validProjectName(args.project)) return mcpFailure('PROJECT_NAME_INVALID', '请指定工作区下的工程目录名称。');
    if (name === 'hydraulic_create_project') {
      if (Object.keys(args).some((key) => key !== 'project' && key !== 'commands'))
        return mcpFailure('MCP_ARGUMENT_INVALID', '新建工程参数包含未知字段。');
      return createMcpProject(root, args.project, args.commands);
    }
    if (name === 'hydraulic_read_saved_project') {
      if (Object.keys(args).length !== 1) return mcpFailure('MCP_ARGUMENT_INVALID', '读取已保存工程只需要工程名称。');
      return readMcpProject(await existingProjectDirectory(root, args.project));
    }
    if (Object.keys(args).length !== 2 || !jsonObject(args.input))
      return mcpFailure('MCP_ARGUMENT_INVALID', '实时调用需要工程名称和操作参数对象。');
    const request = parseNetworkToolRequest({
      protocol: 'HydraulicTools',
      version: 1,
      requestId: randomUUID(),
      method: name.slice('hydraulic_live_'.length),
      params: args.input,
    });
    if (!request.ok) return request;
    {
      const target = (await activeProjects(root, includeOpen)).get(args.project.toLowerCase());
      if (!target)
        return mcpFailure(
          'CONNECTION_NOT_FOUND',
          '未找到「' + args.project + '」的活动登记。请在打开该工程的工作台检查工具栏的 AI 开关，再查询工程列表。',
        );
      if (target.count !== 1)
        return mcpFailure('TARGET_AMBIGUOUS', '有多个同名工程开启 AI，请只保留需要操作的窗口连接。');
      return receipts.accept(await callLiveProject(target, request.value));
    }
  }
  return { tools, invoke, drawingInstructions };
}

async function* readFrames(): AsyncGenerator<Buffer> {
  let parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new Error('MCP_FRAME_ENCODING');
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end === -1 ? chunk.length : end);
      size += part.length;
      if (size > maximumFrameBytes) throw new Error('MCP_FRAME_LIMIT');
      parts.push(part);
      if (end === -1) break;
      yield Buffer.concat(parts, size);
      parts = [];
      size = 0;
      start = end + 1;
    }
  }
  if (size !== 0) throw new Error('MCP_FRAME_UNTERMINATED');
}

type RpcId = string | number | null;
function writeRpc(id: RpcId, reply: { result: unknown } | { error: { code: number; message: string } }) {
  return new Promise<void>((resolve, reject) => {
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...reply }) + '\n', (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
function rpcError(id: RpcId, code: number, message: string) {
  return writeRpc(id, { error: { code, message } });
}

async function serve(root: string, includeOpen: boolean) {
  const { tools, invoke, drawingInstructions } = await toolsFor(root, includeOpen);
  let state: 'starting' | 'initializing' | 'ready' = 'starting';
  for await (const frame of readFrames()) {
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
    } catch {
      await rpcError(null, -32700, 'Invalid UTF-8 JSON');
      continue;
    }
    if (!jsonObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      await rpcError(null, -32600, 'Invalid request');
      continue;
    }
    const { id, method, params } = message;
    if (id === undefined) {
      if (state === 'initializing' && method === 'notifications/initialized') state = 'ready';
      continue;
    }
    if (typeof id !== 'string' && (typeof id !== 'number' || !Number.isSafeInteger(id))) {
      await rpcError(null, -32600, 'Invalid request ID');
      continue;
    }
    if (method === 'initialize') {
      if (state !== 'starting' || !jsonObject(params) || typeof params.protocolVersion !== 'string') {
        await rpcError(id, -32602, 'Invalid initialization');
        continue;
      }
      state = 'initializing';
      await writeRpc(id, {
        result: {
          protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
          serverInfo: { name: 'deatalos-hydraulic-workbench', version: '0.1.0' },
          capabilities: { tools: {} },
          instructions:
            '【硬性要求】操作 Deatalos 仅用 hydraulic MCP。实时请求先 hydraulic_list_projects 选定 connected 工程，目标有歧义先核对，连接失败就报告并停止。只查候选时用 capture 和 proposal，保持只读。改图用当前 base 提交 preview，由用户在工作台确认。离线快照须由用户明确指定。静态检查与实际运行按各自回执报告。' +
            drawingInstructions,
        },
      });
    } else if (method === 'ping') {
      await writeRpc(id, { result: {} });
    } else if (state !== 'ready') {
      await rpcError(id, -32002, 'Server has not completed initialization');
    } else if (method === 'tools/list') {
      await writeRpc(id, { result: { tools } });
    } else if (method === 'tools/call') {
      if (!jsonObject(params) || typeof params.name !== 'string' || !tools.some((tool) => tool.name === params.name)) {
        await rpcError(id, -32602, 'Unknown or missing tool name');
        continue;
      }
      const args = params.arguments === undefined ? {} : params.arguments;
      let result;
      try {
        result = jsonObject(args)
          ? await invoke(params.name, args)
          : mcpFailure('MCP_ARGUMENT_INVALID', '工具参数必须是对象。');
      } catch (cause) {
        const code = codeOf(cause);
        result =
          cause instanceof FileFailure
            ? mcpFailure(code, cause.message)
            : code === 'EACCES' || code === 'EPERM'
              ? mcpFailure('ACCESS_DENIED', '当前账户无法读取目标目录，请核对账户和目录权限。')
              : code === 'ENOENT'
                ? mcpFailure('PROJECT_NOT_FOUND', '未找到所选工程目录或文件。')
                : mcpFailure('MCP_OPERATION_FAILED', '工程读取或实时请求未完成，请核对工作区和目标工程。');
      }
      await writeRpc(id, {
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: result.ok !== true,
        },
      });
    } else await rpcError(id, -32601, 'Method not found');
  }
}

async function main() {
  const [flag, selected, ...rest] = process.argv.slice(2);
  const includeOpen = rest.length === 1 && rest[0] === '--open-projects';
  if (flag !== '--workspace' || !selected || !path.isAbsolute(selected) || (rest.length && !includeOpen))
    throw new Error('Usage: node network-mcp.cjs --workspace <existing absolute directory> [--open-projects]');
  const root = await realpath(selected);
  if (!(await stat(root)).isDirectory()) throw new Error('MCP_WORKSPACE_INVALID');
  await serve(root, includeOpen);
}

void main().catch((cause: unknown) => {
  stderr.write((cause instanceof Error ? cause.message : 'MCP startup or transport failed') + '\n');
  stdin.destroy();
  process.exitCode = 1;
});
