export function setup() {}

export function teardown() {
  throw new Error(
    'prepublish gate fixture: mirrors tests/_real-store-guard.ts failing on a store-isolation leak',
  );
}
