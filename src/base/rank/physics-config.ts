/**
 * Physics engine configuration for Hippo memory-as-physics. All constants are tunable; defaults
 * calibrated for ~500 memory corpus.
 */

export interface PhysicsConfig {
  enabled: boolean | 'auto';
  gQuery: number;
  gMemory: number;
  kRepulsion: number;
  drag: number;
  interferenceGain: number;
  momentumWeight: number;
  maxVelocity: number;
  dt: number;
  substeps: number;
  feedbackAlpha: number;
  temperatureDecay: number;
  clusterThreshold: number;
  clusterTopK: number;
}

export const DEFAULT_PHYSICS_CONFIG: Readonly<PhysicsConfig> = {
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
