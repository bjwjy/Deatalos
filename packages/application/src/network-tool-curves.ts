import { type Result } from '@hyd/domain';
import { sameNetworkIdentity } from './network-records.js';
import { type NetworkExportCapture } from './network-export.js';
import { planNetworkCurve, type CurveRequest, type CurvePlan } from './network-curve-plan.js';
import { toolFailure, type NetworkToolBase } from './network-tool-protocol.js';
import { parseCurveFile, type CurveFile } from './curve-file.js';
import { utf8Bytes } from './export-artifact.js';
import type { OfflineCurve } from './offline-curve.js';

interface CurveReference {
  readonly curveId: string;
  readonly sourceId: string;
  readonly base: NetworkToolBase;
}
export type NetworkToolCurve = CurveReference &
  (
    | { readonly kind: 'run'; readonly capture: NetworkExportCapture; readonly plan: CurvePlan }
    | {
        readonly kind: 'imported';
        readonly file: CurveFile;
        readonly curveIndex: number;
        readonly curve: OfflineCurve;
        readonly samples: OfflineCurve['samples'];
      }
  );
type Source = { readonly base: NetworkToolBase } & (
  | { readonly kind: 'run'; readonly capture: NetworkExportCapture }
  | { readonly kind: 'imported'; readonly file: CurveFile }
);
export interface NetworkToolImportedSource {
  readonly sourceId: string;
  readonly sourceKind: 'imported';
  readonly snapshotId: string;
  readonly identityLevel: CurveFile['identityLevel'];
  readonly curves: readonly {
    readonly curveIndex: number;
    readonly label: string;
    readonly unit: string;
    readonly siUnit: string;
    readonly sampleCount: number;
    readonly fromS: number;
    readonly toS: number;
  }[];
}
const sameDocument = (a: NetworkToolBase, b: NetworkToolBase) =>
  a.documentSessionId === b.documentSessionId && a.revision === b.revision && a.physicsRevision === b.physicsRevision;
