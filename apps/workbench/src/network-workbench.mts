import { setupNetworkStatusPanels } from './network-status-panels.mjs';
import { setupNetworkWhiteInterface } from './network-v13-shell.mjs';
import { presentNetworkRun } from './network-v13-operation-feedback.mjs';
import { createNetworkInstanceControls } from './network-instance-controls.mjs';
import { createNetworkCurvePreview } from './network-curve-preview.mjs';
import { createNetworkThrottleControl } from './network-throttle-control.mjs';
import { setupNetworkLibraryDrag } from './network-library-drag.mjs';
import { libraryComponentPreview } from './network-component-library.mjs';
import { createNetworkEditing } from './network-editing-controller.mjs';
import {
  createNetworkDraftSession,
  applyNetworkSizing,
  applyNetworkDuty,
  applyNetworkLayout,
  applyNetworkGoal,
  planNetworkPilotLockPair,
  planNetworkFlowMeterInsertion,
  nextNetworkController,
} from '@hyd/application';
import {
  networkInitialFor,
  networkCreationDefinitions,
  networkCreationParameters,
  networkDefinition,
  uniqueValveName,
  directionalValveBaseName,
  isNetworkNativeStepS,
  networkStepPreferenceKey,
  type NetworkProject,
  type Result,
} from '@hyd/domain';

import { componentDisplayName } from '@hyd/domain';

import { createNetworkDraft, type MigrationContext } from '@hyd/project-io';

import { element as $, setText } from './network-dom.mjs';
import { setupNetworkWorkspace } from './network-workspace.mjs';
import { setupNetworkShell, showNetworkNotice as toast } from './network-shell.mjs';
import { setupNetworkDiagnosticPanel } from './network-diagnostic-panel.mjs';
import { createNetworkRuntime } from './network-runtime-controller.mjs';
import { createNetworkControllers } from './network-controllers.mjs';
import { createNetworkProbes } from './network-probes.mjs';
import { createNetworkTexts } from './network-texts.mjs';
import { createNetworkCanvas } from './network-canvas-controller.mjs';
import { createNetworkFeedback } from './network-feedback.mjs';
import { createNetworkProperties } from './network-properties.mjs';
import { createNetworkShortcutParameters } from './network-shortcut-parameters.mjs';
import { createNetworkShortcutPanels } from './network-shortcut-panels.mjs';
import { setupNetworkRouteMenu } from './network-route-menu.mjs';
import { setupNetworkComponentMenu } from './network-component-menu.mjs';
import { createNetworkValveSettings } from './network-valve-settings.mjs';
import { createValveLibrary } from './network-valve-library.mjs';
import { createNetworkFormalExport } from './network-formal-export.mjs';
import { createNetworkCurveTools } from './network-curve-tools.mjs';
import { createCurveHistory } from './network-curve-history.mjs';
import { createNetworkResults } from './network-results-panel.mjs';
import { createNetworkPressureSettings } from './network-pressure-settings.mjs';
import { createNetworkAppSettings } from './network-app-settings.mjs';
import { createNetworkRecovery } from './network-recovery.mjs';
import { createNetworkFiles } from './network-file-controller.mjs';
import { createNetworkSizing } from './network-sizing.mjs';
import { createNetworkDuty } from './network-duty.mjs';
import { createNetworkLayout } from './network-layout.mjs';
import { createNetworkTools } from './network-tools.mjs';
import type { NetworkDraftSession } from '@hyd/application';
import { componentEditor, type ComponentEditor } from './network-component-editing.mjs';

