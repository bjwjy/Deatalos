const component = (id, definition, version, label, x, y) => ({
  kind: 'add-component',
  id,
  definitionId: 'teaching:' + definition,
  definitionVersion: version,
  label,
  x,
  y,
});
const port = (componentId, portId) => ({ kind: 'port', componentId, portId });
const node = (nodeId) => ({ kind: 'node', nodeId });
const wire = (id, from, to) => ({ kind: 'connect', id, from, to, pipe: null });

/** Four actual valve/actuator branches sharing one pressure source and return. */
export function fourBranchDrawing() {
  const branches = [
    ['lift', 'cylinder', '双作用升降缸', 'directional-3-4'],
    ['clamp', 'single-acting-cylinder', '单作用夹紧缸', 'directional-3-3'],
    ['drive', 'variable-motor', '手动排量回转马达', 'directional-3-4'],
    ['feed', 'cushioned-cylinder', '缓冲进给缸', 'directional-3-4'],
  ];
  const parts = [
    component('source', 'pressure-source', 1, '共用恒压源', 70, 500),
    component('tank', 'tank', 1, '共用油箱', 70, 680),
    component('sensor', 'adjustable-pressure-switch', 1, '供油压力开关', 90, 360),
  ];
  const nodes = [
    { kind: 'add-node', id: 'supply', label: '共用供油', x: 150, y: 500 },
    { kind: 'add-node', id: 'return', label: '共用回油', x: 150, y: 640 },
  ];
  const wires = [
    wire('supply-main', port('source', 'P'), node('supply')),
    wire('return-main', node('return'), port('tank', 'T')),
    wire('sensor-tap', node('supply'), port('sensor', 'H')),
  ];
  for (const [index, [id, actuator, label, valve]] of branches.entries()) {
    const x = 280 + index * 240;
    const v = id + '-valve';
    parts.push(component(id, actuator, 1, label, x, 100), component(v, valve, 2, label + '换向阀', x, 320));
    wires.push(
      wire(id + '-supply', node('supply'), port(v, 'P')),
      wire(id + '-return', port(v, 'T'), node('return')),
      wire(id + '-A', port(v, 'A'), port(id, 'A')),
    );
    if (id !== 'clamp') wires.push(wire(id + '-B', port(v, 'B'), port(id, 'B')));
  }
  return { parts, nodes, wires, full: [...parts, ...nodes, ...wires] };
}

/** A detailed variant with explicit pipe sections, route anchors and line labels. */
export function detailedDrawing() {
  const { parts, nodes, wires } = fourBranchDrawing();
  const locations = new Map([...parts, ...nodes].map((item) => [item.id, item]));
  const commands = [...parts, ...nodes];
  for (const [index, edge] of wires.entries()) {
    const a = locations.get(edge.from.componentId ?? edge.from.nodeId);
    const b = locations.get(edge.to.componentId ?? edge.to.nodeId);
    const mid = { x: (a.x + b.x) / 2 + 10 * (index % 3), y: (a.y + b.y) / 2 + 12 * (index % 4) };
    const joint = edge.id + '-joint';
    commands.push({ kind: 'add-node', id: joint, label: edge.id, ...mid });
    const segments = [wire(edge.id + '-in', edge.from, node(joint)), wire(edge.id + '-out', node(joint), edge.to)];
    commands.push(...segments);
    for (const [i, segment] of segments.entries()) {
      const point = i === 0 ? { x: mid.x, y: a.y } : { x: b.x, y: mid.y };
      commands.push({ kind: 'route', route: { connectionId: segment.id, mode: 'manual', points: [point] } });
    }
    if (edge.id !== 'sensor-tap')
      commands.push({
        kind: 'text',
        edit: {
          kind: 'put',
          replace: false,
          value: {
            id: edge.id + '-label',
            kind: 'text',
            version: 1,
            x: mid.x + 8,
            y: mid.y - 20,
            width: 110,
            text: edge.id,
            fontSize: 12,
            color: '#222222',
            align: 'left',
            border: false,
            background: null,
          },
        },
      });
  }
  return commands;
}
export function sizedDrawing(count) {
  const commands = detailedDrawing();
  if (commands.length !== 120) throw Error('Expected 120 distinct drawing commands');
  if (count === 121) commands.push({ kind: 'move', id: 'feed', x: 1040, y: 100 });
  return commands.slice(0, count);
}
