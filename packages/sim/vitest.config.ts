import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Half the logical cores: the city runs are heavy, and timing checks stay meaningful when workers do not share a core.
  test: { include: ['src/**/*.test.ts'], testTimeout: 60_000, maxWorkers: '50%' },
});
