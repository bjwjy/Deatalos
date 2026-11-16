import { diagnosticDisplayText } from '@hyd/domain';
import {
  fromSI,
  specs,
  immutable,
  parseNetworkProject,
  parseNetworkSnapshot,
  requestNetworkControls,
  type NetworkIdentity,
  type Parameters,
  type PhysicalValue,
  type Quantity,
  type Result,
  type ValvePositionId,
} from '@hyd/domain';
import type { ApplicationState, ExportSnapshot } from '@hyd/application';
import type { Solution } from '@hyd/engine';
// ESM read-only display shapes. They are neither authoritative files nor solver input.
const parameters = (group: string, values: Parameters) =>
  Object.fromEntries(
    specs(group).map((s) => {
      const value = values[s.key];
      if (value === undefined) throw new Error(`Validated display parameter missing: ${s.key}`);
      return [s.legacyKey, fromSI(s.quantity, value)];
    }),
  );
const physical = (quantity: Quantity, value: PhysicalValue) =>
  value.kind === 'known' ? fromSI(quantity, value.value) : null;
export function displayResult(result: Result<Solution>) {
  if (!result.ok)
    return immutable({
      ok: false as const,
      errors: result.diagnostics.map((d) => diagnosticDisplayText(d)),
      diagnostics: result.diagnostics,
    });
  const r = result.value;
  return immutable({
    ok: true as const,
    status: r.status,
    mode: r.mode,
    direction: r.direction,
    actuatorType: r.actuatorType,
    Q: fromSI('flow', r.pumpFlowM3PerS),
    q: fromSI('flow', r.actuatorFlowM3PerS),
    returnFlow: fromSI('flow', r.returnFlowM3PerS),
    bypassFlow: fromSI('flow', r.bypassFlowM3PerS),
    pressure: fromSI('pressure', r.pumpGaugePressurePa),
    pS: fromSI('pressure', r.suctionGaugePressurePa),
    pA: physical('pressure', r.chamberAGaugePressurePa),
    pB: physical('pressure', r.chamberBGaugePressurePa),
    force: physical('force', r.forceN),
    torque: physical('torque', r.torqueNm),
    speed: physical('linearSpeed', r.speedMPerS),
    rpm: physical('angularSpeed', r.angularSpeedRadPerS),
    position: physical('length', r.positionM),
    stroke: physical('length', r.strokeM),
    areaA: physical('area', r.areaAM2),
    areaB: physical('area', r.areaBM2),
    hydraulicPower: fromSI('power', r.hydraulicPowerW),
    shaftPower: fromSI('power', r.shaftPowerW),
    actuatorPower: fromSI('power', r.actuatorPowerW),
    lossPower: fromSI('power', r.lossPowerW),
    wireValues: Object.fromEntries(
      Object.entries(r.wireValues).map(([id, w]) => [
        id,
        {
          q: fromSI('flow', w.magnitudeM3PerS),
          flow: fromSI('flow', w.flowM3PerS),
          v: fromSI('pipeSpeed', w.speedMPerS),
          Re: w.reynolds,
          f: w.darcyFactor,
          dp: fromSI('pressure', w.dropPa),
          regime: w.regime,
          role: w.role,
          pressureSide: w.pressureSide,
        },
      ]),
    ),
    warnings: r.warnings,
    diagnostics: r.diagnostics,
  });
}
export interface ValveDisplay {
  readonly componentId: string;
  readonly initialPositionId: ValvePositionId;
  readonly requestedPositionId: ValvePositionId;
  readonly appliedPositionId: ValvePositionId | null;
  readonly effectivePositionId: ValvePositionId | null;
  readonly displayPositionId: ValvePositionId;
  readonly source: 'design' | 'preview' | 'step' | 'kernel';
  readonly tick: number | null;
}
function valveDisplay(
  componentId: string,
  initialPositionId: ValvePositionId,
  requestedPositionId: ValvePositionId,
  appliedPositionId: ValvePositionId | null,
  effectivePositionId: ValvePositionId | null,
  tick: number | null,
  source: 'step' | 'kernel',
): ValveDisplay {
  const current = effectivePositionId !== null && requestedPositionId === effectivePositionId;
  return {
    componentId,
    initialPositionId,
    requestedPositionId,
    appliedPositionId,
    effectivePositionId,
    displayPositionId: requestedPositionId,
    tick,
    source: current ? source : tick === null && requestedPositionId === initialPositionId ? 'design' : 'preview',
  };
}

