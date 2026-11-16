import { networkToolParameterRows, type NetworkDraftSession, type NetworkToolBase } from '@hyd/application';
import type { Result } from '@hyd/domain';
import { element } from './network-dom.mjs';

interface Hooks {
  editor(): NetworkDraftSession;
  base(): NetworkToolBase;
  enabled(): boolean;
  preview(input: unknown, origin: string): Result<unknown>;
}
/** Input buffers and view modes only; all proposals remain owned by NetworkTools. */
export function setupNetworkAiSettings(hooks: Hooks) {
  const panel = document.createElement('section');
  panel.id = 'aiOrdinarySettings';
  panel.innerHTML = `<h3>手动建议</h3>
    <p class="muted">客户端无法直接连接时，可手动传递参数提示。先在「本机连接」开启接口，再预览返回的建议。</p>
    <section class="ai-manual-step">
    <h4>生成并复制参数提示</h4>
    <label>设置对象<select id="aiParameterTarget"><option value="">请选择对象</option></select></label>
    <label>你的要求<textarea id="aiParameterRequest" rows="3" maxlength="2000" placeholder="例如：将液压缸行程设为0.5m，保持其他参数不变"></textarea></label>
    <button id="aiBuildPrompt" type="button">生成参数提示</button>
    <label>参数提示（确认后复制给AI）<textarea id="aiParameterPrompt" rows="7" readonly></textarea></label>
    <button id="aiCopyPrompt" type="button" disabled>复制提示</button>
    </section>
    <section class="ai-manual-step">
    <h4>粘贴并预览建议</h4>
    <label>建议来源<input id="aiParameterOrigin" maxlength="120" value="手动粘贴的AI建议（来源未核验）"></label>
    <label>AI返回的JSON建议<textarea id="aiParameterCandidate" rows="5" placeholder='{"base":{…},"operation":"edit","commands":[…]}'></textarea></label>
    <button id="aiPreviewParameters" type="button">预览参数建议</button>
    <p id="aiSettingsStatus" role="status" aria-live="polite"></p>
    </section>`;
  element('externalTools').append(panel);
  const target = element('aiParameterTarget'),
    request = element('aiParameterRequest'),
    prompt = element('aiParameterPrompt'),
    candidate = element('aiParameterCandidate'),
    origin = element('aiParameterOrigin');
  if (
    !(target instanceof HTMLSelectElement) ||
    !(request instanceof HTMLTextAreaElement) ||
    !(prompt instanceof HTMLTextAreaElement) ||
    !(candidate instanceof HTMLTextAreaElement) ||
    !(origin instanceof HTMLInputElement)
  )
    throw new Error('AI settings controls missing');
  const select = target,
    requirement = request,
    promptInput = prompt,
    candidateInput = candidate,
    originInput = origin;
  let revision = '',
    promptBase: NetworkToolBase | null = null;
  const status = (text: string) => {
    element('aiSettingsStatus').textContent = text;
  };
  function invalidatePrompt() {
    promptBase = null;
    promptInput.value = '';
    element('aiCopyPrompt').setAttribute('disabled', '');
  }
  select.addEventListener('change', invalidatePrompt);
  requirement.addEventListener('input', invalidatePrompt);
  element('aiBuildPrompt').addEventListener('click', () => {
    invalidatePrompt();
    if (!select.value || !requirement.value.trim()) {
      status('请选择设置对象并填写具体要求；缺少条件时不能生成建议。');
      return;
    }
    const doc = hooks.editor().document,
      rows = networkToolParameterRows(doc).filter((row) =>
        select.value === 'project' ? row.target === 'project' || row.target === 'pipe' : row.id === select.value,
      );
    if (!rows.length) {
      status('所选对象已不存在或没有可设置的数值参数，请重新选择。');
      return;
    }
    promptBase = hooks.base();
    promptInput.value =
      `请帮助设置液压工程参数。用户要求：${requirement.value.trim()}\n` +
      '只建议所列字段，不猜缺失条件；缺必要输入时先说明缺口。数值均为SI，null表示未指定，不能替换为0。不得把建议写成仿真已通过。\n' +
      '元件参数的locked=true表示不可改变，minimum/maximum为允许范围。不得解锁、扩大范围或移除元件来绕过；需要改变约束请先让用户在参数窗口明确操作。\n' +
      '仅返回JSON对象：{"base":下方base原样,"operation":"edit","commands":[命令]}。最多30条。\n' +
      '元件参数：{kind:"parameter",id,group,key,value}；工程油液：{kind:"project-parameter",id:工程ID,key,value}；数值初态：{kind:"initial-parameter",id:元件ID,key,value}；已有物理管：{kind:"pipe-parameter",id:管路ID,key,value}。阀位/运行控制请使用软件专用界面。全部修改须用户预览后确认。\n' +
      JSON.stringify(
        {
          projectId: doc.projectId,
          title: doc.title,
          pressureReference: doc.design.pressureReference,
          base: promptBase,
          parameters: rows,
        },
        null,
        2,
      );
    element('aiCopyPrompt').removeAttribute('disabled');
    status('提示已生成，仅在本机显示；请核对后复制给你使用的AI。');
  });
  element('aiCopyPrompt').addEventListener('click', () => {
    if (!promptBase || !promptInput.value) return;
    void navigator.clipboard.writeText(promptInput.value).then(
      () => status('参数提示已复制。'),
      () => {
        promptInput.focus();
        promptInput.select();
        status('自动复制不可用，已选中文本，请按Ctrl+C。');
      },
    );
  });
  element('aiPreviewParameters').addEventListener('click', () => {
    if (!hooks.enabled()) {
      status('请先开启“允许 AI 操作”，再预览参数建议。');
      return;
    }
    if (!promptBase) {
      status('请先为当前对象生成参数提示；工程变化后需要重新生成。');
      return;
    }
    if (!originInput.value.trim()) {
      status('请填写建议来源，方便核对。');
      return;
    }
    if (candidateInput.value.length > 1048576) {
      status('建议超过1MB，请缩小本批修改。');
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(candidateInput.value);
    } catch {
      status('建议不是有效JSON，请粘贴完整对象。');
      return;
    }
    const result = hooks.preview(input, originInput.value.trim());
    status(
      result.ok
        ? '候选已生成。请到「修改候选」核对后应用。'
        : result.diagnostics.map((d) => `${d.field}：${d.message}`).join('；'),
    );
  });
  function render() {
    const editor = hooks.editor(),
      next = editor.documentSessionId + ':' + editor.revision;
    if (revision !== next) {
      const switched = revision !== '' && !revision.startsWith(editor.documentSessionId + ':');
      if (revision) {
        invalidatePrompt();
        candidateInput.value = '';
        status('工程已变化，请重新生成参数提示。');
      }
      const prior = switched ? '' : select.value;
      if (switched) requirement.value = '';
      select.replaceChildren(
        new Option('请选择对象', ''),
        new Option('工程油液与已有物理管路', 'project'),
        ...editor.document.design.components.map((c) => new Option(`${c.label}（${c.id}）`, c.id)),
      );
      if ([...select.options].some((o) => o.value === prior)) select.value = prior;
      revision = next;
    }
  }
  return { render };
}