// Domain IDs allow at most 40 characters; preserve 80 random bits even for long registered type IDs.
const uid = (prefix: string) => prefix.slice(0, 19) + '_' + crypto.randomUUID().replaceAll('-', '').slice(0, 20);
const context = (): MigrationContext => ({
  projectId: uid('project'),
  timestamp: new Date().toISOString(),
  appVersion: '0.9.0-e06',
});
const eligible = networkCreationDefinitions;
let editor: NetworkDraftSession;
let statusPanels: ReturnType<typeof setupNetworkStatusPanels>;
function session(document: NetworkProject, id: string, saved = false): NetworkDraftSession {
  const value = createNetworkDraftSession(document, id, saved);
  if (!value.ok) throw new Error(value.diagnostics.map((item) => item.message).join('；'));
  return value.value;
}
// Factories defer reading each other until assembly and editor initialization finish.
const curveHistory = createCurveHistory(toast);
async function checkpointCurve(): Promise<void> {
  try {
    const capture = await simulation.refreshRecords('current');
    if (capture) await curveHistory.remember(capture);
  } catch {
    toast('未能保留本次曲线历史，原有记录保持。');
  }
}
const simulation = createNetworkRuntime({
  document: () => editor.document,
  useLowPressurePreview: () => ($('lowPressurePreview') as HTMLInputElement).checked,
  sessionId: () => editor.documentSessionId,
  physicsRevision: () => editor.physicsRevision,
  render: queueRuntimeRender,
  renderFeedback: () => feedback.render(),
  clearDiagnostics: () => feedback.clear(),
  diagnostics: (items, source) => feedback.show(items, source),
  toast,
  busyChanged: (busy) => $('runStatus').setAttribute('aria-busy', String(busy)),
  recordSelection: () => ($('exportHistory') as HTMLSelectElement).value,
  rememberCurve: (capture) => void curveHistory.remember(capture),
  interacting: () => canvas.dragging,
  invalidateInteraction: () => {
    if (canvas.cancelPending()) properties.invalidate();
  },
  clearExportStatus: () => {
    $('exportStatus').textContent = '';
  },
  beforeReset: checkpointCurve,
  afterReset: () => presentNetworkRun('idle'),
});
const feedback = createNetworkFeedback({
  editor: () => editor,
  runtime: () => simulation.runtime,
  error: () => simulation.error,
  invalidated: () => simulation.invalidated,
  initializing: () => simulation.initializing,
});
const instanceControls = createNetworkInstanceControls({
  editor: () => editor,
  simulation,
  showCard: () => statusPanels.show('controls'),
});
const pressureSettings = createNetworkPressureSettings(() => render(), toast);
const appSettings = createNetworkAppSettings(
  () => canvas.draw(),
  () => recovery.reconfigure(),
);
const componentEditors: Readonly<Record<ComponentEditor, (id: string) => void>> = {
  properties: () => $('openProperties').click(),
  valve: (id) => valveSettings.open(id),
  controller: (id) => controllers.open(id),
  throttle: (id) => throttleControl.open(id),
  displacement: (id) => instanceControls.open(id),
};
function editComponent(id: string): void {
  const component = editor.document.design.components.find((c) => c.id === id);
  if (component)
    componentEditors[componentEditor(component, simulation.runtime?.status === 'ready' && !simulation.invalidated)](id);
}
const canvas = createNetworkCanvas({
  overlay: (project) => probes.overlay(project) + texts.overlay(project),
  editText: (id) => texts.open(id),
  pressureBands: () => pressureSettings.bands,
  connectionRadius: () => appSettings.connectionRadius,
  branchRevealRadius: () => appSettings.branchRevealRadius,
  labels: appSettings.canvasLabels,
  viewportChanged: () => recovery.observe(),
  editor: () => editor,
  capture: () => simulation.capture,
  point: () => results.visiblePoint(),
  failed: currentRuntimeFailure,
  uid,
  mutate,
  render,
  undoRedo,
  toast,
  fileBusy: () => files.busy,
  sendControl: (changes) => simulation.sendControl(changes),
  save: (saveAs) => files.save(saveAs),
  diagnostics: (items) => feedback.show(items),
  cancelPipeEdit: () => properties.cancelPipeEdit(),
  propertiesChanged: () => properties.invalidate(),
  editComponent,
  runtimeReady: () => simulation.runtime?.status === 'ready' && !simulation.invalidated,
  running: () => simulation.runtime?.running === true,
});
const editing = createNetworkEditing({
  editor: () => editor,
  canvas,
  fileBusy: () => files.busy,
  mutate,
  render,
  uid,
  toast,
  diagnostics: (items) => feedback.show(items),
});
const properties = createNetworkProperties({ editor: () => editor, canvas, feedback, mutate, render, toast });
const shortcutParameters = createNetworkShortcutParameters({
  editor: () => editor,
  canvas,
  apply: properties.applyFields,
  lock: properties.lockField,
  notify: toast,
});
const controllers = createNetworkControllers({
  editor: () => editor,
  simulation,
  apply: (project) => mutate(project, false),
});
const valveLibrary = createValveLibrary(toast);
const probes = createNetworkProbes({
  editor: () => editor,
  canvas,
  simulation,
  apply: (project) => mutate(project, false),
  uid: () => uid('probe'),
  toast,
});
const texts = createNetworkTexts({
  editor: () => editor,
  canvas,
  apply: (project) => mutate(project, false),
  uid: () => uid('text'),
  toast,
});
const valveSettings = createNetworkValveSettings({
  editor: () => editor,
  canEdit: () => !simulation.runtime?.running && !simulation.pendingOperations && !files.busy,
  mutate,
  toast,
  presets: valveLibrary,
  uid: () => uid('valve'),
  placement: () => canvas.placement(),
  selected: (id) => {
    canvas.select([{ kind: 'component', id }]);
    render();
  },
});
const results = createNetworkResults({
  editor: () => editor,
  canvas,
  simulation,
  failed: currentRuntimeFailure,
  diagnostics: (items) => feedback.show(items),
});
const files = createNetworkFiles({
  pressureBands: () => pressureSettings.bands,
  exportDirectory: () => appSettings.exportDirectory,
  editor: () => editor,
  draft,
  uid,
  context,
  adopt,
  render,
  toast,
  operation: () => feedback.operation,
  clearDiagnostics: () => feedback.clear(),
  diagnostics: (items, source, document) => feedback.show(items, source, document),
  objectForDiagnostic: feedback.objectFor,
  renderFeedback: feedback.render,
  stateForCapture: simulation.stateForCapture,
  refreshRecords: simulation.refreshRecords,
  checkpointCurve,
  archiveDiagnostics: feedback.archiveDiagnostics,
});
const captureForExport = async () => {
  let captured: Awaited<ReturnType<typeof simulation.refreshRecords>> = null;
  await simulation.enqueue(async () => {
    if (await simulation.stateForCapture()) captured = await simulation.refreshRecords();
  }, 'capture');
  return captured;
};
const recovery = createNetworkRecovery({
  editor: () => editor,
  preferences: appSettings.recovery,
  restore: async (document) => {
    let restored = false;
    await simulation.enqueue(async () => {
      restored = await files.restoreRecovery(document);
    });
    return restored;
  },
  toast,
});
const curvePreview = createNetworkCurvePreview({
  capture: () => simulation.capture,
  refresh: captureForExport,
  running: () => !simulation.invalidated && simulation.runtime?.running === true,
});
const throttleControl = createNetworkThrottleControl({
  regulators: () => simulation.runtime?.flowRegulators ?? [],
  editor: () => editor,
  point: () => simulation.runtime?.point ?? null,
  send: (changes, target) => simulation.applyControl(changes, target),
});
const formalExport = createNetworkFormalExport({
  editor: () => editor,
  exportDefaults: appSettings.exportDefaults,
  capture: captureForExport,
  write: (artifact, category, destination, observe) => files.writeArtifact(artifact, category, destination, observe),
  uid,
});
const curveTools = createNetworkCurveTools({
  editor: () => editor,
  exportDefaults: appSettings.exportDefaults,
  initialRangeSeconds: appSettings.curveRangeSeconds,
  preferredTarget: curvePreview.target,
  history: (projectId) => curveHistory.list(projectId),
  capture: async (source) => {
    let captured: Awaited<ReturnType<typeof simulation.refreshRecords>> = null;
    await simulation.enqueue(async () => {
      if (simulation.runtime?.status === 'ready') captured = await simulation.refreshRecords(source);
    }, 'capture');
    return captured;
  },
  write: (artifact, category, destination) => files.writeArtifact(artifact, category, destination),
});
const sizing = createNetworkSizing({
  exportCatalog: formalExport.openCatalog,
  exportWord: formalExport.openBook,
  applyDuty: (preview) => commitEdit(() => applyNetworkDuty(editor, preview)),
  applyGoal: (preview, index) => commitEdit(() => applyNetworkGoal(editor, preview, index)),
  editor: () => editor,
  apply: (preview) => commitEdit(() => applyNetworkSizing(editor, preview)),
  diagnostics: (items) => feedback.show(items, '基础初选'),
  exportArtifact: (artifact) => files.writeArtifact(artifact),
  uid,
});
const duty = createNetworkDuty({
  exportCatalog: formalExport.openCatalog,
  exportWord: formalExport.openBook,
  editor: () => editor,
  apply: (preview) => commitEdit(() => applyNetworkDuty(editor, preview)),
  applyGoal: (preview, index) => commitEdit(() => applyNetworkGoal(editor, preview, index)),
  diagnostics: (items) => feedback.show(items, '工况初选'),
  exportArtifact: (artifact) => files.writeArtifact(artifact),
  uid,
});
const shortcutPanels = createNetworkShortcutPanels({
  editor: () => editor,
  canvas,
  simulation,
  refresh: captureForExport,
  notify: toast,
});
const layout = createNetworkLayout({
  editor: () => editor,
  canvas,
  apply: (preview) => commitEdit(() => applyNetworkLayout(editor, preview)),
  diagnostics: (items) => feedback.show(items, '元件与管线整理'),
  notify: toast,
});
const externalTools = createNetworkTools({
  settings: appSettings,
  canvas,
  showDiagnostics: (items, source) => feedback.show(items, source),
  history: (projectId) => curveHistory.list(projectId),
  files,
  formalExport,
  recovery,
  editor: () => editor,
  runtime: simulation,
  diagnostics: () => feedback.toolDiagnostics(),
  diagnosticView: feedback.diagnosticView,
  commit: (action) => {
    const changed = commitEdit(action);
    if (changed) {
      canvas.select([]);
      properties.invalidate();
      render();
    }
    return changed;
  },
  uid,
});
function adopt(next: NetworkDraftSession): void {
  editor = next;
  simulation.reset();
  canvas.reset();
  properties.invalidate();
  feedback.clear();
  $('exportStatus').textContent = '';
  render();
}

