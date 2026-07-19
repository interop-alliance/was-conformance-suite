/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The suite's single assertion module: the npm `assert` package, an
 * isomorphic implementation of `node:assert`, so Node (CLI) and browser (web
 * app) runs share one assertion behavior. The deep import matters: a bare
 * `import 'assert'` resolves to the Node builtin in Node but the npm package
 * in bundlers, which would split behavior between the two frontends.
 */
import assert from 'assert/build/assert.js'

export default assert