/** Frozen, bounded references owned by this connection. No caller-supplied result values are accepted. */
export class NetworkToolCurves {
  private sources = new Map<string, Source>();
  private curves = new Map<string, NetworkToolCurve>();
  #store(sourceId: string, value: Source): void {
    if (!this.sources.has(sourceId) && this.sources.size >= 2) {
      const oldest = this.sources.keys().next().value;
      if (oldest) {
        this.sources.delete(oldest);
        for (const [id, curve] of this.curves) if (curve.sourceId === oldest) this.curves.delete(id);
      }
    }
    this.sources.set(sourceId, value);
  }
  history(base: NetworkToolBase, current: NetworkToolBase, projectId: string, capture: NetworkExportCapture) {
    if (!sameDocument(base, current) || capture.view.document.projectId !== projectId)
      return toolFailure('CURVE_SOURCE_STALE', '历史曲线不属于当前授权工程或工程已变化。');
    const historical: NetworkExportCapture = { ...capture, selection: 'history' };
    this.#store(capture.snapshotId, { kind: 'run', base: current, capture: historical });
    return {
      ok: true as const,
      value: {
        sourceId: capture.snapshotId,
        base: current,
        sourceKind: 'history',
        identity: capture.view.point.identity,
        selection: 'history',
        record: capture.record,
        sampleCount: capture.samples.length,
        fromS: capture.samples[0]?.identity.timeS ?? null,
        toS: capture.samples.at(-1)?.identity.timeS ?? null,
        quantities: capture.view.quantities.map(({ objectKind, objectId, field }) => ({ objectKind, objectId, field })),
      },
    };
  }
  importFile(
    base: NetworkToolBase,
    current: NetworkToolBase,
    input: unknown,
    sourceId: string,
  ): Result<NetworkToolImportedSource> {
    if (!sameDocument(base, current)) return toolFailure('CURVE_SOURCE_STALE', '读取期间工程已变化，未采用曲线文件。');
    if (this.sources.has(sourceId)) return toolFailure('CURVE_ID_CONFLICT', '曲线来源身份重复。');
    const parsed = parseCurveFile(input);
    if (!parsed.ok) return parsed;
    if (utf8Bytes(JSON.stringify(parsed.value)) > 4_000_000)
      return toolFailure('RESOURCE_LIMIT', '曲线文件超过4,000,000字节。');
    this.#store(sourceId, { kind: 'imported', base: current, file: parsed.value });
    return {
      ok: true as const,
      value: {
        sourceId,
        sourceKind: 'imported',
        snapshotId: parsed.value.snapshotId,
        identityLevel: parsed.value.identityLevel,
        curves: parsed.value.curves.map((curve, curveIndex) => ({
          curveIndex,
          label: curve.label,
          unit: curve.unit,
          siUnit: curve.siUnit,
          sampleCount: curve.samples.length,
          fromS: curve.state.fromS,
          toS: curve.state.toS,
        })),
      },
    };
  }
  validateBase(base: NetworkToolBase, current: NetworkToolBase): Result<true> {
    const before = base.runtimeIdentity,
      now = current.runtimeIdentity;
    // An actively running clock may advance between calls; a reset or control change is not the same anchor.
    if (
      !sameDocument(base, current) ||
      (before === null
        ? now !== null
        : !now ||
          before.documentSessionId !== now.documentSessionId ||
          before.physicsRevision !== now.physicsRevision ||
          before.simulationSessionId !== now.simulationSessionId ||
          before.controlSequence !== now.controlSequence ||
          before.tick > now.tick ||
          before.timeS > now.timeS + 1e-9 ||
          before.requestSequence > now.requestSequence)
    )
      return toolFailure('CURVE_SOURCE_STALE', '运行或控制身份已改变，请重新捕获 base。');
    return { ok: true, value: true };
  }
  capture(base: NetworkToolBase, current: NetworkToolBase, capture: NetworkExportCapture) {
    const anchor = this.validateBase(base, current);
    if (!anchor.ok) return anchor;
    if (
      !current.runtimeIdentity ||
      !sameNetworkIdentity(current.runtimeIdentity, capture.sourceIdentity) ||
      !sameNetworkIdentity(capture.sourceIdentity, capture.view.point.identity) ||
      capture.selection !== 'current' ||
      capture.sourceIdentity.documentSessionId !== base.documentSessionId ||
      capture.sourceIdentity.physicsRevision !== base.physicsRevision
    )
      return toolFailure('CURVE_SOURCE_STALE', '曲线来源与当前工程不一致，请重新捕获。');
    const frozenBase = { ...current, runtimeIdentity: capture.sourceIdentity };
    this.#store(capture.snapshotId, { kind: 'run', base: frozenBase, capture });
    return {
      ok: true as const,
      value: {
        sourceId: capture.snapshotId,
        base: frozenBase,
        identity: capture.view.point.identity,
        selection: capture.selection,
        record: capture.record,
        sampleCount: capture.samples.length,
        fromS: capture.samples[0]?.identity.timeS ?? null,
        toS: capture.samples.at(-1)?.identity.timeS ?? null,
        quantities: capture.view.quantities.map((q) => ({
          objectKind: q.objectKind,
          objectId: q.objectId,
          field: q.field,
        })),
      },
    };
  }
  prepare(current: NetworkToolBase, sourceId: string, request: CurveRequest, curveId: string) {
    const source = this.sources.get(sourceId);
    if (!source || source.kind !== 'run' || !sameDocument(source.base, current))
      return toolFailure('CURVE_SOURCE_STALE', '曲线捕获已退役或工程已变化，请重新捕获。');
    if (this.curves.has(curveId)) return toolFailure('CURVE_ID_CONFLICT', '曲线身份重复。');
    const planned = planNetworkCurve(source.capture, request);
    if (!planned.ok) return planned;
    if (this.curves.size >= 8) this.curves.delete(this.curves.keys().next().value ?? '');
    const plan = planned.value;
    this.curves.set(curveId, { kind: 'run', curveId, sourceId, base: source.base, capture: source.capture, plan });
    let minimum: CurvePlan['samples'][number] | null = null,
      maximum: CurvePlan['samples'][number] | null = null;
    for (const sample of plan.samples) {
      if (sample.value === null) continue;
      if (!minimum || sample.value < minimum.value!) minimum = sample;
      if (!maximum || sample.value > maximum.value!) maximum = sample;
    }
    return {
      ok: true as const,
      value: {
        curveId,
        sourceId,
        sourceKind: source.capture.selection === 'history' ? 'history' : 'current',
        base: source.base,
        identity: source.capture.view.point.identity,
        request: plan.request,
        label: plan.label,
        unit: plan.unit,
        siUnit: plan.siUnit,
        sampleCount: plan.samples.length,
        selectedCount: plan.indices.length,
        segmentCount: plan.segments.length,
        mandatoryCount: plan.mandatoryCount,
        maximumError: plan.maximumError,
        minimum,
        maximum,
        metadata: plan.metadata,
        record: source.capture.record,
      },
    };
  }
  selectImported(current: NetworkToolBase, sourceId: string, curveIndex: number, curveId: string) {
    const source = this.sources.get(sourceId);
    if (!source || source.kind !== 'imported' || !sameDocument(source.base, current))
      return toolFailure('CURVE_SOURCE_STALE', '导入曲线已退役或工程已变化。');
    if (!Number.isSafeInteger(curveIndex) || curveIndex < 0)
      return toolFailure('CURVE_RANGE_INVALID', '曲线编号须为非负整数。');
    const curve = source.file.curves[curveIndex];
    if (!curve) return toolFailure('CURVE_RANGE_INVALID', '所选曲线不存在。');
    if (this.curves.has(curveId)) return toolFailure('CURVE_ID_CONFLICT', '曲线身份重复。');
    const samples = curve.samples.filter(
      (sample) => sample.timeS >= curve.state.fromS && sample.timeS <= curve.state.toS,
    );
    if (this.curves.size >= 8) this.curves.delete(this.curves.keys().next().value ?? '');
    this.curves.set(curveId, {
      kind: 'imported',
      curveId,
      sourceId,
      base: source.base,
      file: source.file,
      curveIndex,
      curve,
      samples,
    });
    return {
      ok: true as const,
      value: {
        curveId,
        sourceId,
        sourceKind: 'imported',
        snapshotId: source.file.snapshotId,
        identityLevel: source.file.identityLevel,
        curveIndex,
        label: curve.label,
        unit: curve.unit,
        siUnit: curve.siUnit,
        sampleCount: samples.length,
        segmentCount: Math.max(1, Math.ceil(samples.length / 2000)),
        fromS: curve.state.fromS,
        toS: curve.state.toS,
        metadata: curve.metadata,
        note: 'Imported frozen samples; no current solver result is asserted. Legacy files have no invented sample identities.',
      },
    };
  }
  get(current: NetworkToolBase, curveId: string): Result<NetworkToolCurve> {
    const curve = this.curves.get(curveId);
    if (!curve || !sameDocument(curve.base, current))
      return toolFailure('CURVE_SOURCE_STALE', '曲线结果已退役或工程已变化，请重新捕获。');
    return { ok: true, value: curve };
  }
  read(current: NetworkToolBase, curveId: string, offset: number, limit: number) {
    const found = this.get(current, curveId);
    if (!found.ok) return found;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return toolFailure('CURVE_PAGE_INVALID', '曲线分页范围无效。');
    if (found.value.kind === 'imported') {
      const value = found.value;
      if (offset > value.samples.length) return toolFailure('CURVE_PAGE_INVALID', '曲线偏移越界。');
      const end = Math.min(offset + limit, value.samples.length),
        identities = new Map(value.file.identities.map((item) => [item.index, item.identity]));
      return {
        ok: true as const,
        value: {
          curveId,
          sourceId: value.sourceId,
          sourceKind: 'imported',
          identityLevel: value.file.identityLevel,
          snapshotId: value.file.snapshotId,
          offset,
          nextOffset: end < value.samples.length ? end : null,
          total: value.samples.length,
          unit: value.curve.unit,
          siUnit: value.curve.siUnit,
          samples: value.samples
            .slice(offset, end)
            .map((sample) => ({ ...sample, identity: identities.get(sample.index) ?? null, selectedForExport: true })),
        },
      };
    }
    const { capture, plan } = found.value;
    const end = Math.min(offset + limit, plan.samples.length);
    return {
      ok: true as const,
      value: {
        curveId,
        sourceId: capture.snapshotId,
        sourceKind: capture.selection === 'history' ? 'history' : 'current',
        offset,
        nextOffset: end < plan.samples.length ? end : null,
        total: plan.samples.length,
        unit: plan.unit,
        siUnit: plan.siUnit,
        samples: plan.samples.slice(offset, end).map((sample) => ({
          ...sample,
          identity: capture.samples[sample.index]!.identity,
          selectedForExport: plan.indices.includes(sample.index),
        })),
      },
    };
  }
  retire() {
    this.sources.clear();
    this.curves.clear();
  }
}
