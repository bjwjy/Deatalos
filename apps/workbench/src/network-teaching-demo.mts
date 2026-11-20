import { endpointKey, type NetworkComponent, type NetworkProject } from '@hyd/domain';
import { networkUiIcon } from './network-v13-icons.mjs';
import { componentTeachingDemo, teachingDemoDefinitions, type TeachingDemo } from './network-teaching-demo-content.mjs';

const playIcon =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/></svg>';
const switchIcon =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4"/></svg>';

/** A separate modal keeps the original properties and its unapplied fields in place. */
function openTeachingDemo(demo: TeachingDemo, trigger: HTMLButtonElement): void {
  const parent = trigger.closest('dialog');
  if (!parent?.open || document.getElementById('componentTeachingDialog')) return;

  const dialog = document.createElement('dialog');
  dialog.id = 'componentTeachingDialog';
  dialog.className = 'v13-dialog';
  dialog.setAttribute('aria-labelledby', 'componentTeachingTitle');
  dialog.innerHTML = `
    <header class="v13-dialog-header">
      <span class="v13-dialog-heading-icon">${playIcon}</span>
      <h2 id="componentTeachingTitle">教学演示回路<small>${demo.name} · ${demo.category}</small></h2>
      <button class="dialog-button teaching-control teaching-playback" data-teaching-play data-press-feedback="off" type="button">${playIcon}<span>播放演示</span></button>
      <button class="dialog-close" data-teaching-close data-press-feedback="off" type="button" aria-label="关闭教学演示">${networkUiIcon('close')}</button>
    </header>
    <div class="v13-dialog-body teaching-body">
      <section class="teaching-stage" aria-label="局部原理示意">
        <div class="teaching-stage-heading"><span>局部原理示意</span><span data-teaching-condition role="status"></span></div>
        <svg class="teaching-diagram" viewBox="0 0 580 298" role="img" aria-label="${demo.name}原理图">
          ${teachingDemoDefinitions}<g data-teaching-drawing></g>
        </svg>
      </section>
      <section class="teaching-notes" aria-label="读图提示">
        <h3>${demo.topic}</h3>
        <p data-teaching-summary></p>
        <button class="dialog-button teaching-control" data-teaching-toggle data-press-feedback="off" type="button">${switchIcon}<span data-teaching-action></span></button>
        <dl>${demo.ports.map(([port, description]) => `<div><dt>${port}</dt><dd>${description}</dd></div>`).join('')}</dl>
        <p class="teaching-observation" data-teaching-observation></p>
      </section>
    </div>`;
  const condition = dialog.querySelector('[data-teaching-condition]');
  const summary = dialog.querySelector('[data-teaching-summary]');
  const action = dialog.querySelector('[data-teaching-action]');
  const observation = dialog.querySelector('[data-teaching-observation]');
  const drawing = dialog.querySelector('[data-teaching-drawing]');
  const toggle = dialog.querySelector<HTMLButtonElement>('[data-teaching-toggle]');
  const play = dialog.querySelector<HTMLButtonElement>('[data-teaching-play]');
  const playLabel = play?.querySelector('span');
  const close = dialog.querySelector('[data-teaching-close]');
  if (!condition || !summary || !action || !observation || !drawing || !toggle || !play || !playLabel || !close)
    throw new Error('Teaching demo template is incomplete');

  const scenes = [demo, demo.alternate, ...(demo.additional ?? [])];
  let sceneIndex = 0;
  let playbackTimer: number | undefined;
  const render = (): void => {
    const scene = scenes[sceneIndex];
    if (!scene) return;
    delete dialog.dataset.teachingStroke;
    toggle.removeAttribute('aria-disabled');
    condition.textContent = scene.condition;
    summary.textContent = scene.summary;
    action.textContent = scene.action;
    observation.textContent = scene.observation;
    if (scene.gauge) {
      if (!drawing.firstElementChild) drawing.innerHTML = scene.gaugeDrawing;
      const needle = drawing.querySelector<SVGElement>('.gauge-needle');
      const reading = drawing.querySelector('[data-gauge-reading]');
      if (needle && reading) {
        needle.style.transform = `rotate(${scene.gauge.angle}deg)`;
        reading.textContent = `${scene.gauge.reading} MPa`;
      }
      if (scene.gauge.samples) {
        const sampleA = drawing.querySelector('[data-gauge-sample-a]');
        const sampleB = drawing.querySelector('[data-gauge-sample-b]');
        if (sampleA && sampleB) {
          sampleA.textContent = scene.gauge.samples[0] + ' MPa';
          sampleB.textContent = scene.gauge.samples[1] + ' MPa';
        }
      }
    } else {
      drawing.innerHTML = scene.drawing;
    }
    if (scene.stroke) {
      const motion = drawing.querySelector('[data-teaching-motion]');
      const settle = () => {
        if (!dialog.open || (motion && !drawing.contains(motion))) return;
        dialog.dataset.teachingStroke = 'ready';
        toggle.removeAttribute('aria-disabled');
        condition.textContent = scene.condition;
      };
      const animation = motion?.getAnimations()[0];
      if (animation) {
        dialog.dataset.teachingStroke = 'moving';
        toggle.setAttribute('aria-disabled', 'true');
        condition.textContent = '正在' + scene.stroke;
        void animation.finished.then(settle, settle);
      } else settle();
    }
  };
  const stopPlayback = (): void => {
    window.clearTimeout(playbackTimer);
    playbackTimer = undefined;
    playLabel.textContent = '播放演示';
  };
  const playScene = (): void => {
    render();
    // Leave time to read the condition after even the longest teaching stroke.
    playbackTimer = window.setTimeout(() => {
      if (!dialog.open || sceneIndex === scenes.length - 1) {
        stopPlayback();
        return;
      }
      sceneIndex++;
      playScene();
    }, 2600);
  };
  play.addEventListener('click', () => {
    if (playbackTimer !== undefined) {
      stopPlayback();
      return;
    }
    // An explicit play request enables motion only in this teaching dialog.
    dialog.dataset.teachingMotionEnabled = '';
    sceneIndex = 0;
    playLabel.textContent = '停止自动播放';
    playScene();
  });
  toggle.addEventListener('click', () => {
    if (toggle.getAttribute('aria-disabled') === 'true') return;
    stopPlayback();
    sceneIndex = (sceneIndex + 1) % scenes.length;
    render();
  });
  const closeDemo = () => dialog.close();
  close.addEventListener('click', closeDemo);
  parent.addEventListener('close', closeDemo);
  dialog.addEventListener('close', () => {
    stopPlayback();
    parent.removeEventListener('close', closeDemo);
    dialog.remove();
    if (parent.open) trigger.focus({ preventScroll: true });
  });
  document.body.append(dialog);
  dialog.showModal();
  render();
}

