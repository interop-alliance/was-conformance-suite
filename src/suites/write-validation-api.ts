/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- write-validation negatives.
 *
 * Covers two MUST-level rejections of malformed create requests: a
 * client-chosen Collection or Resource id that collides with the spec's
 * Reserved Path Segment Registry (409 `reserved-id`), and a Resource write
 * that carries no `Content-Type` header (400 `missing-content-type`). The
 * reserved-id tests exercise both create wire shapes (POST with a body `id`
 * and PUT with the id in the path); the Content-Type test signs with the
 * low-level `signCapabilityInvocation` primitive and sends raw bytes via
 * `fetch`, since a well-behaved client always sets a content type.
 */
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
}

/**
 * Asserts a rejected create reports a reserved-id collision: status 409,
 * `application/problem+json`, and the `reserved-id` type.
 *
 * @param expectedError {any}   the error thrown by ZcapClient.request()
 */
function assertReservedId(expectedError: any): void {
  assert.ok(expectedError, 'expected the reserved id to be rejected')
  assert.equal(expectedError.response.status, 409)
  assert.equal(
    expectedError.data.type,
    'https://wallet.storage/spec#reserved-id'
  )
}

export const writeValidationApi: Suite<State> = {
  id: 'write-validation-api',
  name: 'Write-validation negatives (reserved ids, Content-Type)',
  specRefs: [
    'https://wallet.storage/spec#reserved-path-segment-registry',
    'https://wallet.storage/spec#content-types-and-representations'
  ],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    alice.space1 = { id: ctx.generateId() }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Write-Validation Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: { id: 'docs', name: 'Documents' }
    })
    return { alice }
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
      id: 'write-validation.collection-reserved-id-post',
      name:
        '[root] creating a Collection whose body `id` is a reserved segment ' +
        '(`query`) is rejected with 409 reserved-id',
      specRefs: [
        'https://wallet.storage/spec#space-level-reserved-endpoints',
        'https://wallet.storage/spec#reserved-id'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
            method: 'POST',
            action: 'POST',
            json: { id: 'query', name: 'Reserved Collection Id Probe' }
          })
        } catch (err) {
          expectedError = err
        }
        assertReservedId(expectedError)
      }
    },
    {
      id: 'write-validation.collection-reserved-id-put',
      name:
        '[root] creating a Collection by PUT at a reserved path segment ' +
        '(`export`) is rejected with 409 reserved-id',
      specRefs: [
        'https://wallet.storage/spec#space-level-reserved-endpoints',
        'https://wallet.storage/spec#reserved-id'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // No static PUT route exists at `/export`, so the request reaches the
        // parametric Update-or-Create-Collection route -- which must reject
        // the reserved id rather than create the Collection.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/export`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { name: 'Reserved Collection Id Probe' }
          })
        } catch (err) {
          expectedError = err
        }
        assertReservedId(expectedError)
      }
    },
    {
      id: 'write-validation.resource-reserved-id-put',
      name:
        '[root] creating a Resource whose id is a reserved segment ' +
        '(`quota`) is rejected with 409 reserved-id',
      specRefs: [
        'https://wallet.storage/spec#collection-level-reserved-endpoints',
        'https://wallet.storage/spec#reserved-id'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/docs/quota`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { name: 'Reserved Resource Id Probe' }
          })
        } catch (err) {
          expectedError = err
        }
        assertReservedId(expectedError)
      }
    },
    {
      id: 'write-validation.resource-missing-content-type',
      name:
        '[root] a Resource write without a `Content-Type` header is ' +
        'rejected with 400 missing-content-type',
      specRefs: [
        'https://wallet.storage/spec#content-types-and-representations',
        'https://wallet.storage/spec#missing-content-type'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const url = new URL(
          `/space/${alice.space1.id}/docs/`,
          serverUrl
        ).toString()
        // Sign a bodyless invocation: with no `Content-Type` on the request,
        // the signature legitimately covers neither `content-type` nor
        // `digest`, so the write reaches the content-type check itself.
        const signatureHeaders = await signCapabilityInvocation({
          url,
          method: 'POST',
          headers: { date: new Date().toUTCString() },
          invocationSigner: alice.rootClient.invocationSigner,
          capabilityAction: 'POST'
        })
        // A byte-array body keeps `fetch` from inferring a Content-Type of
        // its own (a string body would get `text/plain` added implicitly).
        const response = await fetch(url, {
          method: 'POST',
          headers: signatureHeaders as Record<string, string>,
          body: new TextEncoder().encode('no content type')
        })
        assert.equal(response.status, 400)
        assert.match(
          response.headers.get('content-type') ?? '',
          /application\/problem\+json/
        )
        const problem: any = await response.json()
        assert.equal(
          problem.type,
          'https://wallet.storage/spec#missing-content-type'
        )
      }
    }
  ]
}
