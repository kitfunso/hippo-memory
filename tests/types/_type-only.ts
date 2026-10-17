/** Holds a call that must not compile, so the `@ts-expect-error` above it is checked and the call never runs. */
export function typeOnly(_check: () => void): void {}
