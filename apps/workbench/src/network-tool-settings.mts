import {
  NetworkToolSettings,
  networkToolSettingDefinitions,
  type NetworkToolBase,
  type NetworkToolRequest,
  type NetworkToolSettingOutcome,
} from '@hyd/application';
import { diagnostic } from '@hyd/domain';
import type { createNetworkAppSettings } from './network-app-settings.mjs';
interface Hooks {
  base(): NetworkToolBase;
  uid(prefix: string): string;
  settings: ReturnType<typeof createNetworkAppSettings>;
  notify(message: string): void;
}
/** Presentation and ordered preference effects; pending/confirmation ownership remains in application. */
export function createToolSettings(hooks: Hooks) {
  let operations = new NetworkToolSettings(),
    displayed = '';
  const dialog = document.createElement('dialog');
  dialog.id = 'toolSettingsConfirmation';
  dialog.className = 'v13-dialog';
  dialog.setAttribute('aria-labelledby', 'toolSettingsHeading');
  const header = document.createElement('header');
  header.className = 'v13-dialog-header';
  const heading = document.createElement('h2');
  heading.id = 'toolSettingsHeading';
  heading.textContent = 'AI 请求更新本机设置';
  header.append(heading);
  const body = document.createElement('div');
  body.className = 'v13-dialog-body';
  const summary = document.createElement('pre');
  summary.id = 'toolSettingsSummary';
  summary.style.whiteSpace = 'pre-wrap';
  summary.style.overflowWrap = 'anywhere';
  body.append(summary);
  const footer = document.createElement('footer');
  footer.className = 'v13-dialog-footer';
  const reject = document.createElement('button');
  reject.id = 'cancelToolSettings';
  reject.className = 'dialog-button';
  reject.textContent = '取消';
  const accept = document.createElement('button');
  accept.id = 'confirmToolSettings';
  accept.className = 'dialog-button dialog-primary';
  accept.textContent = '确认更新本机设置';
  footer.append(reject, accept);
  dialog.append(header, body, footer);
  document.body.append(dialog);
  const dismiss = () => {
    displayed = '';
    dialog.close();
  };
  const cancel = () => {
    if (displayed && operations.cancel(displayed).ok) dismiss();
  };
  reject.addEventListener('click', cancel);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancel();
  });
  accept.addEventListener('click', () => {
    void confirm();
  });
  async function confirm() {
    const id = displayed,
      owner = operations;
    const ready = owner.confirm(id, hooks.base(), hooks.settings.toolSnapshot());
    if (!ready.ok) {
      hooks.notify(ready.diagnostics.map((item) => item.message).join('；'));
      dismiss();
      return;
    }
    accept.disabled = true;
    reject.disabled = true;
    const outcomes: NetworkToolSettingOutcome[] = [];
    const current = () => {
      const base = hooks.base();
      return (
        owner === operations &&
        base.documentSessionId === ready.value.base.documentSessionId &&
        base.revision === ready.value.base.revision &&
        base.physicsRevision === ready.value.base.physicsRevision
      );
    };
    try {
      for (const change of ready.value.changes) {
        if (!current()) break;
        outcomes.push(await hooks.settings.toolApply(change, current));
      }
    } catch {
      hooks.notify('设置应用未完整结束；已应用部分保留，请查看逐项回执，不要盲目重试。');
    } finally {
      owner.complete(id, outcomes);
      if (displayed === id) {
        accept.disabled = false;
        reject.disabled = false;
        dismiss();
      }
    }
  }
  return {
    read: () => ({
      ok: true as const,
      value: { values: hooks.settings.toolSnapshot(), definitions: networkToolSettingDefinitions },
    }),
    prepare(params: Extract<NetworkToolRequest, { method: 'settings_prepare' }>['params']) {
      this.render();
      if ([...document.querySelectorAll('dialog[open]')].some((element) => element !== dialog))
        return {
          ok: false as const,
          diagnostics: [diagnostic('INTERACTION_BUSY', '/settings', '请先完成或关闭当前弹窗。')],
        };
      const result = operations.prepare(
        params.base,
        hooks.base(),
        params.operationKey,
        params.changes,
        hooks.settings.toolSnapshot(),
        hooks.uid('settings'),
      );
      if (!result.ok || result.value.state !== 'awaiting-confirmation' || displayed === result.value.operationId)
        return result;
      displayed = result.value.operationId;
      accept.disabled = false;
      reject.disabled = false;
      summary.textContent =
        '仅修改本机偏好；不修改物理设计、运行或工程保存标记。\n' +
        result.value.changes
          .map(
            (change) =>
              (networkToolSettingDefinitions.find((definition) => definition.key === change.key)?.label ?? change.key) +
              '：' +
              JSON.stringify(result.value.before[change.key]) +
              ' → ' +
              JSON.stringify(change.value),
          )
          .join('\n') +
        '\n目录由本机选择；取消选择只表示该项未应用。降低恢复份数会按既有策略淘汰旧副本。每项回执分别记录应用与持久化，部分失败不回滚已应用设置。';
      dialog.showModal();
      return result;
    },
    status(id: string) {
      this.render();
      return operations.status(id);
    },
    cancel(id: string) {
      const result = operations.cancel(id);
      if (result.ok && displayed === id) dismiss();
      return result;
    },
    render() {
      operations.invalidate(hooks.base());
      if (displayed) {
        const found = operations.status(displayed);
        if (found.ok && found.value.state !== 'awaiting-confirmation' && found.value.state !== 'applying') dismiss();
      }
    },
    retire() {
      operations.invalidate(null);
      operations = new NetworkToolSettings();
      dismiss();
    },
  };
}
