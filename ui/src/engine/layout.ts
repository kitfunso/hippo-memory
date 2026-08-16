import {
  forceSimulation,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";

export interface LayoutNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  layer: "buffer" | "episodic" | "semantic";
  tags: string[];
  strength: number;
}

const LAYER_Y = {
  buffer: 0.18,
  episodic: 0.50,
  semantic: 0.82,
} satisfies Record<LayoutNode["layer"], number>;

interface NodeWithTarget extends LayoutNode {
  targetY: number;
}

export function createForceLayout(
  nodes: LayoutNode[],
  width: number,
  height: number,
  ticks: number = 250,
): LayoutNode[] {
  if (nodes.length === 0) return nodes;

  const pad = 80;
  // SAFETY: `extended` aliases the same node objects as `nodes` (no copy) so
  // in-place mutation below is visible on the array this function returns.
  // `targetY` doesn't exist yet at this line, but the loop immediately
  // below assigns it to every element before any reader (forceY's `d =>
  // d.targetY` accessor, or code after this function returns) can observe
  // an element missing it.
  const extended = nodes as NodeWithTarget[];

  for (const node of extended) {
    const zoneY = LAYER_Y[node.layer] * height;
    const spread = height * 0.12;
    node.targetY = zoneY + (Math.random() - 0.5) * spread;
    node.x = Math.max(pad, Math.min(width - pad, node.x + (Math.random() - 0.5) * width * 0.4));
    node.y = node.targetY;
  }

  const simulation = forceSimulation<NodeWithTarget>(extended)
    .force("charge", forceManyBody<NodeWithTarget>().strength(-120).distanceMax(350))
    .force("collide", forceCollide<NodeWithTarget>().radius(20).strength(0.85))
    .force(
      "y",
      forceY<NodeWithTarget>((d) => d.targetY).strength(0.06),
    )
    .force(
      "x",
      forceX<NodeWithTarget>(width / 2).strength(0.003),
    )
    .stop();

  for (let i = 0; i < ticks; i++) {
    simulation.tick();
  }

  for (const node of extended) {
    node.x = Math.max(pad, Math.min(width - pad, node.x));
    node.y = Math.max(pad, Math.min(height - pad, node.y));
  }

  return nodes;
}