function draft(): NetworkProject {
  const created = createNetworkDraft(context());
  if (!created.ok) throw new Error(created.diagnostics.map((d) => d.message).join('；'));
  return created.value;
}
function definitionFor(typeId: string) {
  return eligible.find((d) => d.typeId === typeId && (typeId !== 'valve' || d.id === 'teaching:valve-o'));
}

function mutate(candidate: unknown, physical = true): boolean {
  return commitEdit(() => editor.commit(candidate, editor.revision, physical ? 'physical' : 'layout'));
}
function commitEdit(action: () => Result<true>): boolean {
  const before = editor.document,
    previousPhysics = editor.physicsRevision;
  const changed = action();
  if (!changed.ok) {
    feedback.show(changed.diagnostics);
    return false;
  }
  if (editor.document === before) return true;
  if (editor.physicsRevision !== previousPhysics) {
    feedback.clear();
    simulation.retirePhysics();
  } else if (controllerConfiguration(before) !== controllerConfiguration(editor.document))
    void simulation.controllerAction('sequence-stop');
  if (JSON.stringify(before.layout.viewport) !== JSON.stringify(editor.document.layout.viewport)) canvas.loadViewport();
  render();
  return true;
}
function controllerConfiguration(project: NetworkProject): string {
  return JSON.stringify([
    project.controlProbes,
    project.design.components
      .filter((c) => c.typeId === 'dynamic-controller')
      .map((c) => ({ id: c.id, label: c.label, controller: c.controller })),
  ]);
}

