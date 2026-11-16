import {
  diagnostic,
  immutable,
  type NetworkProject,
  type NetworkSnapshot,
  type NetworkControl,
  type SequenceRunView,
  type Result,
} from '@hyd/domain';
import { NetworkSequenceRun, type SequenceDecision } from './network-sequence.js';

export interface ControllerRunView extends SequenceRunView {
  readonly componentId: string;
  readonly label: string;
}
type Transition = { readonly run: NetworkSequenceRun; readonly next: Extract<SequenceDecision, { kind: 'next' }> };
type Decision =
  | { readonly kind: 'stay' | 'complete' }
  | {
      readonly kind: 'next';
      readonly commands: readonly NetworkControl[];
      readonly transitions: readonly Transition[];
    };
/** Multiple independent per-valve controllers share one kernel clock and one atomic control writer. */
export class NetworkControllerFleet {
  private constructor(
    readonly runId: string,
    readonly members: readonly {
      readonly componentId: string;
      readonly label: string;
      readonly run: NetworkSequenceRun;
    }[],
  ) {}
  static create(project: NetworkProject, runId: string, point: NetworkSnapshot): Result<NetworkControllerFleet> {
    const components = project.design.components.filter((c) => c.typeId === 'dynamic-controller'),
      members: { componentId: string; label: string; run: NetworkSequenceRun }[] = [],
      owners = new Map<string, string>();
    const fail = (message: string): Result<never> => ({
      ok: false,
      diagnostics: [diagnostic('CONTROLLER_CONFLICT', '/controllers', message)],
    });
    if (!/^[-\w]{1,36}$/.test(runId)) return fail('控制器组运行编号须为1至36位字母、数字、下划线或连字符。');
    if (!components.length) return fail('请先从元件库放置动态控制器并双击配置。');
    for (const [i, c] of components.entries()) {
      if (!c.controller) return fail(c.label + ' 尚未配置动作，请双击配置后再启动。');
      const created = NetworkSequenceRun.create(project, c.controller, runId + '-' + i, point, c.id);
      if (!created.ok) return created;
      const targets = [...new Set(c.controller.steps.flatMap((s) => s.commands.map((v) => v.componentId)))];
      if (targets.length !== 1) return fail(c.label + '：每个控制器须对应同一个元件，可添加多条动作。');
      for (const target of targets) {
        const owner = owners.get(target);
        if (owner) return fail(owner + ' 与 ' + c.label + ' 同时接管元件 ' + target + '，未发出任何控制。');
        owners.set(target, c.label);
      }
      members.push({ componentId: c.id, label: c.label, run: created.value });
    }
    return { ok: true, value: new NetworkControllerFleet(runId, members) };
  }
  get initialCommands(): readonly NetworkControl[] {
    return this.members.flatMap((m) => m.run.step.commands);
  }
  controlsDisplacement(componentId: string): boolean {
    return this.members.some(
      ({ run }) =>
        (run.status === 'running' || run.status === 'paused') &&
        run.program.steps.some((step) =>
          step.commands.some((command) => command.kind === 'displacement' && command.componentId === componentId),
        ),
    );
  }
  get status(): SequenceRunView['status'] {
    const states = this.members.map((m) => m.run.status);
    return states.includes('failed')
      ? 'failed'
      : states.includes('running')
        ? 'running'
        : states.includes('paused')
          ? 'paused'
          : states.every((s) => s === 'completed')
            ? 'completed'
            : 'stopped';
  }
  views(): readonly ControllerRunView[] {
    return immutable(this.members.map((m) => ({ ...m.run.view(), componentId: m.componentId, label: m.label })));
  }
  view(): SequenceRunView {
    const first = this.members.find((m) => m.run.status === this.status) ?? this.members[0];
    if (!first) throw new Error('Validated controller fleet is empty');
    return { ...first.run.view(), runId: this.runId, status: this.status };
  }
  pause(): void {
    for (const m of this.members) m.run.pause();
  }
  resume(point: NetworkSnapshot): void {
    for (const m of this.members) m.run.resume(point);
  }
  stop(message: string): void {
    for (const m of this.members) if (m.run.status !== 'completed') m.run.stop(message);
  }
  fail(message: string): void {
    for (const m of this.members) if (m.run.status !== 'completed') m.run.fail(message);
  }
  acknowledge(point: NetworkSnapshot, decision?: Extract<Decision, { kind: 'next' }>): void {
    for (const m of this.members)
      if (['running', 'paused'].includes(m.run.status))
        m.run.acknowledge(point, decision?.transitions.find((t) => t.run === m.run)?.next);
  }
  evaluate(point: NetworkSnapshot): Result<Decision> {
    const transitions: Transition[] = [];
    for (const m of this.members) {
      const decision = m.run.evaluate(point);
      if (!decision.ok) {
        this.fail(m.label + '：' + decision.diagnostics.map((d) => d.message).join('；'));
        return decision;
      }
      if (decision.value.kind === 'next') transitions.push({ run: m.run, next: decision.value });
    }
    if (this.status === 'completed') return { ok: true, value: { kind: 'complete' } };
    return {
      ok: true,
      value: transitions.length
        ? { kind: 'next', commands: transitions.flatMap((t) => t.next.step.commands), transitions }
        : { kind: 'stay' },
    };
  }
}
