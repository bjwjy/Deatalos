import { findMesh, meshPoint, reportMesh } from './network-duty-return-mesh.js';
import type { ReturnAccessoryResult } from './network-duty-return-pipes.js';
import { diagnostic, type NetworkProject, type Result } from '@hyd/domain';
import type { DutyPhasePaths } from './network-duty-accessories.js';
import {
  pipeParameters,
  reportReturnPipe,
  returnPipeLoss,
  type ReturnPipeLaw,
  type ReturnPipeResult,
} from './network-duty-return-pipes.js';

interface Arm {
  readonly law: ReturnPipeLaw;
  readonly from: string;
  readonly to: string;
}
interface Bridge {
  readonly inlet: string;
  readonly left: string;
  readonly right: string;
  readonly outlet: string;
  readonly upperLeft: Arm;
  readonly lowerLeft: Arm;
  readonly upperRight: Arm;
  readonly lowerRight: Arm;
  readonly cross: Arm;
}
export interface BridgeRow extends ReturnPipeResult {
  readonly role: string;
  readonly from: string;
  readonly to: string;
}

export function findReturnBridge(project: NetworkProject, paths: DutyPhasePaths, tank: string) {
  const old = fivePipeBridge(project, paths, tank);
  if (!old.ok) return old;
  if (old.value) return { ok: true as const, value: old.value };
  return findMesh(project, paths, tank);
}
function fivePipeBridge(project: NetworkProject, paths: DutyPhasePaths, tank: string): Result<Bridge | null> {
  const pipes = project.design.connections.filter((edge) => edge.kind === 'pipe');
  const valves = project.design.components.filter((part) => part.typeId === 'valve');
  const inlet = valves[0]?.id + ':T';
  if (
    pipes.length !== 5 ||
    !valves.length ||
    valves.some((valve) => !paths.idealReachable(inlet, valve.id + ':T')) ||
    paths.idealReachable(inlet, tank) ||
    project.design.components.some(
      (part) => !['pump', 'tank', 'valve', 'cylinder', 'relief', 'volume'].includes(part.typeId),
    )
  )
    return { ok: true, value: null };
  const nodes = [inlet, tank];
  const group = (port: string) => {
    const found = nodes.find((node) => paths.idealReachable(port, node));
    if (found !== undefined) return found;
    nodes.push(port);
    return port;
  };
  const edges = pipes.map((pipe) => {
    const key = (end: typeof pipe.from) =>
      end.kind === 'node' ? 'node:' + end.nodeId : end.componentId + ':' + end.portId;
    return { pipe, from: group(key(pipe.from)), to: group(key(pipe.to)) };
  });
  const trace = (a: string, b: string) =>
    edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
  const [left, right] = nodes.slice(2).sort();
  if (nodes.length !== 4 || !left || !right) return { ok: true, value: null };
  const arms: Arm[] = [];
  for (const [from, to] of [
    [inlet, left],
    [left, tank],
    [inlet, right],
    [right, tank],
    [left, right],
  ] as const) {
    const edge = trace(from, to);
    if (!edge) return { ok: true, value: null };
    const parsed = pipeParameters(project, edge.pipe, '桥式回油管');
    if (!parsed.ok) return parsed;
    arms.push({ law: parsed.value, from, to });
  }
  const [upperLeft, lowerLeft, upperRight, lowerRight, cross] = arms;
  if (!upperLeft || !lowerLeft || !upperRight || !lowerRight || !cross) return { ok: true, value: null };
  return { ok: true, value: { inlet, outlet: tank, left, right, upperLeft, lowerLeft, upperRight, lowerRight, cross } };
}

// Monotone nodal residual in Pa. Keep the root bracket even when turbulent friction changes regime.
function balance(lo: number, hi: number, residual: (q: number) => number): number {
  if (lo < 0 && hi > 0 && Math.abs(residual(0)) < 1e-9) return 0;
  let low = residual(lo),
    high = residual(hi);
  if (Math.abs(low) < 1e-9) return lo;
  if (Math.abs(high) < 1e-9) return hi;
  for (let i = 0; i < 52; i++) {
    const fraction = -low / (high - low);
    const q = lo + (hi - lo) * (fraction > 0.08 && fraction < 0.92 ? fraction : 0.5);
    const error = residual(q);
    if (Math.abs(error) < 1e-9) return q;
    if (error < 0) {
      lo = q;
      low = error;
    } else {
      hi = q;
      high = error;
    }
  }
  return (lo + hi) / 2;
}

type Mesh = Parameters<typeof meshPoint>[0];
export function bridgePoint(bridge: Bridge | Mesh, total: number) {
  return 'cycles' in bridge ? { inletPa: meshPoint(bridge, total)?.head ?? NaN } : fivePoint(bridge, total);
}
function fivePoint(bridge: Bridge, total: number) {
  const drop = (arm: Arm, q: number) => Math.sign(q) * returnPipeLoss(arm.law, Math.abs(q)).pressureDropPa;
  // x enters the left arm, y crosses left to right. Both midpoint balances hold by construction.
  const split = (x: number) => {
    const y = balance(
      x - total,
      x,
      (y) => drop(bridge.cross, y) - drop(bridge.lowerLeft, x - y) + drop(bridge.lowerRight, total - x + y),
    );
    const leftPa = drop(bridge.lowerLeft, x - y);
    const rightPa = drop(bridge.lowerRight, total - x + y);
    return {
      x,
      y,
      leftPa,
      rightPa,
      inletPa: leftPa + drop(bridge.upperLeft, x),
      otherPa: rightPa + drop(bridge.upperRight, total - x),
    };
  };
  const x = balance(0, total, (x) => {
    const point = split(x);
    return point.inletPa - point.otherPa;
  });
  return split(x);
}

export function reportBridge(
  bridge: Bridge | Mesh,
  total: number,
  tankPa: number,
): Result<{ dropPa: number; rows: readonly BridgeRow[]; accessories?: readonly ReturnAccessoryResult[] }> {
  if ('cycles' in bridge) return reportMesh(bridge, total, tankPa);
  const p = fivePoint(bridge, total);
  const crossDrop = Math.sign(p.y) * returnPipeLoss(bridge.cross.law, Math.abs(p.y)).pressureDropPa;
  if (
    !Number.isFinite(p.inletPa) ||
    Math.max(Math.abs(p.inletPa - p.otherPa), Math.abs(p.leftPa - p.rightPa - crossDrop)) >
      Math.max(1, p.inletPa) * 1e-8
  )
    return {
      ok: false,
      diagnostics: [diagnostic('DUTY_UNSUPPORTED', '/duty/return-bridge', '桥路节点压差残差超限。')],
    };
  const rows: BridgeRow[] = [];
  for (const [arm, q, end, role] of [
    [bridge.upperLeft, p.x, p.leftPa, '上游桥臂'],
    [bridge.lowerLeft, p.x - p.y, 0, '下游桥臂'],
    [bridge.upperRight, total - p.x, p.rightPa, '上游桥臂'],
    [bridge.lowerRight, total - p.x + p.y, 0, '下游桥臂'],
    [bridge.cross, p.y, Math.min(p.leftPa, p.rightPa), '横接管'],
  ] as const) {
    const report = reportReturnPipe(arm.law, Math.abs(q), tankPa + end, role);
    if (!report.ok) return report;
    rows.push({ ...report.value, role, from: q < 0 ? arm.to : arm.from, to: q < 0 ? arm.from : arm.to });
  }
  return { ok: true, value: { dropPa: p.inletPa, rows } };
}
