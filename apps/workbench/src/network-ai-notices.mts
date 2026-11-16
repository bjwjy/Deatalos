import type { NetworkToolProposal } from '@hyd/application';

/** Transient reminders only: dismissing or timing out never accepts/rejects a proposal. */
export function createAiCandidateNotices(open: (id: string) => void, accept: (id: string) => void) {
  const stack = document.createElement('section');
  stack.className = 'ai-candidate-notices';
  stack.setAttribute('popover', 'manual');
  stack.setAttribute('aria-label', 'AI候选提醒');
  document.body.append(stack);
  const visible = new Map<string, { element: HTMLElement; timer: ReturnType<typeof setTimeout> }>();
  const seen = new Set<string>();
  function dismiss(id: string) {
    const notice = visible.get(id);
    if (!notice) return;
    clearTimeout(notice.timer);
    notice.element.remove();
    visible.delete(id);
    if (!visible.size && stack.matches(':popover-open')) stack.hidePopover();
  }
  return {
    sync(proposals: readonly NetworkToolProposal[]) {
      const live = new Set(proposals.map((p) => p.id));
      for (const id of visible.keys()) if (!live.has(id)) dismiss(id);
      for (const proposal of proposals) {
        if (seen.has(proposal.id)) continue;
        seen.add(proposal.id);
        if (seen.size > 32) seen.delete(seen.values().next().value ?? '');
        const card = document.createElement('article');
        card.className = 'ai-candidate-notice';
        card.dataset.aiNotice = proposal.id;
        card.dataset.category = proposal.category;
        card.setAttribute('role', 'status');
        const title = document.createElement('strong');
        title.textContent = proposal.category === 'calculation' ? 'AI计算候选已提交' : 'AI原理图候选已提交';
        const text = document.createElement('p');
        text.textContent = '尚未应用，请查看并确认。';
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.textContent = '确定应用';
        confirm.addEventListener('click', () => accept(proposal.id));
        const review = document.createElement('button');
        review.type = 'button';
        review.textContent = '查看候选';
        review.addEventListener('click', () => {
          dismiss(proposal.id);
          open(proposal.id);
        });
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'ai-notice-close';
        close.textContent = '×';
        close.setAttribute('aria-label', '删除提醒');
        close.addEventListener('click', () => dismiss(proposal.id));
        const actions = document.createElement('div');
        actions.className = 'ai-notice-actions';
        actions.append(confirm, review);
        const progress = document.createElement('div');
        progress.className = 'ai-notice-countdown';
        progress.setAttribute('aria-hidden', 'true');
        card.append(title, close, text, actions, progress);
        stack.append(card);
        visible.set(proposal.id, { element: card, timer: setTimeout(() => dismiss(proposal.id), 20000) });
      }
      if (visible.size && !stack.matches(':popover-open')) stack.showPopover();
    },
    clear() {
      for (const id of visible.keys()) dismiss(id);
      seen.clear();
    },
  };
}
