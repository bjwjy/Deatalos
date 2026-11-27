import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedRead } from './atomic-file.cjs';
import { readFrameFile } from './frame-files.cjs';

type Kind = 'project' | 'frame' | 'curve';
const formats = new Map<string, Kind>([
  ['.hydproj', 'project'],
  ['.hydx', 'project'],
  ['.hydframe', 'frame'],
  ['.hydcurve', 'curve'],
]);

export class AssociatedFiles {
  private readonly pending: { id: string; kind: Kind; file: string }[] = [];

  add(argv: readonly string[]) {
    for (const file of argv) {
      if (!path.isAbsolute(file)) continue;
      const kind = formats.get(path.extname(file).toLowerCase());
      if (kind) this.pending.push({ id: randomUUID(), kind, file });
    }
  }

  next() {
    const head = this.pending[0];
    return head ? { id: head.id, kind: head.kind } : null;
  }

  finish(id: unknown) {
    if (this.pending[0]?.id === id && typeof id === 'string') this.pending.shift();
  }

  project(id: unknown) {
    const head = this.pending[0];
    if (!head || head.id !== id || head.kind !== 'project') throw new Error('工程打开请求已失效。');
    return head.file;
  }

  async read(id: unknown) {
    const head = this.pending[0];
    if (!head || head.id !== id || head.kind === 'project') throw new Error('文件打开请求已失效。');
    if (head.kind === 'frame') return readFrameFile(head.file);
    const bytes = await boundedRead(head.file, 4_000_000);
    return { name: path.basename(head.file), text: bytes.toString('utf8').replace(/^\uFEFF/, '') };
  }
}