function currentRuntimeFailure(): boolean {
  return (
    !!simulation.error ||
    (simulation.runtime?.status === 'failed' &&
      simulation.runtime?.identity?.documentSessionId === editor.documentSessionId &&
      simulation.runtime?.identity?.physicsRevision === editor.physicsRevision)
  );
}

function addComponent(reference: string, position?: { readonly x: number; readonly y: number }): boolean {
  if (files.busy || !canvas.editable) {
    toast('请先完成或取消当前操作，再放置元件。');
    return false;
  }
  if (reference === 'instrument:pressure-gauge') {
    void probes.add(position ?? canvas.placement());
    return true;
  }
  if (reference === 'assembly:pilot-lock-pair') {
    const componentIds = [uid('pilotcheck'), uid('pilotcheck')];
    const plan = planNetworkPilotLockPair(editor.document, {
      componentIds,
      connectionIds: [uid('pilotline'), uid('pilotline')],
      ...(position ?? canvas.placement()),
    });
    if (!plan.ok) {
      feedback.show(plan.diagnostics);
      return false;
    }
    if (!mutate(plan.value.document)) return false;
    canvas.select(componentIds.map((id) => ({ kind: 'component', id })));
    render();
    toast('已放置两阀与交叉先导线，可一次撤销；四个主通路口须接实际回路。');
    return true;
  }
  if (reference === 'teaching:directional-3-4') {
    valveSettings.openNew(position);
    return false;
  }
  const preset = valveLibrary.find(reference);
  const def = preset
    ? networkDefinition(preset.component.definition.id, preset.component.definition.version)
    : (eligible.find((d) => d.id === reference) ?? definitionFor(reference));
  if (!def) {
    toast('元件定义未注册或不可创建。');
    return false;
  }
  const typeId = def.typeId;
  const controllerDefaults = def.role === 'controller' ? nextNetworkController(editor.document) : null;
  const parameters = networkCreationParameters(def, editor.document.design.fluid.densityKgPerM3);
  const id = uid(typeId),
    n = editor.document.design.components.length;
  const component: NetworkProject['design']['components'][number] = {
    id,
    typeId,
    definition: { id: def.id, version: def.version },
    model: { id: def.model.id, version: def.model.version },
    ...(controllerDefaults ? { controllerColor: controllerDefaults.color } : {}),
    label: controllerDefaults
      ? controllerDefaults.name
      : preset
        ? uniqueValveName(
            directionalValveBaseName(preset.component, preset.name),
            editor.document.design.components.map((item) => item.label),
          )
        : `${componentDisplayName(typeId, def.id)} ${n + 1}`,
    ...(preset?.component.valveActuation ? { valveActuation: preset.component.valveActuation } : {}),
    parameters: preset?.component.parameters ?? parameters,
  };
  const createdInitial = networkInitialFor(component);
  if (!createdInitial.ok) {
    feedback.show(createdInitial.diagnostics);
    return false;
  }
  const initial = preset
    ? { componentId: id, kind: 'valve', positionId: preset.initialPosition }
    : createdInitial.value;
  const placement = position ?? canvas.placement();
  if (typeId === 'flow-meter') {
    const candidate = {
      ...editor.document,
      design: { ...editor.document.design, components: [...editor.document.design.components, component] },
      layout: {
        ...editor.document.layout,
        components: [...editor.document.layout.components, { componentId: id, ...placement }],
      },
    };
    const plan = planNetworkFlowMeterInsertion(candidate, {
      componentId: id,
      connectionId: uid('meterline'),
      tolerance: 16,
    });
    if (!plan.ok) {
      feedback.show(plan.diagnostics);
      return false;
    }
    if (!mutate(plan.value.document)) return false;
    canvas.select([{ kind: 'component', id }]);
    render();
    toast(
      plan.value.inserted
        ? '流量计已串入管线，A到B为正；两端连接可一次撤销。'
        : '流量计已放置；可拖到独立直线段自动接入，或手动连接A、B口。',
    );
    return true;
  }
  if (
    !Number.isFinite(placement.x) ||
    !Number.isFinite(placement.y) ||
    Math.abs(placement.x) > 1e6 ||
    Math.abs(placement.y) > 1e6
  ) {
    toast('放置位置超出绘图范围，未创建元件。');
    return false;
  }
  if (
    !commitEdit(() =>
      editor.addComponent(component, initial, placement, def.role === 'controller' ? 'layout' : 'physical'),
    )
  )
    return false;
  canvas.select([{ kind: 'component', id }]);
  render();
  return true;
}