export function teachingDemoButton(reference: string): HTMLButtonElement | undefined {
  const demo = componentTeachingDemo(reference);
  if (!demo) return undefined;
  const button = document.createElement('button');
  button.className = 'dialog-button teaching-entry';
  button.type = 'button';
  button.dataset.pressFeedback = 'off';
  button.setAttribute('aria-haspopup', 'dialog');
  button.innerHTML = `${playIcon}<span>教学演示回路</span>`;
  button.addEventListener('click', () => openTeachingDemo(demo, button));
  return button;
}

/** A lock pair consists of two separate valves on distinct, reciprocal pilot circuits. */
export function componentTeachingReference(project: NetworkProject, component: NetworkComponent): string {
  const definition = component.definition.id;
  if (definition !== 'teaching:pilot-check-internal') return definition;
  const neighbours = new Map<string, string[]>();
  for (const connection of project.design.connections) {
    if (connection.kind === 'signal') continue;
    const a = endpointKey(connection.from);
    const b = endpointKey(connection.to);
    const ends = neighbours.get(a);
    if (ends) ends.push(b);
    else neighbours.set(a, [b]);
    const starts = neighbours.get(b);
    if (starts) starts.push(a);
    else neighbours.set(b, [a]);
  }
  const port = (componentId: string, portId: string) => endpointKey({ kind: 'port', componentId, portId });
  const circuit = (start: string) => {
    const connected = new Set([start]);
    for (const key of connected) for (const neighbour of neighbours.get(key) ?? []) connected.add(neighbour);
    return connected;
  };
  const feed = circuit(port(component.id, 'A'));
  const pilot = port(component.id, 'X');
  if (feed.has(pilot)) return definition;
  const control = circuit(pilot);
  const partners = project.design.components.filter(
    (other) =>
      other.id !== component.id &&
      other.definition.id === definition &&
      feed.has(port(other.id, 'X')) &&
      control.has(port(other.id, 'A')),
  );
  return partners.length === 1 ? 'assembly:pilot-lock-pair' : definition;
}
