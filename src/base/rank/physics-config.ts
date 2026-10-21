/**
 * Physics engine configuration for Hippo memory-as-physics. All constants are tunable; defaults calibrated for ~500
 * memory corpus.
 */

export interface PhysicsConfig {
  /** Use physics scoring when embeddings available. 'auto' = yes if embeddings exist. */
  enabled: boolean | 'auto';
  /** Query gravitational constant — controls how strongly queries attract memories. */
  gQuery: number;
  /** Inter-memory attraction constant — controls clustering speed during sleep. */
  gMemory: number;
  /** Conflict repulsion constant — pushes contradicting memories apart. */
  kRepulsion: number;
  /** Velocity damping coefficient — prevents runaway drift. */
  drag: number;
  /** Cluster amplification sensitivity — how much nearby memories reinforce each other. */
  interferenceGain: number;
  /** Weight for velocity alignment bonus in scoring. */
  momentumWeight: number;
  /** Maximum velocity magnitude (embedding-space units). */
  maxVelocity: number;
  /** Integration timestep per substep. */
  dt: number;
  /** Number of Velocity Verlet substeps per sleep cycle. */
  substeps: number;
  /** Position nudge magnitude for outcome feedback. */
  feedbackAlpha: number;
  /** Temperature decay rate: temperature = 1 / (age_days * temperatureDecay + 1). */
  temperatureDecay: number;
  /** Minimum cosine similarity for cluster amplification pairing. */
  clusterThreshold: number;
  /** Number of top results to consider for cluster amplification. */
  clusterTopK: number;
}

export const DEFAULT_PHYSICS_CONFIG: Readonly<PhysicsConfig> = {
  // Off by default: the paired ablation (benchmarks/physics-ablation/) found physics worse than classic hybrid on every
  // metric, CI excluding zero (MRR 0.68 vs 0.84, R@5 74% vs 84%). Opt in with physics.enabled 'auto' or true.
  enabled: false,
  gQuery: 2.0,
  gMemory: 0.01,
  kRepulsion: 0.5,
  drag: 0.3,
  interferenceGain: 0.3,
  momentumWeight: 0.1,
  maxVelocity: 0.1,
  dt: 0.1,
  substeps: 5,
  feedbackAlpha: 0.01,
  temperatureDecay: 1.0,
  clusterThreshold: 0.7,
  clusterTopK: 20,
};

export function mergePhysicsConfig(partial?: Partial<PhysicsConfig>): PhysicsConfig {
  if (!partial) return { ...DEFAULT_PHYSICS_CONFIG };
  return { ...DEFAULT_PHYSICS_CONFIG, ...partial };
}
