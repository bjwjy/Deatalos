import {
  fromSI,
  specs,
  type Parameters,
  type ProjectDesign,
  type PhysicalValue,
  toSI,
  type Quantity,
} from '@hyd/domain';
import type { LegacyModel } from './legacy-model.js';
import type { solveLegacy } from './solve-legacy.js';

function parameters(group: string, source: Parameters): Parameters {
  return Object.fromEntries(
    specs(group).map((spec) => {
      const value = source[spec.key];
      if (value === undefined) throw new Error(`Parsed SI parameter missing: ${spec.key}`);
      return [spec.legacyKey, fromSI(spec.quantity, value)];
    }),
  );
}
export function projectPhysics(design: ProjectDesign): LegacyModel {
  return {
    components: design.components.map((c) => ({
      id: c.id,
      type: c.typeId,
      params: parameters(c.typeId, c.params),
      center: c.definitionId === 'builtin:valve-o' ? 'closed' : 'tandem',
    })),
    wires: design.connections.map((w) => ({
      id: w.id,
      from: `${w.from.componentId}:${w.from.portId}`,
      to: `${w.to.componentId}:${w.to.portId}`,
      params: parameters('pipe', w.params),
    })),
    fluid: parameters('fluid', design.fluid),
  };
}
const known = (quantity: Quantity, value: number): PhysicalValue => ({ kind: 'known', value: toSI(quantity, value) });
const unknown = (reason: string): PhysicalValue => ({ kind: 'unknown', reason });
export function resultToSI(r: ReturnType<typeof solveLegacy>) {
  const cylinder = r.actuatorType === 'cylinder';
  const neutral = r.mode === 'neutral';
  return {
    status: r.status,
    mode: r.mode,
    direction: r.direction,
    actuatorType: r.actuatorType,
    positionM: cylinder ? known('length', r.position) : unknown('NOT_APPLICABLE'),
    pumpFlowM3PerS: toSI('flow', r.Q),
    actuatorFlowM3PerS: toSI('flow', r.q),
    returnFlowM3PerS: toSI('flow', r.returnFlow),
    bypassFlowM3PerS: toSI('flow', r.bypassFlow),
    pumpGaugePressurePa: toSI('pressure', r.pressure),
    suctionGaugePressurePa: toSI('pressure', r.pS),
    chamberAGaugePressurePa: r.pA === null ? unknown('NEUTRAL_CHAMBER_PRESSURE_UNSOLVED') : known('pressure', r.pA),
    chamberBGaugePressurePa: r.pB === null ? unknown('NEUTRAL_CHAMBER_PRESSURE_UNSOLVED') : known('pressure', r.pB),
    forceN: !cylinder
      ? unknown('NOT_APPLICABLE')
      : neutral
        ? unknown('NEUTRAL_HOLDING_UNSOLVED')
        : known('force', r.force),
    torqueNm: cylinder
      ? unknown('NOT_APPLICABLE')
      : neutral
        ? unknown('NEUTRAL_HOLDING_UNSOLVED')
        : known('torque', r.torque),
    speedMPerS: cylinder ? known('linearSpeed', r.speed) : unknown('NOT_APPLICABLE'),
    angularSpeedRadPerS: cylinder ? unknown('NOT_APPLICABLE') : known('angularSpeed', r.rpm),
    hydraulicPowerW: toSI('power', r.hydraulicPower),
    shaftPowerW: toSI('power', r.shaftPower),
    actuatorPowerW: toSI('power', r.actuatorPower),
    lossPowerW: toSI('power', r.lossPower),
    strokeM: cylinder && r.stroke !== null ? known('length', r.stroke) : unknown('NOT_APPLICABLE'),
    areaAM2: cylinder ? known('area', r.areaA) : unknown('NOT_APPLICABLE'),
    areaBM2: cylinder ? known('area', r.areaB) : unknown('NOT_APPLICABLE'),
    wireValues: Object.fromEntries(
      Object.entries(r.wireValues).map(([id, w]) => [
        id,
        {
          magnitudeM3PerS: toSI('flow', w.q),
          flowM3PerS: toSI('flow', w.flow),
          speedMPerS: toSI('pipeSpeed', w.v),
          reynolds: w.Re,
          darcyFactor: w.f,
          dropPa: toSI('pressure', w.dp),
          regime: w.regime,
          role: w.role,
          pressureSide: w.pressureSide,
        },
      ]),
    ),
    warnings: r.warnings,
  };
}
