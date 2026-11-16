export type ReturnDemand = {
  readonly areaRatio: number;
  readonly segments: readonly number[];
  readonly supplySegments?: readonly number[];
} & (
  | { readonly startPa: number; readonly resistance: number }
  | { readonly pressureAtFlow: (flowM3PerS: number) => number }
);

const demandPressure = (demand: ReturnDemand, flow: number) =>
  'pressureAtFlow' in demand ? demand.pressureAtFlow(flow) : demand.startPa + demand.resistance * flow ** 2;

function demandSlope(demand: ReturnDemand, share: number, pumpFlow: number): number {
  if ('resistance' in demand) return 2 * demand.resistance * pumpFlow ** 2 * share;
  const flow = share * pumpFlow;
  const delta = Math.max(flow * 1e-5, pumpFlow * 1e-8);
  const low = Math.max(0, flow - delta);
  const high = flow + delta;
  return ((demand.pressureAtFlow(high) - demand.pressureAtFlow(low)) / (high - low)) * pumpFlow;
}

interface ReturnOperatingPoint {
  readonly pressurePa: number;
  readonly flows: readonly number[];
  readonly returnFlows: readonly number[];
}

// The reduced matrix is positive definite for positive inlet flows. If it loses
// numerical rank, the caller can still advance with an exact two-branch exchange.
function solveSystem(matrix: number[][]): readonly number[] | null {
  for (const [i, row] of matrix.entries()) {
    const pivot = row[i];
    if (pivot === undefined || !(pivot > 0) || !Number.isFinite(pivot)) return null;
    for (const target of matrix.slice(i + 1)) {
      const factor = (target[i] ?? 0) / pivot;
      for (let j = i; j < target.length; j++) target[j] = (target[j] ?? NaN) - factor * (row[j] ?? NaN);
    }
  }
  const result: number[] = Array(matrix.length).fill(0);
  for (const [i, row] of [...matrix].reverse().map((row, index) => [matrix.length - 1 - index, row] as const)) {
    const sum = result.reduce((value, x, j) => (j > i ? value + (row[j] ?? NaN) * x : value), 0);
    const value = ((row[matrix.length] ?? NaN) - sum) / (row[i] ?? NaN);
    if (!Number.isFinite(value)) return null;
    result[i] = value;
  }
  return result;
}

function bracket(low: number, high: number, difference: (step: number) => number): number {
  for (let iteration = 0; iteration < 40; iteration++) {
    const mid = low + (high - low) / 2;
    if (difference(mid) < 0) low = mid;
    else high = mid;
  }
  return low + (high - low) / 2;
}

