import {
  immutable,
  checkNetworkParameterRules,
  networkCreationDefinitions,
  networkCreationParameters,
  networkInitialFor,
  prepareNetworkStepRun,
  type DisplayDiagnostic,
  type NetworkIdentity,
  type NetworkProject,
  type Result,
} from '@hyd/domain';
import { compileHopsan } from '@hyd/engine';
import { networkResultView, networkSelectionPolicy, type CalculationRecord } from '@hyd/engineering';
import type { NetworkDraftSession } from './network-draft.js';
import { networkToolCalculate } from './network-tool-calculation.js';
import type { NetworkRuntimeView } from './network-services.js';
import { parseNetworkRecordPage } from './network-export.js';
import { parseNetworkControlRecordPage } from './network-control-records.js';
import { sameNetworkIdentity, type RecordSelection } from './network-records.js';
import { planNetworkToolCommands, networkToolChanges, type NetworkToolEditPlan } from './network-tool-commands.js';
import { networkToolSelectionNotes } from './network-tool-selection.js';
import {
  toolFailure,
  networkToolCollections,
  networkToolRequestSchema,
  type NetworkToolBase,
  type NetworkToolBookSelection,
  type NetworkToolRequest,
} from './network-tool-protocol.js';
import { previewNetworkCatalog, type NetworkCatalogPreview } from './network-catalog.js';
import { networkToolParameterRows } from './network-tool-parameters.js';