/** Read-only v3 contract adapter; does not start a kernel or migrate the workbench. */
export function displayNetworkValves(
  projectInput: unknown,
  requestedInput: unknown,
  received?: { readonly point: unknown; readonly expected: NetworkIdentity },
): Result<readonly ValveDisplay[]> {
  const parsed = parseNetworkProject(projectInput);
  if (!parsed.ok) return parsed;
  const project = parsed.value,
    requested = requestNetworkControls(project, requestedInput, []);
  if (!requested.ok) return requested;
  const result = received ? parseNetworkSnapshot(project, received.point, received.expected) : null;
  if (result && !result.ok) return result;
  const point = result?.ok ? result.value : null;
  return {
    ok: true,
    value: immutable(
      project.design.initialConditions.flatMap((initial) => {
        if (initial.kind !== 'valve') return [];
        const control = requested.value.find((c) => c.componentId === initial.componentId);
        const applied = point?.appliedControls.find((c) => c.componentId === initial.componentId);
        const state = point?.states.find((s) => s.componentId === initial.componentId);
        if (control?.kind !== 'position') return [];
        return [
          valveDisplay(
            initial.componentId,
            initial.positionId,
            control.positionId,
            applied?.kind === 'position' ? applied.positionId : null,
            state?.kind === 'valve' ? state.effectivePositionId : null,
            point?.identity.tick ?? null,
            'kernel',
          ),
        ];
      }),
    ),
  };
}

export function displayState(
  snapshot: Pick<ApplicationState, 'document' | 'editor'> & {
    runtime: Pick<
      ApplicationState['runtime'],
      'identity' | 'lastStep' | 'state' | 'controls' | 'result' | 'running' | 'samples'
    >;
  },
) {
  const doc = snapshot.document,
    drag = snapshot.editor.drag;
  const runtime = snapshot.runtime,
    step = runtime.lastStep,
    identity = runtime.identity;
  // A failed current preview cannot borrow an earlier successful step. Control
  // revisions may differ for a legitimate pending request at the same tick.
  const validStep =
    step?.result.ok &&
    runtime.result.ok &&
    step.identity.documentSessionId === identity.documentSessionId &&
    step.identity.physicsRevision === identity.physicsRevision &&
    step.identity.runId === identity.runId &&
    step.state.tick === runtime.state.tick &&
    step.state.timeS === runtime.state.timeS
      ? step
      : null;
  const valves = doc.design.initialConditions.valves.map((initial) => {
    const request = runtime.controls.valves.find((v) => v.componentId === initial.componentId);
    if (!request) throw new Error('Validated controls lost valve instance');
    const effective = validStep?.controls.valves.find((v) => v.componentId === initial.componentId)?.positionId ?? null;
    return valveDisplay(
      initial.componentId,
      initial.positionId,
      request.positionId,
      effective,
      effective,
      validStep?.state.tick ?? null,
      'step',
    );
  });
  const actuator = snapshot.runtime.state.actuatorStates.find((a) => a.kind === 'cylinder');
  const motor = snapshot.runtime.state.actuatorStates.find((a) => a.kind === 'motor');
  return immutable({
    model: {
      name: doc.title,
      note: doc.note,
      fluid: parameters('fluid', doc.design.fluid),
      components: doc.design.components.map((c) => {
        const position = doc.layout.components.find((p) => p.componentId === c.id);
        if (!position) throw new Error('Validated document lost component layout');
        return {
          id: c.id,
          type: c.typeId,
          label: c.label,
          x: drag?.componentId === c.id ? drag.x : position.x,
          y: drag?.componentId === c.id ? drag.y : position.y,
          params: parameters(c.typeId, c.params),
          ...(c.typeId === 'valve' ? { center: c.definitionId === 'builtin:valve-o' ? 'closed' : 'tandem' } : {}),
        };
      }),
      wires: doc.design.connections.map((w) => ({
        id: w.id,
        from: `${w.from.componentId}:${w.from.portId}`,
        to: `${w.to.componentId}:${w.to.portId}`,
        params: parameters('pipe', w.params),
      })),
    },
    state: {
      time: snapshot.runtime.state.timeS,
      position: actuator ? fromSI('length', actuator.positionM) : 0,
      angle: motor ? fromSI('angle', motor.angleRad) : 0,
    },
    valves,
    running: snapshot.runtime.running,
    result: displayResult(snapshot.runtime.result),
    samples: snapshot.runtime.samples.map((s) => {
      const cylinder = s.actuatorStates.find((a) => a.kind === 'cylinder');
      return {
        time: s.timeS,
        pressure: fromSI('pressure', s.pumpGaugePressurePa),
        q: fromSI('flow', s.actuatorFlowM3PerS),
        power: fromSI('power', s.shaftPowerW),
        position: cylinder ? fromSI('length', cylinder.positionM) : null,
        rpm: physical('angularSpeed', s.angularSpeedRadPerS),
      };
    }),
  });
}

export function displayExport(snapshot: ExportSnapshot) {
  return displayState({
    document: snapshot.document,
    editor: { selection: null, drag: null },
    runtime: {
      identity: snapshot.point?.identity ?? {
        documentSessionId: snapshot.documentSessionId,
        physicsRevision: snapshot.physicsRevision,
        runId: snapshot.runId,
        controlRevision: 0,
        stateRevision: 0,
        requestSequence: 0,
      },
      lastStep: snapshot.point?.source === 'step' ? snapshot.point : null,
      state: snapshot.point?.state ?? snapshot.initialState,
      controls: snapshot.point?.controls ?? snapshot.initialControls,
      result: snapshot.point?.result ?? { ok: false, diagnostics: [] },
      running: false,
      samples: [],
    },
  });
}
