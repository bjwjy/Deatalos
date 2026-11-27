import type { NetworkProject, NetworkSnapshot, Result } from '@hyd/domain';
import { canonical } from './content.js';
import { acceptKernelResponse, type KernelRequest } from './kernel-protocol.js';
import type { KernelPort } from './network-simulation.js';

export interface LowPressureContinuation {
  open(preview: boolean): Promise<Result<KernelPort>>;
  replayAllowed(): boolean;
}

// Preview may add cavity measurements and model notices. Every original physical
// channel, command, state and identity at a retained checkpoint must still agree.
export function samePhysicalPoint(before: NetworkSnapshot, after: NetworkSnapshot): boolean {
  const readings = new Map(
    after.readings.map((r) => [canonical([r.location, r.quantity, r.unit]), canonical(r.value)]),
  );
  const { diagnostics: _oldNotes, readings: oldReadings, ...original } = before;
  const { diagnostics: _newNotes, readings: _allReadings, ...candidate } = after;
  return (
    canonical(original) === canonical(candidate) &&
    oldReadings.every((r) => readings.get(canonical([r.location, r.quantity, r.unit])) === canonical(r.value))
  );
}

export async function continueAtLowPressure(
  policy: LowPressureContinuation,
  project: NetworkProject,
  history: Iterable<KernelRequest>,
  checkpoints: readonly NetworkSnapshot[],
  failedStep: KernelRequest,
  current: () => boolean,
) {
  const opened = await policy.open(true);
  if (!opened.ok) return null;
  const port = opened.value;
  let committed = false;
  try {
    const points = new Map(checkpoints.map((point) => [point.identity.requestSequence, point]));
    for (const request of history) {
      if (!current() || !policy.replayAllowed()) return null;
      const result = await port.execute(request);
      if (!result.ok) return null;
      const checked = acceptKernelResponse(project, result.value, request.identity);
      if (!checked.ok) return null;
      const expected = points.get(request.identity.requestSequence);
      if (expected && !samePhysicalPoint(expected, checked.value)) return null;
    }
    if (!current() || !policy.replayAllowed()) return null;
    const result = await port.execute(failedStep);
    if (!result.ok || !current()) return null;
    const point = acceptKernelResponse(project, result.value, failedStep.identity);
    if (!point.ok) return null;
    committed = true;
    return { port, point };
  } finally {
    if (!committed) await port.close();
  }
}
