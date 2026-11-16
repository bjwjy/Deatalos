import { element } from './network-dom.mjs';

export type RunVisualPhase = 'idle' | 'starting' | 'running' | 'paused';
/** Called by accepted runtime feedback, never used as simulation state. */
export function presentNetworkRun(phase: RunVisualPhase): void {
  const button = element('run');
  if (button.dataset.iconPhase === phase) return;
  button.dataset.iconPhase = phase;
  if (phase === 'idle')
    for (const animation of button.querySelector('.run-rotor')?.getAnimations() || []) animation.currentTime = 0;
}

let saveRestore: ReturnType<typeof setTimeout> | undefined;
/** Confirmation is invoked only after the file owner accepts the save receipt. */
export function presentNetworkSave(phase: 'idle' | 'working' | 'confirmed'): void {
  clearTimeout(saveRestore);
  const button = element('saveProject');
  button.dataset.savePhase = phase;
  if (phase === 'confirmed')
    saveRestore = setTimeout(() => {
      button.dataset.savePhase = 'idle';
    }, 900);
}
export function setupNetworkOperationVisibility(): void {
  function reflect(): void {
    element('run').dataset.iconVisible = String(!document.hidden);
    element('saveProject').dataset.saveVisible = String(!document.hidden);
  }
  reflect();
  document.addEventListener('visibilitychange', reflect);
}
