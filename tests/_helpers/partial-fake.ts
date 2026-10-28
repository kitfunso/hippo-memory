// A partial fake of a store, port or context, typed against the real type so a renamed or retyped member fails typecheck:tests.

/** The members of `T` a fake may set; a method keeps its exact signature, an object member may set only some of its own. */
export type PartialFake<T> = T extends (...args: never[]) => infer _Result
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { readonly [K in keyof T]?: PartialFake<T[K]> }
      : T;

/** `partialFake<Real>()({ ... })` is the fake as `Real`; only what the code under test reaches needs to be set. */
export function partialFake<T>(): (fake: PartialFake<T>) => T {
  // SAFETY: the fake sets only the members the code under test reaches, as its caller states.
  return (fake) => fake as T;
}
