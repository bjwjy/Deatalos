import { darcyFrictionFactor } from '@hyd/domain';

export function pipe(
  q: number,
  d: number,
  length: number,
  roughness: number,
  K: number,
  density: number,
  viscosity: number,
) {
  const D = d / 1000,
    Q = Math.abs(q) / 60000,
    v = Q / ((Math.PI * D * D) / 4);
  const Re = (v * D) / (viscosity * 1e-6),
    z = darcyFrictionFactor(Re, roughness / d);
  return {
    q: Math.abs(q),
    v,
    Re,
    f: z.f,
    regime: z.regime,
    dp: (((z.f * length) / D + K) * density * v * v) / 2 / 1e6,
  };
}
export type PipeResult = ReturnType<typeof pipe>;