/** Fixed pump flow distributed among open cylinders and reliefs across coupled pipe paths. */
export function solveReturnNetwork(
  losses: readonly ((flowM3PerS: number) => number)[],
  demands: readonly ReturnDemand[],
  pumpFlow: number,
): ReturnOperatingPoint | null {
  if (!demands.length) return null;
  const ratios = losses.map((_, index) =>
    demands.map((demand) =>
      demand.supplySegments?.includes(index) ? 1 : demand.segments.includes(index) ? demand.areaRatio : 0,
    ),
  );
  const evaluate = (shares: readonly number[]) => {
    const returnFlows = ratios.map(
      (ratio) => ratio.reduce((sum, alpha, i) => sum + alpha * (shares[i] ?? NaN), 0) * pumpFlow,
    );
    const drops = losses.map((drop, i) => drop(returnFlows[i] ?? NaN));
    const pressures = demands.map(
      (demand, i) =>
        demandPressure(demand, (shares[i] ?? NaN) * pumpFlow) +
        demand.areaRatio * demand.segments.reduce((sum, index) => sum + (drops[index] ?? NaN), 0) +
        (demand.supplySegments?.reduce((sum, index) => sum + (drops[index] ?? NaN), 0) ?? 0),
    );
    return { pressures, returnFlows };
  };

  let shares: readonly number[] = demands.map(() => 1 / demands.length);
  for (let iteration = 0; iteration < 512; iteration++) {
    const { pressures, returnFlows } = evaluate(shares);
    if (pressures.some((pressure) => !Number.isFinite(pressure))) return null;
    const active = shares.flatMap((share, i) => (share > 0 ? [i] : []));
    let receiver = 0;
    let donor = active[0];
    if (donor === undefined) return null;
    for (const [i, pressure] of pressures.entries()) if (pressure < (pressures[receiver] ?? NaN)) receiver = i;
    for (const i of active) if ((pressures[i] ?? NaN) > (pressures[donor] ?? NaN)) donor = i;
    const highest = pressures[donor] ?? NaN;
    const lowest = pressures[receiver] ?? NaN;
    if (highest - lowest <= Math.max(1, Math.abs(highest)) * 1e-10)
      return { pressurePa: (highest + lowest) / 2, flows: shares.map((share) => share * pumpFlow), returnFlows };

    // For pipe s, q_s = Σ alpha_i q_i. The Hessian contribution is its slope
    // times the outer product of its flow weights (1 on supply, area ratio on return).
    let direction: readonly number[] | null = null;
    if ((shares[receiver] ?? 0) > 0 && active.length > 2) {
      const anchor = active.reduce((best, i) => ((shares[i] ?? 0) > (shares[best] ?? 0) ? i : best), donor);
      const free = active.filter((i) => i !== anchor);
      const slopes = losses.map((drop, index) => {
        const flow = returnFlows[index] ?? NaN;
        const delta = Math.max(flow * 1e-5, pumpFlow * 1e-8);
        const low = Math.max(0, flow - delta);
        return ((drop(flow + delta) - drop(low)) / (flow + delta - low)) * pumpFlow;
      });
      const diagonal = demands.map((demand, i) => demandSlope(demand, shares[i] ?? NaN, pumpFlow));
      const matrix = free.map((i) => [
        ...free.map((j) =>
          slopes.reduce(
            (sum, slope, s) => {
              const ratio = ratios[s];
              const a = ratio?.[anchor] ?? NaN;
              return sum + slope * ((ratio?.[i] ?? NaN) - a) * ((ratio?.[j] ?? NaN) - a);
            },
            (diagonal[anchor] ?? NaN) + (i === j ? (diagonal[i] ?? NaN) : 0),
          ),
        ),
        (pressures[anchor] ?? NaN) - (pressures[i] ?? NaN),
      ]);
      const step = solveSystem(matrix);
      if (step) {
        const vector: number[] = demands.map(() => 0);
        for (const [k, i] of free.entries()) vector[i] = step[k] ?? NaN;
        vector[anchor] = -step.reduce((sum, x) => sum + x, 0);
        direction = vector;
      }
    }

    const advance = (vector: readonly number[], upper: number): readonly number[] | null => {
      const candidate = (step: number) =>
        shares.map((share, i) => {
          const next = share + step * (vector[i] ?? NaN);
          return next <= 1e-16 ? 0 : next;
        });
      // Relative pressures remove the constant supply term from the directional derivative.
      const derivative = (values: readonly number[]) =>
        vector.reduce((sum, change, i) => (change === 0 ? sum : sum + change * ((values[i] ?? NaN) - lowest)), 0);
      if (!(upper > 0) || !(derivative(pressures) < 0)) return null;
      const difference = (step: number) => derivative(evaluate(candidate(step)).pressures);
      const step = difference(upper) <= 0 ? upper : bracket(0, upper, difference);
      const next = candidate(step);
      return next.some((value, i) => value !== shares[i]) ? next : null;
    };

    if (direction) {
      const upper = direction.reduce(
        (limit, change, i) => (change < 0 ? Math.min(limit, -(shares[i] ?? NaN) / change) : limit),
        1,
      );
      const next = advance(direction, upper);
      if (next) {
        shares = next;
        continue;
      }
    }

    // Exchange actual flow between the most overpressured active demand and
    // the lowest required pressure. This also opens eligible idle branches.
    const exchange = shares.map((_, i) => (i === donor ? -1 : i === receiver ? 1 : 0));
    const next = advance(exchange, shares[donor] ?? 0);
    if (!next) return null;
    shares = next;
  }
  return null;
}
