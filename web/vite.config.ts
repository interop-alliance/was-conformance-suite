import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

/**
 * Standalone build/dev config for the web app. `root` is this `web/` directory
 * so `index.html` sits at the served root; `base: './'` emits relative asset
 * URLs so the static bundle works from a GitHub Pages project subpath. During
 * repo-root dev/e2e the app is instead served by the root Vite server at
 * `/web/index.html`; the relative `./src/main.ts` script tag works in both.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  define: {
    // The npm `assert` package (the suite's isomorphic assertion module) pulls
    // in browserify's `util`, which reads `process.env.NODE_DEBUG` and
    // `process.emitWarning` at module scope. Browsers have no `process`; this
    // compile-time replacement is the standard bundler shim.
    'process.env.NODE_DEBUG': 'undefined',
    'process.emitWarning': 'undefined'
  },
  server: {
    port: 5174
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
