### Fixed

- **A test run now stops at once when node_modules does not match package-lock.json.** With an older vitest installed (3.2 where the lockfile pins 5.0.3), vitest.config.ts ran once per project, the store guard ran twice and watched a different global store than the workers, and every run ended in a false "Test-isolation leak". The build-freshness check now names each drifted package and says to run `npm ci`.
