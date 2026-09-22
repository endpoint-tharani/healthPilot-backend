import { defineConfig } from 'vitest/config';

/**
 * Two kinds of test live here, and they are told apart by their file name rather
 * than by a directory, so a reader can see which is which in a failure report.
 *
 *   *.test.ts              pure logic, no database, milliseconds
 *   *.integration.test.ts  real Postgres, real transactions
 *
 * The integration suite runs single-threaded and without parallel files. Its
 * tenants are created per run under a unique code, but the journal numbering it
 * exercises takes a per-company advisory lock, and two files racing over the same
 * connection pool against a serverless database turns a correctness suite into a
 * timeout suite. Correctness is the point here; speed is not.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // A network database over TLS is slow to wake; the default 5s fails honest tests.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
    reporters: ['verbose'],
  },
});
