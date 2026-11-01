// The effect of a store method, stated once beside its port signature.

/** 'write' changes the store; 'read' leaves it as it was. */
export type MethodEffect = 'read' | 'write';

/** One effect for every method of a group, so a method missing from its table fails tsc. */
export type MethodEffects<G> = { readonly [M in keyof G]-?: MethodEffect };
