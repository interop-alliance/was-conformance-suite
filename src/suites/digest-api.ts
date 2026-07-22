/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- request-body integrity (Digest) negatives.
 *
 * The spec's "Request Body Integrity (Digest Header)" profile binds a request
 * body to its HTTP Signature: for any request carrying a `Content-Type`, the
 * server MUST require `digest` among the signature's covered headers, and
 * SHOULD independently recompute the digest of the received body and compare
 * it. Both failures are rejected with `invalid-authorization-header` (400).
 * A well-behaved client never produces such requests, so these tests sign
 * with the low-level `signCapabilityInvocation` primitive and send the
 * malformed request with a raw `fetch`.
 */
import { createHeaderValue } from '@interop/http-digest-header'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
}

/**
 * Asserts a rejected request reports the digest-binding failure: status 400,
 * `application/problem+json`, and the `invalid-authorization-header` type
 * (the registry's single type for all authorization-header failures).
 *
 * @param response {Response}   the raw fetch response
 */
async function assertInvalidAuthorizationHeader(
  response: Response
): Promise<void> {
  assert.equal(response.status, 400)
  assert.match(
    response.headers.get('content-type') ?? '',
    /application\/problem\+json/
  )
  const problem: any = await response.json()
  assert.equal(
    problem.type,
    'https://wallet.storage/spec#invalid-authorization-header'
  )
}

export const digestApi: Suite<State> = {
  id: 'digest-api',
  name: 'Request body integrity (Digest) negatives',
  specRefs: [
    'https://wallet.storage/spec#request-body-integrity-digest-header'
  ],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    alice.space1 = { id: ctx.generateId() }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Digest Space",
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
      id: 'digest.signature-not-covering-digest',
      name:
        '[root] a signed body request whose signature does not cover the ' +
        '`digest` header is rejected with 400 invalid-authorization-header',
      specRefs: [
        'https://wallet.storage/spec#request-body-integrity-digest-header',
        'https://wallet.storage/spec#invalid-authorization-header'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const url = new URL(
          `/space/${alice.space1.id}/docs/${ctx.generateId()}`,
          serverUrl
        ).toString()
        const body = JSON.stringify({ name: 'Uncovered Digest Probe' })
        // Sign as if the request were bodyless: a valid signature whose
        // covered headers omit `content-type` and `digest`.
        const signatureHeaders = await signCapabilityInvocation({
          url,
          method: 'PUT',
          headers: { date: new Date().toUTCString() },
          invocationSigner: alice.rootClient.invocationSigner,
          capabilityAction: 'PUT'
        })
        // The `Digest` header itself is present and correct for the body sent
        // -- only its signature coverage is missing, which the server MUST
        // require for any request carrying a `Content-Type`.
        const digest = await createHeaderValue({
          data: body,
          algorithm: 'sha256',
          useMultihash: true
        })
        const response = await fetch(url, {
          method: 'PUT',
          headers: {
            ...(signatureHeaders as Record<string, string>),
            'content-type': 'application/json',
            digest
          },
          body
        })
        await assertInvalidAuthorizationHeader(response)
      }
    },
    {
      id: 'digest.body-tampered-after-signing',
      name:
        '[root] a request whose body does not match its signed `digest` ' +
        '(tampered after signing) is rejected with 400',
      // Independent recomputation of the received body's digest is a SHOULD.
      optional: true,
      specRefs: [
        'https://wallet.storage/spec#request-body-integrity-digest-header',
        'https://wallet.storage/spec#invalid-authorization-header'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const url = new URL(
          `/space/${alice.space1.id}/docs/${ctx.generateId()}`,
          serverUrl
        ).toString()
        // A fully well-formed signing of the original body: the signature
        // covers `digest`, and the `Digest` header matches the original.
        const signatureHeaders = await signCapabilityInvocation({
          url,
          method: 'PUT',
          headers: { date: new Date().toUTCString() },
          json: { name: 'Original Body' },
          invocationSigner: alice.rootClient.invocationSigner,
          capabilityAction: 'PUT'
        })
        // ...but the body actually sent was swapped after signing.
        const response = await fetch(url, {
          method: 'PUT',
          headers: signatureHeaders as Record<string, string>,
          body: JSON.stringify({ name: 'Tampered Body' })
        })
        await assertInvalidAuthorizationHeader(response)

        // The tampered write must not have been performed.
        let expectedError: any
        try {
          await alice.rootClient.request({ url, method: 'GET' })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the tampered resource to not exist')
        assert.equal(expectedError.response.status, 404)
      }
    }
  ]
}
