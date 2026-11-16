import { diagnostic, type NetworkIdentity, type NetworkControl, type NetworkSnapshot, type Result } from '@hyd/domain';
type Opening = Extract<NetworkControl, { readonly kind: 'opening-area' }>;
type ContinuousControl = Opening | Extract<NetworkControl, { readonly kind: 'displacement' }>;
interface Ticket<T> {
  readonly command: T;
  readonly target: NetworkIdentity;
  readonly sequence: number;
}
interface Hooks<T> {
  identity(): NetworkIdentity | null;
  send(command: T, target: NetworkIdentity): Promise<Result<NetworkSnapshot>>;
  settled(command: T, result: Result<NetworkSnapshot>): void;
}
const sameRun = (a: NetworkIdentity | null, b: NetworkIdentity): boolean =>
  !!a &&
  a.documentSessionId === b.documentSessionId &&
  a.physicsRevision === b.physicsRevision &&
  a.simulationSessionId === b.simulationSessionId;
/** Bounded transient input mailbox: one in flight, at most one unsent value per object. */
export function createThrottleRequests<T extends ContinuousControl = Opening>(hooks: Hooks<T>) {
  const pending = new Map<string, Ticket<T>>(),
    latest = new Map<string, Ticket<T>>();
  let active = false,
    sequence = 0;
  async function drain(): Promise<void> {
    if (active) return;
    active = true;
    try {
      while (pending.size) {
        const ticket = pending.values().next().value;
        if (!ticket) break;
        const id = ticket.command.componentId;
        pending.delete(id);
        if (!sameRun(hooks.identity(), ticket.target)) {
          latest.delete(id);
          continue;
        }
        let result: Result<NetworkSnapshot>;
        try {
          result = await hooks.send(ticket.command, ticket.target);
        } catch (cause: unknown) {
          result = {
            ok: false,
            diagnostics: [diagnostic('CONTROL_NOT_ACCEPTED', '/control', '控制未确认：' + String(cause).slice(0, 120))],
          };
        }
        if (result.ok && !sameRun(result.value.identity, ticket.target))
          result = { ok: false, diagnostics: [diagnostic('RESPONSE_STALE', '/control', '控制回执不属于本次运行。')] };
        if (latest.get(id)?.sequence === ticket.sequence && sameRun(hooks.identity(), ticket.target)) {
          latest.delete(id);
          hooks.settled(ticket.command, result);
        }
      }
    } finally {
      active = false;
    }
  }
  return {
    hasPending(id: string): boolean {
      return latest.has(id);
    },
    request(command: T) {
      const target = hooks.identity();
      if (!target) return false;
      const previous = latest.get(command.componentId);
      if (previous && sameRun(previous.target, target)) {
        const prior = previous.command;
        if (prior.kind === 'opening-area' && command.kind === 'opening-area' && prior.areaM2 === command.areaM2)
          return true;
        if (
          prior.kind === 'displacement' &&
          command.kind === 'displacement' &&
          prior.source === command.source &&
          prior.value === command.value
        )
          return true;
      }
      const ticket = { command, target, sequence: ++sequence };
      latest.set(command.componentId, ticket);
      pending.set(command.componentId, ticket);
      void drain();
      return true;
    },
    cancel(id: string) {
      pending.delete(id);
      latest.delete(id);
    },
    clear() {
      pending.clear();
      latest.clear();
    },
  };
}
