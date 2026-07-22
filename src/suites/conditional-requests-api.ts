/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- conditional requests & caching (spec "Caching" and
 * "Conditional Requests").
 *
 * Conditional writes are an OPTIONAL feature: a backend advertises the
 * `conditional-writes` token in its Backend description, and only then are the
 * 412 semantics required (MUST). This suite is therefore not marked
 * suite-level optional. Its `setup` probes the Space's default backend for the
 * token and stashes the result; the write tests call `ctx.skip(...)` when the
 * backend does not advertise it, while the two ETag tests reflect the weaker
 * `SHOULD emit ETag` guidance and are marked `optional: true`.
 *
 * The tests work at the Resource level in a plain JSON Collection, driving raw
 * `ZcapClient.request()` calls so the `If-Match` / `If-None-Match` precondition
 * headers can be attached directly. Those preconditions describe the request
 * rather than the capability target, so they need not be covered by the
 * signature; the server reads them off the request headers after authorization.
 */
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import type { ISigner } from '@interop/data-integrity-core'
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  bob: any
  collectionUrl: string
  conditionalWritesSupported: boolean
  defaultBackend: any
}

/**
 * Asserts a rejected conditional write reports a precondition failure: status
 * 412, an `application/problem+json` body, and the `precondition-failed` type.
 *
 * @param expectedError {any}   the error thrown by `ZcapClient.request()`
 */
function assertPreconditionFailed(expectedError: any): void {
  assert.ok(expectedError, 'expected the conditional write to fail with 412')
  assert.equal(expectedError.response.status, 412)
  assert.match(
    expectedError.response.headers.get('content-type'),
    /application\/problem\+json/
  )
  assert.equal(
    expectedError.data.type,
    'https://wallet.storage/spec#precondition-failed'
  )
}

/**
 * Asserts a rejected request carries the privacy-merged `not-found` mask:
 * status 404, `application/problem+json`, and the merged `not-found` type. An
 * under-authorized conditional write MUST surface this mask, never a 412 that
 * would confirm the target exists.
 *
 * @param expectedError {any}   the error thrown by `ZcapClient.request()`
 */
function assertNotFoundMask(expectedError: any): void {
  assert.ok(expectedError, 'expected the under-authorized write to fail')
  assert.equal(expectedError.response.status, 404)
  assert.match(
    expectedError.response.headers.get('content-type'),
    /application\/problem\+json/
  )
  assert.equal(expectedError.data.type, 'https://wallet.storage/spec#not-found')
}

/**
 * Signs and sends a bodyless root HEAD invocation via raw `fetch`, returning
 * the response so headers (the `ETag`) can be read. The low-level primitive is
 * used because the high-level client parses the response body as JSON, which a
 * bodyless HEAD 200 has none of.
 *
 * @param options {object}
 * @param options.url {string}   the Resource URL to HEAD
 * @param options.invocationSigner {ISigner}   the caller's signer
 * @returns {Promise<Response>}
 */
async function headResource({
  url,
  invocationSigner
}: {
  url: string
  invocationSigner: ISigner
}): Promise<Response> {
  const signatureHeaders = await signCapabilityInvocation({
    url,
    method: 'HEAD',
    headers: { date: new Date().toUTCString() },
    invocationSigner,
    capabilityAction: 'HEAD'
  })
  return fetch(url, {
    method: 'HEAD',
    headers: signatureHeaders as Record<string, string>
  })
}