export interface NetworkToolSource {
  readonly runtime: NetworkRuntimeView | null;
  readonly diagnostics: readonly DisplayDiagnostic[];
  readonly diagnosticSnapshot?: NetworkToolDiagnosticSnapshot;
}
export interface NetworkToolDiagnosticSnapshot {
  readonly state: 'current' | 'historical-only' | 'checked-clear' | 'not-checked';
  readonly currentBatchId: number | null;
  readonly batches: readonly {
    readonly id: number;
    readonly source: string;
    readonly physicsRevision: number;
    readonly run: string | null;
    readonly tick: number | null;
    readonly rowCount: number;
    readonly rows: readonly {
      readonly rowIndex?: number;
      readonly locatable?: boolean;
      readonly code: string;
      readonly field: string;
      readonly severity: string;
      readonly object: string;
      readonly headline: string;
      readonly fact: string;
      readonly next: string;
      readonly raw: string;
    }[];
  }[];
}
interface Capture {
  readonly id: string;
  readonly base: NetworkToolBase;
  readonly document: NetworkProject;
  readonly source: NetworkToolSource;
}
export interface NetworkToolProposal {
  readonly id: string;
  readonly base: NetworkToolBase;
  readonly operation: 'edit' | 'undo' | 'redo';
  readonly category: 'diagram' | 'calculation';
  readonly physical: boolean;
  readonly state: 'pending' | 'applied' | 'cancelled' | 'stale';
  readonly plan: NetworkToolEditPlan | null;
  readonly validation: Result<true>;
  readonly changes: NetworkToolEditPlan['changes'];
}
export interface NetworkToolPort {
  records(
    expected: NetworkIdentity,
    selection: RecordSelection,
    kind: 'samples' | 'controls',
  ): Promise<Result<unknown>>;
}
function runtimeFor(session: NetworkDraftSession, source: NetworkToolSource): NetworkRuntimeView | null {
  const runtime = source.runtime;
  return runtime?.status === 'ready' &&
    runtime.documentSessionId === session.documentSessionId &&
    runtime.physicsRevision === session.physicsRevision
    ? runtime
    : null;
}
export function networkToolBase(session: NetworkDraftSession, source: NetworkToolSource): NetworkToolBase {
  return {
    documentSessionId: session.documentSessionId,
    revision: session.revision,
    physicsRevision: session.physicsRevision,
    runtimeIdentity: runtimeFor(session, source)?.identity ?? null,
  };
}
function sameBase(a: NetworkToolBase, b: NetworkToolBase, run = true): boolean {
  return (
    a.documentSessionId === b.documentSessionId &&
    a.revision === b.revision &&
    a.physicsRevision === b.physicsRevision &&
    (!run ||
      (a.runtimeIdentity === null
        ? b.runtimeIdentity === null
        : b.runtimeIdentity !== null && sameNetworkIdentity(a.runtimeIdentity, b.runtimeIdentity)))
  );
}
function runnable(document: NetworkProject): Result<true> {
  const prepared = prepareNetworkStepRun(document);
  if (!prepared.ok) return prepared;
  const mapped = compileHopsan(prepared.value.document, {
    nativeStepS: prepared.value.nativeStepS,
    junctionPolicy: 'tlm-limit',
    initialPressurePa: 1e5,
    volumeScale: 1,
    constraintPressureTolerancePa: 0.02,
  });
  return mapped.ok ? { ok: true, value: true } : mapped;
}
/** Owns bounded immutable read captures/proposals only. Engineering/history remain in NetworkDraftSession. */
export class NetworkTools {
  #captures = new Map<string, Capture>();
  #calculationSequence = 0;
  #calculations = new Map<
    string,
    {
      readonly base: NetworkToolBase;
      readonly records: readonly { readonly selection: NetworkToolBookSelection; readonly record: CalculationRecord }[];
      readonly catalog: NetworkCatalogPreview | null;
    }
  >();
  #pending = new Map<NetworkToolProposal['category'], NetworkToolProposal>();
  #past = new Map<
    string,
    { readonly proposalId: string; readonly state: NetworkToolProposal['state']; readonly base: NetworkToolBase }
  >();
  clear(): void {
    this.#captures.clear();
    this.#calculations.clear();
    this.#pending.clear();
    this.#past.clear();
  }
  get pending(): NetworkToolProposal | null {
    return this.pendingProposals.at(-1) ?? null;
  }
  get pendingProposals(): readonly NetworkToolProposal[] {
    return [...this.#pending.values()];
  }
  capabilities() {
    return immutable({
      protocol: 'HydraulicTools',
      requestSchema: networkToolRequestSchema,
      version: 1,
      transport: 'HTTP POST /tools on manually enabled 127.0.0.1 ephemeral port',
      permissions: ['read', 'propose'],
      selectionPolicy: networkSelectionPolicy,
      workflow: {
        defaultIntent:
          'In this project, draw/add/rewire/change parameters means propose an editable workbench change. Export PDF/image only on explicit request. Explanation alone does not authorize edits.',
        sequence: ['capture', 'read project/catalog', 'preview', 'proposal by id', 'user confirmation in workbench'],
        completion:
          'Report submitted only after successful preview and matching pending proposal. Report applied only after user acceptance and a fresh capture. Connection failures are not permission to substitute a PDF.',
        identity:
          'Use the current live capture including unsaved changes. Never choose another project/window or reuse a stale base.',
        existingDesign:
          'Check existing components and connections before planning. If the requested circuit already exists, explain it; ask before adding another parallel branch, replacing it or creating a separate circuit. Do not invent changes solely to produce a proposal.',
        readParameters:
          'Every read needs captureId, collection, offset, limit and simulationSessionId. Use simulationSessionId:null for all collections except samples/controls; a runtime id in capture.base is not a selector for design pages.',
        parameterRules:
          'Observe parameter rows locked/minimum/maximum and component.parameterRules. Do not change locked values or exceed saved ranges. Only a local user may change rules; do not remove a locked component to bypass them.',
        engineeringDesign:
          'For ordinary direct-drive tasks default linear motion to cylinders and rotation to motors, without repeatedly asking for an unspecified mechanism. Respect explicit linkages, existing actuators and model limitations as exceptions. Trace source requirements to actuator/control branches and parameter provenance. Catalog selection notes do not certify a design; creation defaults are not calculated task results.',
        delivery:
          'A candidate with failed runtimeValidation, including GRAPH_INCOMPLETE, is an incomplete draft, not a completed runnable circuit. Separate requirement coverage, static checks, actual rendered layout, simulation evidence and user acceptance. Do not ask the user to accept an incomplete draft merely to work around command limits.',
      },
      fileWorkflow:
        'file_prepare only opens confirmation; reuse operationKey for retries. Poll file_status for saves/exports. For save-as and kind:project (open/new/import/restore), poll hydraulic_project_status after target retirement. Project completed requires adopted:true; awaiting-adoption is uncertain and must not be retried. New targets inherit no AI/simulation permission. Import/restore are unsaved copies. Recovery IDs come only from recovery_list. Paths are chosen locally; no remote paths. At most 16 operations per connection.',
      confirmation:
        'Only an explicit workbench acceptance can apply/undo/redo. Remote apply always returns CONFIRMATION_REQUIRED.',
      methods: [
        'view_read',
        'view_navigate',
        'diagnose',
        'diagnostic_locate',
        'settings_read',
        'settings_prepare',
        'settings_status',
        'settings_cancel',
        'file_prepare',
        'file_status',
        'file_cancel',
        'recovery_list',
        'capabilities',
        'capture',
        'read',
        'preview',
        'proposal',
        'cancel',
        'simulate',
        'calculate',
        'curve_capture',
        'curve_history',
        'curve_prepare',
        'curve_read',
        'apply',
      ],
      collections: networkToolCollections,
      commands: [
        'viewport',
        'add-component',
        'add-node',
        'move',
        'parameter',
        'project-parameter',
        'initial-parameter',
        'pipe-parameter',
        'connect',
        'remove',
        'route',
        'arrange',
        'rotate',
        'mirror',
        'move-selection',
        'delete-selection',
        'copy-selection',
        'text',
        'probe-edit',
        'controller-program',
        'branch-connect',
        'motor-control',
        'switch-output',
      ],
      limits: {
        requestBytes: 1048576,
        responseBytes: 4194304,
        page: 20,
        commands: 30,
        captures: 2,
        calculations: 8,
        pendingProposal: 2,
        outcomes: 8,
        controlEventsPerRun: 256,
      },
      units: 'All numerical editing values are SI; world layout coordinates never represent physical length.',
      serviceProvider: 'None. No upstream AI HTTP client or credential persistence.',
      unsupported: [
        'arbitrary scripts/files/IPC',
        'unconfirmed file writes, remote paths and unapproved simulation control',
        'external AI provider configuration',
        'multi-client collaboration',
        'complete physical or release certification',
      ],
    });
  }
  capture(session: NetworkDraftSession, source: NetworkToolSource, id: string): Result<unknown> {
    if (!/^[-\w]{1,40}$/.test(id) || this.#captures.has(id))
      return toolFailure('IDENTITY_INVALID', '捕获编号须为新的合法ID。');
    const captured: Capture = immutable({
      id,
      base: networkToolBase(session, source),
      document: session.document,
      source: { ...source, runtime: runtimeFor(session, source) },
    });
    this.#captures.set(id, captured);
    if (this.#captures.size > 2) this.#captures.delete(this.#captures.keys().next().value ?? '');
    return {
      ok: true,
      value: {
        captureId: id,
        base: captured.base,
        recordWindow:
          'Frozen accepted anchor; current live frames may advance. Controls/reset/reinitialization/another capture can retire backend record pages. Expired pages fail, never relabel.',
        currentAvailable: captured.source.runtime !== null,
        running: captured.source.runtime?.running ?? false,
        ...(captured.source.diagnosticSnapshot
          ? {
              diagnosticStatus: {
                state: captured.source.diagnosticSnapshot.state,
                currentBatchId: captured.source.diagnosticSnapshot.currentBatchId,
              },
            }
          : {}),
        pendingProposals: this.pendingProposals
          .filter((proposal) => sameBase(proposal.base, captured.base))
          .map((proposal) => ({
            proposalId: proposal.id,
            category: proposal.category,
            state: proposal.state,
            base: proposal.base,
          })),
      },
    };
  }
  diagnose(
    session: NetworkDraftSession,
    source: NetworkToolSource,
    base: NetworkToolBase,
  ): Result<{
    readonly kind: 'static-run-mapping';
    readonly valid: boolean;
    readonly diagnostics: readonly DisplayDiagnostic[];
  }> {
    if (!sameBase(base, networkToolBase(session, source), false))
      return toolFailure('RESPONSE_STALE', '工程已变化，未检查旧修订。');
    const checked = runnable(session.document);
    return {
      ok: true,
      value: { kind: 'static-run-mapping', valid: checked.ok, diagnostics: checked.ok ? [] : checked.diagnostics },
    };
  }
  calculate(
    session: NetworkDraftSession,
    source: NetworkToolSource,
    params: Extract<NetworkToolRequest, { method: 'calculate' }>['params'],
    context?: { readonly snapshotId: string; readonly capturedAt: string },
  ): Result<unknown> {
    const base = networkToolBase(session, source);
    if (!sameBase(params.base, base)) return toolFailure('RESPONSE_STALE', '工程或运行已改变，请重新捕获后计算。');
    if (this.#calculations.size >= 8)
      return toolFailure('CALCULATION_LIMIT', '本次连接已保留8份计算；请重新连接后继续。');
    if (params.operation === 'catalog' && !context)
      return toolFailure('CATALOG_CONTEXT_REQUIRED', '选型任务需要外层提供冻结编号与捕获时间。');
    const catalog =
      params.operation === 'catalog' && context ? previewNetworkCatalog(session, params.input, context) : null;
    if (catalog && !catalog.ok) return catalog;
    const result = catalog?.ok
      ? {
          ok: true as const,
          value: {
            applied: false as const,
            documentSessionId: session.documentSessionId,
            revision: session.revision,
            physicsRevision: session.physicsRevision,
            operation: 'catalog' as const,
            plan: catalog.value.plan,
            commands: [],
          },
        }
      : networkToolCalculate(session, params.operation, params.input);
    if (!result.ok) return result;
    const value = result.value;
    const records: { selection: NetworkToolBookSelection; record: CalculationRecord }[] = [];
    if (
      value.operation === 'duty-report' ||
      value.operation === 'duty-independent' ||
      value.operation === 'duty-combined'
    )
      records.push({ selection: { kind: 'current' }, record: value.record });
    if (value.operation === 'sizing' || value.operation === 'duty')
      records.push({
        selection: { kind: 'primary' },
        record: immutable({ ...value.plan.record, title: value.plan.record.title + ' · 未应用初选' }),
      });
    if (value.operation === 'goal') {
      records.push({
        selection: { kind: 'current' },
        record: immutable({ ...value.plan.current.record, title: '当前设计 · ' + value.plan.current.record.title }),
      });
      value.plan.alternatives.forEach((candidate, index) =>
        records.push({
          selection: { kind: 'candidate', index },
          record: immutable({
            ...candidate.analysis.record,
            title: '方案 ' + (index + 1) + ' · 未应用 · ' + candidate.analysis.record.title,
          }),
        }),
      );
      if (!value.plan.alternatives.length && value.plan.candidate)
        records.push({
          selection: { kind: 'candidate', index: 0 },
          record: immutable({
            ...value.plan.candidate.record,
            title: '方案 1 · 未应用 · ' + value.plan.candidate.record.title,
          }),
        });
    }
    const calculationId = 'calculation_' + ++this.#calculationSequence;
    this.#calculations.set(calculationId, immutable({ base, records, catalog: catalog?.ok ? catalog.value : null }));
    return {
      ok: true,
      value: {
        base,
        ...value,
        calculationId,
        catalogExport: catalog?.ok
          ? {
              snapshotId: catalog.value.snapshotId,
              capturedAt: catalog.value.capturedAt,
              source: 'current-design',
              formats: ['docx', 'md'],
            }
          : null,
        records: records.map(({ selection, record }) => ({ selection, title: record.title, kind: record.kind })),
      },
    };
  }
  catalogPreview(
    session: NetworkDraftSession,
    source: NetworkToolSource,
    calculationId: string,
  ): Result<NetworkCatalogPreview> {
    const found = this.#calculations.get(calculationId);
    if (!found) return toolFailure('CALCULATION_RETIRED', '计算引用不存在或连接已退役。');
    if (!sameBase(found.base, networkToolBase(session, source), false))
      return toolFailure('RESPONSE_STALE', '选型任务对应工程已变化，请重新计算。');
    if (!found.catalog) return toolFailure('CATALOG_RECORD_UNAVAILABLE', '此计算不是选型任务。');
    if (found.catalog.sourceDocument !== session.document) return toolFailure('RESPONSE_STALE', '选型任务来源已改变。');
    return { ok: true, value: found.catalog };
  }
  calculationRecord(
    session: NetworkDraftSession,
    source: NetworkToolSource,
    calculationId: string,
    selection: NetworkToolBookSelection,
  ): Result<CalculationRecord> {
    const found = this.#calculations.get(calculationId);
    if (!found) return toolFailure('CALCULATION_RETIRED', '计算引用不存在或连接已退役。');
    if (!sameBase(found.base, networkToolBase(session, source), false))
      return toolFailure('RESPONSE_STALE', '计算对应工程已变化，请重新计算。');
    const selected = found.records.find(
      (item) =>
        item.selection.kind === selection.kind &&
        (item.selection.kind !== 'candidate' ||
          (selection.kind === 'candidate' && item.selection.index === selection.index)),
    );
    return selected
      ? { ok: true, value: selected.record }
      : toolFailure('CALCULATION_RECORD_UNAVAILABLE', '所选计算记录不存在；请使用计算返回的记录列表。');
  }
  async read(
    session: NetworkDraftSession,
    source: NetworkToolSource,
    params: Extract<NetworkToolRequest, { method: 'read' }>['params'],
    port: NetworkToolPort,
  ): Promise<Result<unknown>> {
    const capture = this.#captures.get(params.captureId);
    if (!capture) return toolFailure('CAPTURE_RETIRED', '捕获不存在或已淘汰，请重新捕获。');
    if (!sameBase(capture.base, networkToolBase(session, source), false))
      return toolFailure('RESPONSE_STALE', '工程/修订已改变，不能混读旧捕获。');
    const runtime = capture.source.runtime,
      document = capture.document,
      kind = params.collection;
    if (['current', 'runs', 'samples', 'controls'].includes(kind) && capture.base.runtimeIdentity) {
      const live = runtimeFor(session, source)?.identity,
        anchor = capture.base.runtimeIdentity;
      if (
        !live ||
        live.simulationSessionId !== anchor.simulationSessionId ||
        live.controlSequence !== anchor.controlSequence
      )
        return toolFailure('RESPONSE_STALE', '控制、复位、失效或运行替换已退役该运行捕获；请重新捕获。');
    }
    if (kind === 'samples' || kind === 'controls') {
      const expected = capture.base.runtimeIdentity;
      if (!runtime || !expected) return toolFailure('RUNTIME_NOT_READY', '捕获时没有有效运行，记录不是零。');
      const range = { simulationSessionId: params.simulationSessionId, offset: params.offset, limit: params.limit };
      const raw = await port.records(expected, range, kind);
      if (!raw.ok) return raw;
      if (!this.#captures.has(capture.id) || !sameBase(capture.base, networkToolBase(session, source), false))
        return toolFailure('RESPONSE_STALE', '读取期间工程或捕获退役。');
      if (kind === 'samples') {
        const page = parseNetworkRecordPage(raw.value, expected, range);
        return page.ok
          ? { ok: true, value: { captureId: capture.id, base: capture.base, collection: kind, ...page.value } }
          : page;
      }
      const page = parseNetworkControlRecordPage(raw.value, expected, range);
      return page.ok
        ? { ok: true, value: { captureId: capture.id, base: capture.base, collection: kind, ...page.value } }
        : page;
    }
    let data: readonly unknown[] = [];
    const parameterRows = kind === 'parameters' || kind === 'project' ? networkToolParameterRows(document) : [];
    if (kind === 'catalog')
      data = networkCreationDefinitions.map((d) => {
        const parameters = networkCreationParameters(d, document.design.fluid.densityKgPerM3),
          c = {
            id: 'catalog',
            label: 'catalog',
            typeId: d.typeId,
            definition: { id: d.id, version: d.version },
            model: { id: d.model.id, version: d.model.version },
            parameters,
          };
        return {
          definition: d,
          selection: networkToolSelectionNotes(d),
          creationPreset: { parameters, initial: networkInitialFor(c) },
        };
      });
    if (kind === 'project')
      data = [
        {
          projectId: document.projectId,
          title: document.title,
          description: document.description,
          note: document.note ?? null,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
          fluid: document.design.fluid,
          editableParameters: parameterRows.filter((row) => row.target === 'project'),
          pressureReference: document.design.pressureReference,
          provenance: document.provenance,
          extensions: document.extensions,
        },
      ];
    if (kind === 'components') data = document.design.components;
    if (kind === 'probes') data = document.controlProbes ?? [];
    if (kind === 'nodes') data = document.design.nodes;
    if (kind === 'connections') data = document.design.connections;
    if (kind === 'layout') data = [document.layout];
    if (kind === 'parameters')
      data = [
        ...document.design.components.flatMap((c) =>
          Object.entries(c.parameters).map(([group, values]) => ({
            componentId: c.id,
            group,
            values,
            fields: parameterRows.filter((row) => row.target === 'component' && row.id === c.id && row.group === group),
          })),
        ),
        ...document.design.initialConditions.map((i) => ({
          componentId: i.componentId,
          group: 'initial-condition',
          values: i,
          fields: parameterRows.filter((row) => row.target === 'initial' && row.id === i.componentId),
        })),
        ...parameterRows.filter((row) => row.target === 'project' || row.target === 'pipe'),
      ];
    if (kind === 'runs')
      data = runtime
        ? [
            {
              selection: 'current',
              document: runtime.document,
              point: runtime.point,
              record: runtime.point ? { identity: runtime.identity } : null,
            },
            ...runtime.historicalRuns.map((h) => ({
              selection: 'history',
              document: h.document,
              point: h.last,
              record: h.record,
            })),
          ]
        : [];
    if (kind === 'current') {
      if (!runtime?.point) return toolFailure('RUNTIME_NOT_READY', '没有有效当前点；缺量不能补0。');
      const view = networkResultView(runtime.document, runtime.point, runtime.point.identity);
      if (!view.ok) return view;
      data = [
        {
          point: view.value.point,
          quantities: view.value.quantities,
          assumptions: view.value.assumptions,
          runDocument: runtime.document,
        },
      ];
    }
    if (kind === 'diagnostics') data = [...capture.source.diagnostics, ...(runtime?.diagnostics ?? [])];
    if (kind === 'diagnostic-batches') {
      if (!capture.source.diagnosticSnapshot) return toolFailure('RUNTIME_NOT_READY', '本次捕获没有报错卡批次资料。');
      data = capture.source.diagnosticSnapshot.batches;
    }
    if (params.simulationSessionId !== null)
      return toolFailure('TOOL_QUERY_INVALID', '只有samples/controls按simulationSessionId选择历史。');
    if (params.offset > data.length) return toolFailure('RECORD_RANGE_INVALID', '分页偏移越界。');
    const end = Math.min(data.length, params.offset + params.limit);
    return {
      ok: true,
      value: immutable({
        captureId: capture.id,
        base: capture.base,
        collection: kind,
        offset: params.offset,
        count: data.length,
        nextOffset: end < data.length ? end : null,
        items: data.slice(params.offset, end),
      }),
    };
  }
  preview(
    session: NetworkDraftSession,
    source: NetworkToolSource,
    params: Extract<NetworkToolRequest, { method: 'preview' }>['params'],
    id: string,
  ): Result<unknown> {
    if (!/^[-\w]{1,40}$/.test(id) || this.#past.has(id) || this.pendingProposals.some((p) => p.id === id))
      return toolFailure('IDENTITY_INVALID', '候选编号须为新的合法ID。');
    if (runtimeFor(session, source)?.running)
      return toolFailure('RUNTIME_BUSY', '请先在工作台暂停运行，再提出需要确认的编辑；不会自动暂停或修改运行。');
    if (!sameBase(params.base, networkToolBase(session, source)))
      return toolFailure('RESPONSE_STALE', '工程、修订或同tick运行/控制身份已变化，请重新读取。');
    let plan: NetworkToolEditPlan | null = null,
      physical = false,
      document = session.document;
    if (params.operation === 'edit') {
      const planned = planNetworkToolCommands(document, params.commands);
      if (!planned.ok) return planned;
      plan = planned.value;
      physical = plan.physical;
      document = plan.document;
      if (!plan.changes.length) return toolFailure('TOOL_NO_CHANGE', '候选没有实际修改。');
    } else {
      const history = session.previewHistory(params.operation);
      if (!history.ok) return history;
      document = history.value.document;
      physical = history.value.physical;
    }
    const constraints = checkNetworkParameterRules(session.document, document);
    if (!constraints.ok) return constraints;
    const category =
      plan &&
      plan.commands.every((c) =>
        ['parameter', 'project-parameter', 'initial-parameter', 'pipe-parameter'].includes(c.kind),
      )
        ? 'calculation'
        : 'diagram';
    const prior = this.#pending.get(category);
    if (prior) this.#finish(prior.id, 'cancelled');
    const proposal: NetworkToolProposal = immutable({
      id,
      base: params.base,
      operation: params.operation,
      category,
      physical,
      state: 'pending',
      plan,
      changes: networkToolChanges(session.document, document),
      validation: runnable(document),
    });
    this.#pending.set(category, proposal);
    return { ok: true, value: this.#public(proposal) };
  }
  #public(p: NetworkToolProposal) {
    return {
      proposalId: p.id,
      base: p.base,
      operation: p.operation,
      category: p.category,
      state: p.state,
      physical: p.physical,
      changes: p.changes,
      commands: p.plan?.commands ?? [],
      runtimeValidation: p.validation,
      runtimeValidationScope: 'static-mapping-only; no native execution performed',
      confirmationRequired: true,
    };
  }
  proposal(id: string): Result<unknown> {
    const pending = this.pendingProposals.find((p) => p.id === id);
    return pending
      ? { ok: true, value: this.#public(pending) }
      : this.#past.has(id)
        ? { ok: true, value: this.#past.get(id) }
        : toolFailure('PROPOSAL_RETIRED', '候选不存在或已淘汰。');
  }
  #finish(id: string, state: NetworkToolProposal['state']): void {
    const p = this.pendingProposals.find((p) => p.id === id);
    if (!p) return;
    this.#past.set(p.id, { proposalId: p.id, state, base: p.base });
    if (this.#past.size > 8) this.#past.delete(this.#past.keys().next().value ?? '');
    this.#pending.delete(p.category);
  }
  cancel(id: string): Result<true> {
    if (!this.pendingProposals.some((p) => p.id === id)) return toolFailure('PROPOSAL_RETIRED', '候选已退役。');
    this.#finish(id, 'cancelled');
    return { ok: true, value: true };
  }
  invalidate(session: NetworkDraftSession, source: NetworkToolSource): void {
    for (const [id, calculation] of this.#calculations)
      if (!sameBase(calculation.base, networkToolBase(session, source), false)) this.#calculations.delete(id);
    for (const p of this.pendingProposals)
      if (!sameBase(p.base, networkToolBase(session, source))) this.#finish(p.id, 'stale');
  }
  /** UI gesture calls this narrow method; it is deliberately absent from remote dispatch. */
  accept(session: NetworkDraftSession, source: NetworkToolSource, id: string): Result<true> {
    const p = this.pendingProposals.find((p) => p.id === id);
    if (!p || p.id !== id) return toolFailure('PROPOSAL_RETIRED', '候选已退役。');
    if (!sameBase(p.base, networkToolBase(session, source))) {
      this.#finish(id, 'stale');
      return toolFailure('RESPONSE_STALE', '确认时工程/修订/运行身份已改变，请重新预览。');
    }
    let outcome: Result<true>;
    if (p.operation === 'edit' && p.plan) {
      const fresh = planNetworkToolCommands(session.document, p.plan.commands);
      outcome = fresh.ok
        ? session.commit(
            fresh.value.document,
            p.base.revision,
            fresh.value.physical ? 'physical' : 'layout',
            fresh.value.commands.some((command) => command.kind === 'viewport')
              ? 'restore-snapshot'
              : 'preserve-current',
          )
        : fresh;
    } else {
      const history = session.previewHistory(p.operation === 'undo' ? 'undo' : 'redo');
      const constraints = history.ok ? checkNetworkParameterRules(session.document, history.value.document) : history;
      outcome = constraints.ok
        ? (p.operation === 'undo' ? session.undo() : session.redo())
          ? { ok: true, value: true }
          : toolFailure('HISTORY_UNAVAILABLE', '历史已不可用。')
        : constraints;
    }
    this.#finish(id, outcome.ok ? 'applied' : 'stale');
    this.invalidate(session, source);
    return outcome;
  }
}
