import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, boundedRead, codeOf } from './atomic-file.cjs';
import { existingProjectDirectory, mcpFailure, validProjectName } from './network-mcp-project.cjs';

const directoryName = '图框_Frames';
const maxBytes = 512 * 1024;
export async function createFrameTool() {
  const { frameBoxLimits: limit } = await import('@hyd/application');
  const mm = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum, multipleOf: 0.01 });
  return {
    name: 'hydraulic_create_frame',
    description:
      '根据用户描述生成可导入图框设计器的 .hydframe 文件。工作台关闭也能使用。标题栏 180×56 mm，左上为原点，x 向右、y 向下；每个 boxes 元素是一格，按用户给出的长度、宽度和位置换算为毫米。要求固定格数时须无重叠铺满；允许余下区域补空格时传 fillBlank:true。成功回执含文件绝对路径、指定格数及补格数。同名同内容可重试，改版请换名称。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'boxes'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 60,
          description: '模板名称，同时用作文件名，不含路径或扩展名。',
        },
        fillBlank: { type: 'boolean', default: false },
        boxes: {
          type: 'array',
          minItems: 1,
          maxItems: limit.maxCells,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['xMm', 'yMm', 'widthMm', 'heightMm'],
            properties: {
              xMm: mm(0, limit.widthMm),
              yMm: mm(0, limit.heightMm),
              widthMm: mm(limit.minWidthMm, limit.widthMm),
              heightMm: mm(limit.minHeightMm, limit.heightMm),
              text: { type: 'string', maxLength: 160, description: '可选的格内文字，省略即留白。' },
            },
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

export async function createMcpFrame(root: string, args: Record<string, unknown>) {
  if (!validProjectName(args.name) || args.name.toLowerCase().endsWith('.hydframe'))
    return mcpFailure('FRAME_NAME_INVALID', '请输入可用作文件名的模板名称，无需扩展名。');
  const { drawingFrameFile, drawingFrameFromBoxes } = await import('@hyd/application');
  const parsed = drawingFrameFromBoxes(args);
  if (!parsed.ok) return parsed;
  const template = parsed.value;
  const bytes = Buffer.from(JSON.stringify(drawingFrameFile(template), null, 2) + '\n');
  await mkdir(path.join(root, directoryName), { recursive: true });
  const directory = await existingProjectDirectory(root, directoryName);
  const filePath = path.join(directory, template.name + '.hydframe');
  try {
    await atomicWrite(filePath, bytes, null, () => true, {}, maxBytes);
  } catch (cause) {
    const code = codeOf(cause);
    if (code !== 'FILE_CONFLICT' && code !== 'EEXIST') throw cause;
    try {
      if (!(await boundedRead(filePath, maxBytes)).equals(bytes))
        return mcpFailure('FRAME_NAME_CONFLICT', '同名图框已存在且内容不同，请更换名称。');
    } catch (readError) {
      if (codeOf(readError) === 'ENOENT') return mcpFailure('FRAME_BUSY', '该名称正在写入，请稍后重试。');
      throw readError;
    }
  }
  const cells = template.table ?? [];
  const blankCells = cells.filter((cell) => cell.id.startsWith('cBlank')).length;
  return {
    ok: true,
    value: {
      filePath,
      name: template.name,
      requestedBoxes: cells.length - blankCells,
      blankCells,
      totalCells: cells.length,
    },
  };
}
