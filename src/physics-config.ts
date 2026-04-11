/**
 * Physics engine configuration for Hippo memory-as-physics.
 * All constants are tunable; defaults calibrated for ~500 memory corpus.
 */

export interface PhysicsConfig {
  /** Use physics scoring when embeddings available. 'auto' = yes if embeddings exist. */
  enabled: boolean | 'auto';
  /** Query gravitational constant — controls how strongly queries attract memories. */
  G_query: number;
  /** Inter-memory attraction constant — controls clustering speed during sleep. */
  G_memory: number;
  /** Conflict repulsion constant — pushes contradicting memories apart. */
  K_repulsion: number;
  /** Velocity damping coefficient — prevents runaway drift. */
  drag: number;
  /** Cluster amplification sensitivity — how much nearby memories reinforce each other. */
  interference_gain: number;
  /** Weight for velocity alignment bonus in scoring. */
  momentum_weight: number;
  /** Maximum velocity magnitude (embedding-space units). */
  max_velocity: number;
  /** Integration timestep per substep. */
  dt: number;
  /** Number of Velocity Verlet substeps per sleep cycle. */
  substeps: number;
  /** Position nudge magnitude for outcome feedback. */
  feedback_alpha: number;
  /** Temperature decay rate: temperature = 1 / (age_days * temperature_decay + 1). */
  temperature_decay: number;
  /** Minimum cosine similarity for cluster amplification pairing. */
  cluster_threshold: number;
  /** Number of top results to consider for cluster amplification. */
  cluster_top_k: number;
  /** Short-range repulsion constant — prevents particle collapse. Like electron shell repulsion. */
  K_short_range: number;
  /** Cosine distance below which short-range repulsion activates. */
  short_range_threshold: number;
}

export const DEFAULT_PHYSICS_CONFIG: Readonly<PhysicsConfig> = {
  enabled: 'auto',
  G_query: 2.0,
  G_memory: 0.01,
  K_repulsion: 0.5,
  drag: 0.3,
  interference_gain: 0.3,
  momentum_weight: 0.1,
  max_velocity: 0.1,
  dt: 0.1,
  substeps: 5,
  feedback_alpha: 0.01,
  temperature_decay: 1.0,
  cluster_threshold: 0.7,
  cluster_top_k: 20,
  K_short_range: 0.05,
  short_range_threshold: 0.05,
};

export function mergePhysicsConfig(partial?: Partial<PhysicsConfig>): PhysicsConfig {
  if (!partial) return { ...DEFAULT_PHYSICS_CONFIG };
  return { ...DEFAULT_PHYSICS_CONFIG, ...partial };
}