export const conditionalRequestsApi: Suite<State> = {
  id: 'conditional-requests-api',
  name: 'Conditional requests & caching',
  specRefs: [
    'https://wallet.storage/spec#caching',
    'https://wallet.storage/spec#conditional-requests'
  ],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    alice.space1 = { id: ctx.generateId() }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Conditional-Requests Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    // A plain JSON Collection to hold the per-test Resources.
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: { id: 'items', name: 'Items' }
    })
    const collectionUrl = new URL(
      `/space/${alice.space1.id}/items/`,
      ctx.serverUrl
    ).toString()

    // Probe the Space's default backend for the `conditional-writes` feature
    // token. The write tests below skip when it is absent (the feature is
    // OPTIONAL); the 412 semantics are only required once advertised.
    const backendsResponse = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/backends`,
        ctx.serverUrl
      ).toString(),
      method: 'GET'
    })
    const backends: any[] = backendsResponse.data
    const defaultBackend = backends.find(backend => backend.id === 'default')
    const conditionalWritesSupported = Boolean(
      defaultBackend?.features?.includes('conditional-writes')
    )

    return {
      alice,
      bob,
      collectionUrl,
      conditionalWritesSupported,
      defaultBackend
    }
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
      id: 'conditional.backend-advertises-conditional-writes',
      name:
        '[root] the default backend descriptor advertises the ' +
        '`conditional-writes` feature',
      specRefs: [
        'https://wallet.storage/spec#conditional-requests',
        'https://wallet.storage/spec#backend-data-model'
      ],
      run: async (ctx, state) => {
        const { defaultBackend } = state
        assert.ok(defaultBackend, 'expected a `default` backend descriptor')
        assert.ok(
          Array.isArray(defaultBackend.features),
          'expected the backend descriptor to carry a `features` array'
        )
        assert.ok(
          defaultBackend.features.includes('conditional-writes'),
          'expected `features` to include the `conditional-writes` token'
        )
      }
    },
    {
      id: 'conditional.stale-if-match-412',
      name:
        '[root] a PUT with a stale `If-Match` performs no write and returns ' +
        '412 precondition-failed',
      specRefs: [
        'https://wallet.storage/spec#conditional-requests',
        'https://wallet.storage/spec#precondition-failed'
      ],
      run: async (ctx, state) => {
        const { alice, collectionUrl, conditionalWritesSupported } = state
        if (!conditionalWritesSupported) {
          ctx.skip('backend does not advertise conditional-writes')
        }
        const resourceUrl = `${collectionUrl}stale-if-match`

        // Create (version 1) then update (version 2): the ETag the client
        // captured at version 1 is now stale.
        const created = await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v1' }
        })
        const staleEtag = created.headers.get('etag')
        assert.equal(staleEtag, '"1"')
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v2' }
        })

        // A PUT carrying the stale validator MUST NOT write and MUST 412.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: resourceUrl,
            method: 'PUT',
            action: 'PUT',
            json: { name: 'v3' },
            headers: { 'if-match': staleEtag }
          })
        } catch (err) {
          expectedError = err
        }
        assertPreconditionFailed(expectedError)

        // The stored content is unchanged: still the version-2 write.
        const check = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(check.status, 200)
        assert.equal(check.data.name, 'v2')
        assert.equal(check.headers.get('etag'), '"2"')
      }
    },
    {
      id: 'conditional.if-none-match-existing-412',
      name:
        '[root] a PUT with `If-None-Match: *` against an existing Resource ' +
        'returns 412 and does not overwrite',
      specRefs: [
        'https://wallet.storage/spec#conditional-requests',
        'https://wallet.storage/spec#precondition-failed'
      ],
      run: async (ctx, state) => {
        const { alice, collectionUrl, conditionalWritesSupported } = state
        if (!conditionalWritesSupported) {
          ctx.skip('backend does not advertise conditional-writes')
        }
        const resourceUrl = `${collectionUrl}if-none-match-existing`

        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'original' }
        })

        // create-if-absent against an existing Resource MUST 412.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: resourceUrl,
            method: 'PUT',
            action: 'PUT',
            json: { name: 'overwrite' },
            headers: { 'if-none-match': '*' }
          })
        } catch (err) {
          expectedError = err
        }
        assertPreconditionFailed(expectedError)

        // The original content survives.
        const check = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(check.status, 200)
        assert.equal(check.data.name, 'original')
      }
    },
    {
      id: 'conditional.current-if-match-succeeds',
      name:
        '[root] a PUT with the current `If-Match` succeeds and advances the ' +
        'ETag',
      specRefs: ['https://wallet.storage/spec#conditional-requests'],
      run: async (ctx, state) => {
        const { alice, collectionUrl, conditionalWritesSupported } = state
        if (!conditionalWritesSupported) {
          ctx.skip('backend does not advertise conditional-writes')
        }
        const resourceUrl = `${collectionUrl}current-if-match`

        const created = await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v1' }
        })
        const currentEtag = created.headers.get('etag')
        assert.equal(currentEtag, '"1"')

        // The matching precondition is satisfied: the write proceeds and the
        // strong validator advances.
        const updated = await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v2' },
          headers: { 'if-match': currentEtag }
        })
        assert.equal(updated.status, 204)
        assert.equal(updated.headers.get('etag'), '"2"')

        const check = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(check.data.name, 'v2')
      }
    },
    {
      id: 'conditional.if-none-match-create-succeeds',
      name:
        '[root] a PUT with `If-None-Match: *` on a fresh id creates the ' +
        'Resource',
      specRefs: ['https://wallet.storage/spec#conditional-requests'],
      run: async (ctx, state) => {
        const { alice, collectionUrl, conditionalWritesSupported } = state
        if (!conditionalWritesSupported) {
          ctx.skip('backend does not advertise conditional-writes')
        }
        const resourceUrl = `${collectionUrl}if-none-match-create`

        // create-if-absent on an absent id proceeds.
        const created = await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'fresh' },
          headers: { 'if-none-match': '*' }
        })
        assert.equal(created.status, 204)
        assert.equal(created.headers.get('etag'), '"1"')

        const check = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(check.status, 200)
        assert.equal(check.data.name, 'fresh')
      }
    },
    {
      id: 'conditional.authz-before-precondition-404',
      name:
        '[root] an under-authorized conditional PUT yields the 404 mask, ' +
        'never 412',
      specRefs: [
        'https://wallet.storage/spec#conditional-requests',
        'https://wallet.storage/spec#error-handling',
        'https://wallet.storage/spec#not-found'
      ],
      run: async (ctx, state) => {
        const { alice, bob, collectionUrl, conditionalWritesSupported } = state
        if (!conditionalWritesSupported) {
          ctx.skip('backend does not advertise conditional-writes')
        }
        const resourceUrl = `${collectionUrl}authz-before-precondition`

        // Alice owns an existing Resource.
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'alice-owned' }
        })

        // Bob -- who has no privilege over Alice's Space -- sends a conditional
        // PUT with a stale validator. Authorization MUST run before the
        // precondition, so Bob gets the 404 mask, never the existence-revealing
        // 412.
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: resourceUrl,
            method: 'PUT',
            action: 'PUT',
            json: { name: 'bob-overwrite' },
            headers: { 'if-match': '"1"' }
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)

        // The write was not performed: Alice still sees her content.
        const check = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(check.status, 200)
        assert.equal(check.data.name, 'alice-owned')
      }
    },
    {
      id: 'conditional.get-carries-etag',
      name:
        '[root] GET of a Resource carries an ETag that changes after the ' +
        'content changes',
      optional: true,
      specRefs: [
        'https://wallet.storage/spec#caching',
        'https://wallet.storage/spec#conditional-requests'
      ],
      run: async (ctx, state) => {
        const { alice, collectionUrl } = state
        const resourceUrl = `${collectionUrl}get-etag`

        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v1' }
        })
        const first = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        const firstEtag = first.headers.get('etag')
        assert.ok(firstEtag, 'expected GET to carry an ETag')

        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v2' }
        })
        const second = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        const secondEtag = second.headers.get('etag')
        assert.ok(secondEtag, 'expected GET to carry an ETag')

        // A strong validator changes whenever the stored content changes.
        assert.notEqual(secondEtag, firstEtag)
      }
    },
    {
      id: 'conditional.head-carries-etag',
      name:
        '[root] HEAD of a Resource carries an ETag that changes after the ' +
        'content changes',
      optional: true,
      specRefs: [
        'https://wallet.storage/spec#caching',
        'https://wallet.storage/spec#conditional-requests'
      ],
      run: async (ctx, state) => {
        const { alice, collectionUrl } = state
        const resourceUrl = `${collectionUrl}head-etag`

        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v1' }
        })
        const first = await headResource({
          url: resourceUrl,
          invocationSigner: alice.rootClient.invocationSigner
        })
        assert.equal(first.status, 200)
        const firstEtag = first.headers.get('etag')
        assert.ok(firstEtag, 'expected HEAD to carry an ETag')

        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v2' }
        })
        const second = await headResource({
          url: resourceUrl,
          invocationSigner: alice.rootClient.invocationSigner
        })
        assert.equal(second.status, 200)
        const secondEtag = second.headers.get('etag')
        assert.ok(secondEtag, 'expected HEAD to carry an ETag')

        assert.notEqual(secondEtag, firstEtag)
      }
    }
  ]
}
