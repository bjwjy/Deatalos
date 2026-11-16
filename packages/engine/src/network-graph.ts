import {
  diagnostic,
  immutable,
  networkDefinition,
  networkPortActive,
  parseNetworkProject,
  type NetworkEndpoint,
  type NetworkProject,
  type Result,
} from '@hyd/domain';

export interface GraphPort {
  readonly key: string;
  readonly kind: 'component' | 'pipe';
  readonly ownerId: string;
  readonly portId: string;
}
export interface IdealNet {
  readonly id: string;
  readonly terminals: readonly GraphPort[];
  readonly nodeIds: readonly string[];
  readonly connectionIds: readonly string[];
}
export interface ConnectionGraph {
  readonly project: NetworkProject;
  readonly nets: readonly IdealNet[];
  readonly hydraulicConnections: readonly Exclude<
    NetworkProject['design']['connections'][number],
    { kind: 'signal' }
  >[];
}
export const portKey = (id: string, port: string) => `p:${id}:${port}`;
export const endpointKey = (e: NetworkEndpoint): string =>
  e.kind === 'port' ? portKey(e.componentId, e.portId) : `n:${e.nodeId}`;
export const pipeKey = (id: string, port: string) => `e:${id}:${port}`;
export const failure = (code: string, field: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic(code, field, message)],
});

class Sets {
  readonly parent = new Map<string, string>();
  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }
  find(key: string): string {
    const parent = this.parent.get(key);
    if (parent === undefined) throw new Error('Graph endpoint was not registered');
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }
  join(a: string, b: string): void {
    const x = this.find(a),
      y = this.find(b);
    this.parent.set(x < y ? y : x, x < y ? x : y);
  }
}

/** Pure graph compilation. Coordinates, titles and connection crossings are never read. */
export function connectionGraph(input: unknown): Result<ConnectionGraph> {
  const parsed = parseNetworkProject(input);
  if (!parsed.ok) return parsed;
  const project = parsed.value,
    sets = new Sets(),
    ports: GraphPort[] = [];
  const hydraulicConnections = project.design.connections.filter((edge) => edge.kind !== 'signal');
  const connected = new Set(hydraulicConnections.flatMap((edge) => [endpointKey(edge.from), endpointKey(edge.to)]));
  const signalTargets = new Set(
    project.design.connections.filter((edge) => edge.kind === 'signal').map((edge) => endpointKey(edge.to)),
  );
  if (
    !project.design.components.some(
      (c) => networkDefinition(c.definition.id, c.definition.version)?.role !== 'controller',
    )
  )
    return failure('GRAPH_INCOMPLETE', '/design/components', '只有控制器，没有可运行的液压回路。');
  for (const c of project.design.components) {
    const definition = networkDefinition(c.definition.id, c.definition.version);
    if (!definition) return failure('MODEL_UNSUPPORTED', '/design/components', '定义尚未注册。');
    for (const p of definition.ports) {
      const key = portKey(c.id, p.id);
      // A retained X tube still ends at a zero-flow tap when another control source is selected.
      if (!networkPortActive(c, p.id) && (p.domain !== 'hydraulic' || !connected.has(key))) continue;
      if (p.domain === 'signal') {
        if (p.direction === 'input' && !signalTargets.has(key))
          return failure('GRAPH_INCOMPLETE', `/design/components/${c.id}/${p.id}`, 'U 口尚未接入电压信号。');
        continue;
      }
      const port = { key: portKey(c.id, p.id), kind: 'component' as const, ownerId: c.id, portId: p.id };
      ports.push(port);
      sets.add(port.key);
    }
  }
  for (const n of project.design.nodes) sets.add(`n:${n.id}`);
  for (const edge of hydraulicConnections) {
    const a = endpointKey(edge.from),
      b = endpointKey(edge.to);
    if (edge.kind === 'ideal') sets.join(a, b);
    else {
      // Physical pipe remains a two-terminal element; its ends are never merged.
      for (const [key, end] of [
        [a, 'A'],
        [b, 'B'],
      ] as const) {
        const p = { key: pipeKey(edge.id, end), kind: 'pipe' as const, ownerId: edge.id, portId: end };
        sets.add(p.key);
        ports.push(p);
        sets.join(key, p.key);
      }
    }
  }
  for (const p of ports)
    if (p.kind === 'component' && !connected.has(p.key)) {
      return failure(
        'GRAPH_INCOMPLETE',
        `/design/components/${p.ownerId}/${p.portId}`,
        '油口尚未连接；草稿保留但不启动计算。',
      );
    }
  for (const n of project.design.nodes)
    if (!connected.has(`n:${n.id}`)) {
      return failure('GRAPH_INCOMPLETE', `/design/nodes/${n.id}`, '分支节点尚未连接。');
    }
  const nets: IdealNet[] = [...new Set([...sets.parent.keys()].map((k) => sets.find(k)))].sort().map((id) => ({
    id,
    terminals: ports.filter((p) => sets.find(p.key) === id).sort((a, b) => a.key.localeCompare(b.key, 'en')),
    nodeIds: project.design.nodes
      .filter((n) => sets.find(`n:${n.id}`) === id)
      .map((n) => n.id)
      .sort(),
    connectionIds: hydraulicConnections
      .filter((e) => e.kind === 'ideal' && sets.find(endpointKey(e.from)) === id)
      .map((e) => e.id)
      .sort(),
  }));
  if (nets.some((n) => n.terminals.length < 2))
    return failure('GRAPH_INCOMPLETE', '/design', '连接组至少需要两个物理端子。');
  const islands = new Sets();
  for (const n of nets) islands.add(n.id);
  for (const owner of new Set(ports.map((p) => `${p.kind}:${p.ownerId}`))) {
    const owned = ports.filter((p) => `${p.kind}:${p.ownerId}` === owner).map((p) => sets.find(p.key));
    const first = owned[0];
    if (first) for (const net of owned) islands.join(first, net);
  }
  for (const island of new Set(nets.map((n) => islands.find(n.id)))) {
    const hasReference = nets
      .filter((n) => islands.find(n.id) === island)
      .some((n) =>
        n.terminals.some((p) => {
          const c = project.design.components.find((c) => c.id === p.ownerId);
          return p.kind === 'component' && (c?.typeId === 'pressure-source' || c?.typeId === 'tank');
        }),
      );
    if (!hasReference) {
      const stored = project.design.components.some(
        (c) =>
          ['volume', 'cylinder'].includes(c.typeId) &&
          nets.some((n) => islands.find(n.id) === island && n.terminals.some((p) => p.ownerId === c.id)),
      );
      return stored
        ? failure(
            'MODEL_UNSUPPORTED',
            '/design',
            '闭式储能岛可能有良好动态初值，但本映射尚无独立闭式验证，不误称欠定。',
          )
        : failure('GRAPH_UNDERDETERMINED', '/design', '无储能初值的纯阻性浮置岛没有压力参考。');
    }
  }
  return { ok: true, value: immutable({ project, nets, hydraulicConnections }) };
}
