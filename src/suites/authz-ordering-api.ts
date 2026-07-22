/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- authorization-ordering negatives.
 *
 * The spec's "maximum privacy" rule (spec "Error Handling") requires servers
 * to verify a caller's authorization *before* any check whose distinct error
 * would reveal that a target exists: conflict detection (409), encrypted-write
 * envelope validation (422), cursor / query-body validation (400/501), and
 * quota reads (403). A server that runs those checks first leaks existence
 * through the differing status code. Every test here invokes as Bob -- a
 * well-formed, signed request that simply lacks privilege over Alice's Space
 * -- and expects the privacy-merged `not-found` (404) mask.
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  bob: any
  resourceId: string
}

/**
 * Asserts a rejected request carries the privacy-merged `not-found` mask:
 * status 404, `application/problem+json`, and the single merged `type` (the
 * registry forbids splitting `not-found` into distinguishable kinds).
 *
 * @param expectedError {any}   the error thrown by `ZcapClient.request()`
 */
function assertNotFoundMask(expectedError: any): void {
  assert.ok(expectedError, 'expected the under-authorized request to fail')
  assert.equal(expectedError.response.status, 404)
  assert.match(
    expectedError.response.headers.get('content-type'),
    /application\/problem\+json/
  )
  assert.equal(expectedError.data.type, 'https://wallet.storage/spec#not-found')
}

export const authzOrderingApi: Suite<State> = {
  id: 'authz-ordering-api',
  name: 'Authorization ordering (no-leak negatives)',
  specRefs: ['https://wallet.storage/spec#error-handling'],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    alice.space1 = { id: ctx.generateId() }
    const resourceId = ctx.generateId()
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Ordering Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    // A plain Collection holding one Resource (the existing ids Bob probes for)
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: { id: 'credentials', name: 'Verifiable Credentials' }
    })
    await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/credentials/${resourceId}`,
        ctx.serverUrl
      ).toString(),
      method: 'PUT',
      action: 'PUT',
      json: { id: resourceId, name: 'Existing Resource' }
    })
    // An encryption-marked Collection (for the envelope-validation ordering test)
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: { id: 'vault', name: 'Vault', encryption: { scheme: 'edv' } }
    })
    return { alice, bob, resourceId }
  },

  teardown: async (ctx, state) => {
    const { alice } = state
    try {
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}`, ctx.serverUrl).toString(),
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  },

  tests: [
    {
      id: 'ordering.collection-post-conflict-404',
      name: "[root] Bob's POST of an existing Collection id yields 404, not id-conflict (409)",
      specRefs: [
        'https://wallet.storage/spec#id-conflict',
        'https://wallet.storage/spec#not-found'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, bob } = state
        // Authorization MUST run before conflict detection: a 409 here would
        // let Bob probe Alice's Space for existing Collection ids.
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
            method: 'POST',
            action: 'POST',
            json: { id: 'credentials', name: 'Probe Collection' }
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.resource-post-conflict-404',
      name: "[root] Bob's POST of an existing Resource id yields 404, not id-conflict (409)",
      specRefs: [
        'https://wallet.storage/spec#id-conflict',
        'https://wallet.storage/spec#not-found'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, bob, resourceId } = state
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/credentials/`,
              serverUrl
            ).toString(),
            method: 'POST',
            action: 'POST',
            json: { id: resourceId, name: 'Probe Resource' }
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.encrypted-write-404',
      name: "[root] Bob's plaintext write to an encrypted Collection yields 404, not scheme-mismatch (422)",
      specRefs: [
        'https://wallet.storage/spec#encryption-scheme-mismatch',
        'https://wallet.storage/spec#not-found'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, bob } = state
        // Authorization MUST run before envelope validation: a 422 here would
        // reveal both that `vault` exists and that it is encryption-marked.
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/vault/plaintext-doc`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { hello: 'world' }
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.list-bad-cursor-404',
      name: "[root] Bob's List Collection with a malformed cursor yields 404, not invalid-cursor (400)",
      specRefs: [
        'https://wallet.storage/spec#invalid-cursor',
        'https://wallet.storage/spec#not-found'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, bob } = state
        // Authorization MUST run before cursor validation: pagination params
        // describe the request, but validating them first would answer before
        // the 404 mask is decided.
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/credentials/?cursor=not-valid-%%%`,
              serverUrl
            ).toString(),
            method: 'GET'
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.query-bad-body-404',
      name: "[root] Bob's query POST with an invalid body yields 404, not 400/501",
      specRefs: ['https://wallet.storage/spec#not-found'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, bob } = state
        // An authorized caller sending this body gets a precise query-body
        // error (an unknown profile is 501); Bob must get the 404 mask first.
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/credentials/query`,
              serverUrl
            ).toString(),
            method: 'POST',
            action: 'POST',
            json: { profile: 'no-such-profile' }
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.space-quotas-read-404',
      name: "[root] Bob's read of Alice's Space quota report yields 404, never 403",
      specRefs: [
        'https://wallet.storage/spec#quotas',
        'https://wallet.storage/spec#not-found'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, bob } = state
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/quotas`,
              serverUrl
            ).toString(),
            method: 'GET'
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.collection-quota-read-404',
      name: "[root] Bob's read of Alice's Collection quota yields 404, never 403 or 501",
      specRefs: [
        'https://wallet.storage/spec#quotas',
        'https://wallet.storage/spec#not-found'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, bob } = state
        // Per-Collection accounting is optional (501 when unsupported), but
        // that answer is reserved for authorized callers -- Bob gets the mask.
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/credentials/quota`,
              serverUrl
            ).toString(),
            method: 'GET'
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.resource-delete-404',
      name: "[root] Bob's DELETE of Alice's Resource yields 404 and does not delete it",
      specRefs: ['https://wallet.storage/spec#not-found'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, bob, resourceId } = state
        const resourceUrl = new URL(
          `/space/${alice.space1.id}/credentials/${resourceId}`,
          serverUrl
        ).toString()
        let expectedError: any
        try {
          await bob.rootClient.request({ url: resourceUrl, method: 'DELETE' })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)

        // The operation must not have been performed: Alice still sees it.
        const checkResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(checkResponse.status, 200)
        assert.equal(checkResponse.data.name, 'Existing Resource')
      }
    }
  ]
}
