import {
  checkJson,
  ContractReader,
  diagnostic,
  fromSI,
  immutable,
  parseDocument,
  type Diagnostic,
  type ProjectDesign,
  type Result,
  type SimulationState,
  type ValvePositionId,
} from '@hyd/domain';
import { projectPhysics, resultToSI } from './adapter.js';
import { topology } from './topology.js';
import { parameter, type LegacyModel, type Topology } from './legacy-model.js';
import { solveLegacy } from './solve-legacy.js';

export { connectionGraph, networkWiringCheck } from './network-graph.js';
export { fixedPumpClosureGuard } from './network-pressure-guard.js';
export { compileHopsan, nativeComponentId, physicalPipeMappingSupport } from './hopsan-map.js';
export type { MappingOptions, MappingPlan, NativePort } from './hopsan-map.js';
export { controlWrites, mappedSnapshot } from './network-snapshot.js';

export interface Controls {
  readonly valves: readonly { readonly componentId: string; readonly positionId: ValvePositionId }[];
}
const compileToken = Symbol('compileCircuit');
// Unexported constructor and private fields prevent injecting legacy checked data.
class Circuit {
  readonly solverId = 'legacy-basic';
  readonly modelVersion = '1.0.0-experimental';
  readonly physics: ProjectDesign;
  readonly initialState: SimulationState;
  readonly initialControls: Controls;
  #model: LegacyModel;
  #topology: Topology;
  constructor(token: typeof compileToken, physics: ProjectDesign, model: LegacyModel, checked: Topology) {
    if (token !== compileToken) throw new TypeError('Use compileCircuit');
    this.physics = physics;
    this.#model = immutable(model);
    this.#topology = immutable(checked);
    this.initialState = immutable({ tick: 0, timeS: 0, actuatorStates: physics.initialConditions.actuators });
    this.initialControls = immutable({ valves: physics.initialConditions.valves });
    Object.freeze(this);
  }
  static owns(value: unknown): value is Circuit {
    return typeof value === 'object' && value !== null && #model in value;
  }
  evaluate(state: unknown, controls: unknown): Result<Solution> {
    const checked = runtime(this.#topology, state, controls);
    if (!checked.ok) return checked;
    const { position, angle, mode, state: parsedState, controls: parsedControls } = checked.value;
    const legacy = solveLegacy(this.#model, { position, angle }, mode, this.#topology);
    if (!finiteResult(legacy))
      return {
        ok: false,
        diagnostics: [diagnostic('SOLVER_FAILED', '/result', '旧模型产生非有限工作点，不能作为成功结果使用。')],
      };
    const diagnostics: Diagnostic[] = legacy.warnings.map((message, i) => ({
      code: 'MODEL_WARNING',
      severity: 'warning',
      field: `/result/warnings/${i}`,
      message,
      suggestion: '按模型假设检查管径、黏度及吸油工况；本模型未校核气蚀。',
    }));
    if (mode === 'neutral')
      diagnostics.push({
        code: 'NEUTRAL_HOLDING_UNSOLVED',
        severity: 'info',
        field: '/result',
        message: '中位只计算泵支路；封闭腔压力及保持力/转矩未求解。',
        suggestion: '未知值不能用于保持能力校核。',
      });
    return {
      ok: true,
      value: immutable({
        ...resultToSI(legacy),
        state: parsedState,
        controls: parsedControls,
        diagnostics,
        solverId: this.solverId,
        modelVersion: this.modelVersion,
      }),
    };
  }
}
export type CompiledCircuit = Circuit;
export type Solution = ReturnType<typeof resultToSI> & {
  readonly state: SimulationState;
  readonly controls: Controls;
  readonly diagnostics: readonly Diagnostic[];
  readonly solverId: 'legacy-basic';
  readonly modelVersion: '1.0.0-experimental';
};

/** Parses a full F02 document, copies physical data, then checks solver capability.
 * Layout/title are validated as file data but never projected into physics. */
export function compileCircuit(input: unknown): Result<CompiledCircuit> {
  const parsed = parseDocument(input);
  if (!parsed.ok) return parsed;
  const physics = parsed.value.design;
  const model = projectPhysics(physics);
  const checked = topology(model);
  return checked.ok ? { ok: true, value: new Circuit(compileToken, physics, model, checked.value) } : checked;
}

/** Static quasi-static evaluation only; no clock, integration or document mutation.
 * Omitted state/controls use instance initial conditions, never global defaults. */
export function solve(compiled: CompiledCircuit, state?: unknown, controls?: unknown): Result<Solution> {
  if (!Circuit.owns(compiled))
    return {
      ok: false,
      diagnostics: [
        diagnostic('COMPILED_CIRCUIT_INVALID', '/compiled', '必须使用 compileCircuit 成功返回的编译对象。'),
      ],
    };
  return compiled.evaluate(
    state === undefined ? compiled.initialState : state,
    controls === undefined ? compiled.initialControls : controls,
  );
}

function runtime(t: Topology, state: unknown, controls: unknown) {
  const budget = checkJson({ state, controls });
  if (!budget.ok) return budget;
  const reader = new ContractReader();
  const s = reader.object(state, '/state', ['tick', 'timeS', 'actuatorStates']);
  const tick = reader.number(s.tick, '/state/tick', 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(tick)) reader.fail('STATE_INVALID', '/state/tick', 'tick 必须是非负安全整数。');
  const timeS = reader.number(s.timeS, '/state/timeS', 0, Number.MAX_VALUE);
  const states = reader.array(s.actuatorStates, '/state/actuatorStates', 1);
  if (states.length !== 1) reader.fail('STATE_INVALID', '/state/actuatorStates', '基础模型需要唯一执行器状态。');
  const a = reader.object(
    states[0],
    '/state/actuatorStates/0',
    t.act.type === 'cylinder' ? ['componentId', 'kind', 'positionM'] : ['componentId', 'kind', 'angleRad'],
  );
  reader.constant(a.componentId, t.act.id, '/state/actuatorStates/0/componentId', 'STATE_INVALID');
  reader.constant(a.kind, t.act.type, '/state/actuatorStates/0/kind', 'STATE_INVALID');
  const actuator =
    t.act.type === 'cylinder'
      ? {
          componentId: t.act.id,
          kind: 'cylinder' as const,
          positionM: reader.number(
            a.positionM,
            '/state/actuatorStates/0/positionM',
            0,
            parameter(t.act.params, 'stroke') * 0.001,
          ),
        }
      : {
          componentId: t.act.id,
          kind: 'motor' as const,
          angleRad: reader.number(a.angleRad, '/state/actuatorStates/0/angleRad', -1e9, 1e9),
        };
  const c = reader.object(controls, '/controls', ['valves']);
  const valves = reader.array(c.valves, '/controls/valves', 1);
  if (valves.length !== 1) reader.fail('CONTROL_INVALID', '/controls/valves', '基础模型需要唯一换向阀控制。');
  const v = reader.object(valves[0], '/controls/valves/0', ['componentId', 'positionId']);
  reader.constant(v.componentId, t.valve.id, '/controls/valves/0/componentId', 'CONTROL_INVALID');
  const mode: ValvePositionId = v.positionId === 'extend' || v.positionId === 'retract' ? v.positionId : 'neutral';
  if (!['extend', 'neutral', 'retract'].includes(String(v.positionId)))
    reader.fail('CONTROL_INVALID', '/controls/valves/0/positionId', '仅支持注册的三个稳定阀位。');
  return reader.finish({
    position: actuator.kind === 'cylinder' ? fromSI('length', actuator.positionM) : 0,
    angle: actuator.kind === 'motor' ? fromSI('angle', actuator.angleRad) : 0,
    mode,
    state: { tick, timeS, actuatorStates: [actuator] },
    controls: { valves: [{ componentId: t.valve.id, positionId: mode }] },
  });
}
function finiteResult(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return !value || typeof value !== 'object' || Object.values(value).every(finiteResult);
}

export { hopsanMappingRegistrations } from './hopsan-components.js';
export { networkStateAdapterTypes } from './network-state-adapters.js';
