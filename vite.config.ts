import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    // The npm `assert` package (the suite's isomorphic assertion module) pulls
    // in browserify's `util`, which reads `process.env.NODE_DEBUG` at module
    // scope. Browsers have no `process`; this compile-time replacement is the
    // standard bundler shim. Any app bundling this library needs the same.
    'process.env.NODE_DEBUG': 'undefined',
    'process.emitWarning': 'undefined'
  },
  test: {
    include: ['test/node/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts']
    }
  }
})
