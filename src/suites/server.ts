/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Server.
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

export const server: Suite = {
  id: 'server',
  name: 'Server',

  // GET / returning 200 is not clearly spec-mandated; an API-only server may 404 at root.
  optional: true,

  tests: [
    {
      id: 'server.get-root',
      name: 'should GET /',
      run: async ctx => {
        const { serverUrl } = ctx
        const response = await fetch(serverUrl)
        assert.equal(response.status, 200)
      }
    }
  ]
}
