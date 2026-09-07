import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The `development` condition points @config/src/* at the TypeScript sources rather than the
  // built output, so the suite runs what is being edited.
  resolve: { conditions: ['development'] },
  test: {
    // The socket tests bind real Unix sockets under a temp dir; each file gets its own path,
    // but git operations in later slices share one working copy, so files run serially.
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
