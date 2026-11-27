import { dialog, type BrowserWindow } from 'electron';
import path from 'node:path';
import { boundedRead, targetPath } from './atomic-file.cjs';
import { writeNewOutput } from './new-output.cjs';

const filters = [{ name: 'Deatalos 图框文件', extensions: ['hydframe'] }];
const limit = 512 * 1024;

export async function openFrameFile(parent: BrowserWindow) {
  const file = await dialog.showOpenDialog(parent, { title: '导入图框', properties: ['openFile'], filters });
  const selected = file.filePaths[0];
  if (file.canceled || !selected) return null;
  return readFrameFile(selected);
}

export async function readFrameFile(selected: string) {
  if (path.extname(selected).toLowerCase() !== '.hydframe') return { error: '请选择 .hydframe 图框文件。' };
  const bytes = await boundedRead(selected, limit);
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { error: '无法读取图框内容，请检查文件是否完整。' };
  }
  const { parseFrameFile } = await import('@hyd/application');
  const result = parseFrameFile(data);
  return result.ok ? { template: result.value } : { error: '图框格式或版本无效：' + result.diagnostics[0]?.message };
}

export async function saveFrameFile(parent: BrowserWindow, input: unknown, current: () => boolean) {
  const { drawingFrameFile, parseDrawingTemplate } = await import('@hyd/application');
  const result = parseDrawingTemplate(input);
  if (!result.ok) return { error: result.diagnostics[0]?.message ?? '图框无效。' };
  const stem = result.value.name.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') || '自定义图框';
  const safeStem = /^(con|prn|aux|nul|(?:com|lpt)[1-9])(?:\.|$)/i.test(stem) ? '_' + stem : stem;
  const file = await dialog.showSaveDialog(parent, { title: '导出图框', defaultPath: safeStem + '.hydframe', filters });
  if (file.canceled || !file.filePath) return null;
  const selected = file.filePath;
  const target = await targetPath(selected.toLowerCase().endsWith('.hydframe') ? selected : selected + '.hydframe');
  const bytes = Buffer.from(JSON.stringify(drawingFrameFile(result.value), null, 2) + '\n');
  const saved = await writeNewOutput(target, bytes, current, {}, limit);
  return { name: path.basename(saved) };
}