function addNode() {
  const id = uid('node'),
    i = editor.document.design.nodes.length;
  mutate({
    ...editor.document,
    updatedAt: new Date().toISOString(),
    design: {
      ...editor.document.design,
      nodes: [...editor.document.design.nodes, { id, kind: 'ideal-hydraulic', label: `分支节点 ${i + 1}` }],
    },
    layout: {
      ...editor.document.layout,
      nodes: [
        ...editor.document.layout.nodes,
        { nodeId: id, x: 540 + (i % 3) * 180, y: 390 + Math.floor(i / 3) * 100 },
      ],
    },
  });
  canvas.select([{ kind: 'node', id }]);
  render();
}

let runtimeRenderFrame = 0;
function queueRuntimeRender(): void {
  if (!runtimeRenderFrame)
    runtimeRenderFrame = requestAnimationFrame(() => {
      runtimeRenderFrame = 0;
      render();
    });
}
function render() {
  cancelAnimationFrame(runtimeRenderFrame);
  runtimeRenderFrame = 0;
  valveSettings.invalidateIfChanged();
  throttleControl.invalidateIfChanged();
  curveTools.invalidateIfChanged();
  formalExport.invalidateIfChanged();
  setText($('titleLabel'), files.displayName);
  if ($('titleLabel').title !== files.displayName) $('titleLabel').title = files.displayName;
  const title = `${files.displayName} · 液压进阶工作台`;
  if (document.title !== title) document.title = title;
  setText($('dirty'), editor.dirty ? '未保存' : '已保存');
  recovery.observe();
  setText(
    $('connectionCount'),
    `${editor.document.design.components.length} 个元件 · ${editor.document.design.nodes.length} 个分支节点 · ${editor.document.design.connections.length} 条连接`,
  );
  feedback.render();
  instanceControls.render();
  controllers.render();
  probes.render();
  texts.render();
  results.renderStepOptions();
  properties.render();
  shortcutParameters.render();
  sizing.render();
  duty.render();
  layout.render();
  externalTools.render();
  curvePreview.render();
  results.renderRecords();
  canvas.draw();
  editing.render();
  results.renderResults();
  shortcutPanels.render();
  ($('undo') as HTMLButtonElement).disabled = editor.undoCount === 0;
  ($('redo') as HTMLButtonElement).disabled = editor.redoCount === 0;
  const exportCsvButton = $('exportCsv') as HTMLButtonElement;
  exportCsvButton.disabled = !$('identity').textContent?.startsWith('工程会话');
  $('exportLearning').toggleAttribute('disabled', exportCsvButton.disabled);
}

