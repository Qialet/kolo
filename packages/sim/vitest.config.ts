import { defineConfig } from 'vitest/config';

/** Its processor-time budget (7 s) only means something without other city runs competing for the cores. */
const TIMED = 'src/engine/transit.test.ts';

export default defineConfig({
  // Half the logical cores: the city runs are heavy, and timing checks stay meaningful when workers do not share a core.
  test: {
    testTimeout: 60_000,
    maxWorkers: '50%',
    projects: [
      { extends: true, test: { name: 'sim', include: ['src/**/*.test.ts'], exclude: [TIMED] } },
      // Runs alone, after everything else.
      { extends: true, test: { name: 'timed', include: [TIMED], sequence: { groupOrder: 1 } } },
    ],
  },
});
