import type { DrawingTemplate } from '@hyd/application';

type Entry = { id: string; kind: 'project' | 'curve' | 'frame' };
type Content = { template: DrawingTemplate } | { name: string; text: string } | { error: string };

declare global {
  interface Window {
    associatedFiles: {
      next(): Promise<Entry | null>;
      read(id: string): Promise<Content>;
      finish(id: string): Promise<void>;
      onAvailable(callback: () => void): void;
    };
  }
}

export function bindAssociatedFiles(hooks: {
  project(id: string): Promise<boolean>;
  curve(file: File): Promise<void>;
  frame(template: DrawingTemplate): void;
  busy(): boolean;
  report(message: string): void;
}) {
  const bridge = window.associatedFiles;
  let running = false,
    requested = false;
  const wait = () => new Promise<void>((resolve) => window.setTimeout(resolve, 150));
  const blocked = () => hooks.busy() || !!document.querySelector('dialog[open]');
  async function drain() {
    requested = true;
    if (running) return;
    running = true;
    try {
      do {
        requested = false;
        let entry: Entry | null;
        while ((entry = await bridge.next())) {
          if (document.querySelector('dialog[open]')) hooks.report('有文件等待打开，关闭当前对话框后将继续。');
          while (blocked()) await wait();
          try {
            if (entry.kind === 'project') {
              if (!(await hooks.project(entry.id))) continue;
            } else {
              const content = await bridge.read(entry.id);
              if ('error' in content) throw new Error(content.error);
              while (blocked()) await wait();
              if ('template' in content) hooks.frame(content.template);
              else await hooks.curve(new File([content.text], content.name));
            }
          } catch (cause) {
            hooks.report('无法打开文件：' + String(cause));
          }
          await bridge.finish(entry.id);
        }
      } while (requested);
    } catch (cause) {
      hooks.report('接收文件失败：' + String(cause));
    } finally {
      running = false;
    }
  }
  bridge.onAvailable(() => void drain());
  void drain();
}