function undoRedo(back: boolean): void {
  const before = editor.physicsRevision,
    viewport = JSON.stringify(editor.document.layout.viewport),
    configuration = controllerConfiguration(editor.document);
  if (!(back ? editor.undo() : editor.redo())) return;
  canvas.select([]);
  if (editor.physicsRevision !== before) simulation.retirePhysics();
  else if (configuration !== controllerConfiguration(editor.document))
    void simulation.controllerAction('sequence-stop');
  if (viewport !== JSON.stringify(editor.document.layout.viewport)) canvas.loadViewport();
  render();
}

function setup() {
  for (const [id, controller] of [
    ['sizingTools', sizing],
    ['dutyTools', duty],
  ] as const) {
    const dialog = $(id);
    if (!(dialog instanceof HTMLDialogElement)) throw new Error('Calculation must be a dialog');
    $('close-' + id).addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => controller.invalidate());
  }
  pressureSettings.setup();
  controllers.setup();
  probes.setup();
  texts.setup();
  canvas.setup();
  editing.setup();
  setupNetworkShell();
  feedback.connectDiagnosticPanel(setupNetworkDiagnosticPanel(feedback.diagnosticView, toast, canvas.locateDiagnostic));
  setupNetworkRouteMenu(canvas, render);
  setupNetworkComponentMenu(canvas, {
    editor: () => editor,
    changed: render,
    properties: editComponent,
    rotate: editing.rotate,
    flip: editing.flip,
    copy: editing.copy,
    paste: editing.paste,
    canPaste: editing.canPaste,
    toast,
  });
  $('propertiesDialog').addEventListener('close', properties.closeDialog);
  setupNetworkWorkspace(eligible, addComponent, toast, valveLibrary);
  statusPanels = setupNetworkStatusPanels({
    pipePinned: (value) => canvas.setPipeReadoutPinned(value),
    changed: render,
    notify: toast,
  });
  setupNetworkWhiteInterface();
  setupNetworkLibraryDrag({
    editor: () => editor,
    canvas,
    fileBusy: () => files.busy,
    add: addComponent,
    toast,
    preview: (reference) =>
      libraryComponentPreview(reference, eligible, valveLibrary.entries, editor.document.design.fluid.densityKgPerM3),
  });
  $('newProject').addEventListener('click', () => void simulation.enqueue(files.fresh));
  $('openProject').addEventListener('click', () => void simulation.enqueue(files.open));
  $('saveProject').addEventListener('click', () => void files.save(false));
  $('saveAs').addEventListener('click', () => void files.save(true));
  $('addNode').addEventListener('click', addNode);
  $('deleteSelected').addEventListener('click', canvas.removeSelected);
  $('undo').addEventListener('click', () => undoRedo(true));
  $('redo').addEventListener('click', () => undoRedo(false));
  $('recoverRun').addEventListener('click', () => void simulation.enqueue(simulation.recover));
  for (const action of ['run', 'pause', 'step', 'reset'] as const)
    $(action).addEventListener('click', () => void simulation.enqueue(() => simulation.operateSimulation(action)));
  $('exportCsv').addEventListener('click', () => void simulation.enqueue(() => files.makeExport('csv'), 'capture'));
  $('exportLearning').addEventListener(
    'click',
    () => void simulation.enqueue(() => files.makeExport('learning'), 'capture'),
  );
  $('exportCsvElsewhere').addEventListener(
    'click',
    () => void simulation.enqueue(() => files.makeExport('csv', 'external'), 'capture'),
  );
  $('archiveDiagnostics').addEventListener('click', () => void files.archiveDiagnostics());
  $('exportHistory').addEventListener(
    'change',
    () =>
      void simulation.enqueue(async () => {
        await simulation.refreshRecords();
      }, 'capture'),
  );
  $('resultScope').addEventListener('change', () => results.renderResults());
  $('nativeStep').addEventListener('change', () => {
    const value = ($('nativeStep') as HTMLSelectElement).value,
      step = Number(value);
    if (value !== 'auto' && !isNetworkNativeStepS(step)) return;
    const preference =
      value === 'auto'
        ? { version: 1, mode: 'auto', manualStepS: null }
        : { version: 1, mode: 'manual', manualStepS: step };
    feedback.clear();
    mutate(
      {
        ...editor.document,
        updatedAt: new Date().toISOString(),
        extensions: { ...editor.document.extensions, [networkStepPreferenceKey]: preference },
      },
      false,
    );
  });
  $('reinitializeStep').addEventListener(
    'click',
    () =>
      void simulation.enqueue(async () => {
        feedback.clear();
        if (await simulation.initialize()) await simulation.refreshRecords();
      }),
  );
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('[data-close]')) $('openDialog').hidePopover?.();
  });
  window.networkFiles.onCloseRequested(() => {
    void simulation.enqueue(files.close);
  });
}
editor = session(draft(), uid('session'));
const startupEditor = editor;
canvas.loadViewport();
setup();
void files
  .activate(editor.document, editor.documentSessionId)
  .then(async () => {
    render();
    if (await window.networkFiles.hasStartupProject()) {
      await simulation.enqueue(() => files.open(editor === startupEditor ? 'startup' : 'interactive'));
      if (editor.document.design.components.length > 0) $('fitAll').click();
    }
  })
  .catch((cause) => {
    render();
    feedback.show([{ code: 'DRAFT_ACTIVATE_FAILED', message: String(cause) }]);
  });
