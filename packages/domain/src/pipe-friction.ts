/* TypeScript port of fluids.friction.Clamond from the preserved v1 JavaScript port.
 * Copyright (C) 2016-2025 Caleb Bell. MIT; see ../../engine/third-party/fluids-LICENSE.txt.
 * Source version and migration notes: ../../engine/third-party/source-provenance.json.
 */
function clamond(Re: number, eD: number) {
  const X1 = eD * Re * 0.123968186335417546,
    X2 = Math.log(Re) - 0.77939748845568194;
  let F = X2 - 0.2,
    X1F = X1 + F,
    X1F1 = 1 + X1F;
  let E = (Math.log(X1F) - 0.2) / X1F1;
  F -= ((X1F1 + 0.5 * E) * E * X1F) / (X1F1 + E * (1 + E / 3));
  X1F = X1 + F;
  X1F1 = 1 + X1F;
  E = (Math.log(X1F) + F - X2) / X1F1;
  const b = X1F1 + E * (1 + E / 3);
  F = b / (b * F - (X1F1 + 0.5 * E) * E * X1F);
  return 1.3254745276195995 * F * F;
}

// Transition treatment belongs to this application, not the fluids API.
export function darcyFrictionFactor(Re: number, eD: number) {
  if (Re <= 0) return { f: 0, regime: '静止' } as const;
  if (Re <= 2300) return { f: 64 / Re, regime: '层流' } as const;
  if (Re >= 4000) return { f: clamond(Re, eD), regime: '湍流' } as const;
  const t = (Re - 2300) / 1700;
  return { f: ((1 - t) * 64) / 2300 + t * clamond(4000, eD), regime: '过渡区估算' } as const;
}
