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
 * Most tests work at the Resource level in a plain JSON Collection; the
 * "Descriptions" group covers the same preconditions on the Collection and
 * Space Descriptions (the guarded create two provisioning clients race on).
 * All drive raw `ZcapClient.request()` calls so the `If-Match` /
 * `If-None-Match` precondition headers can be attached directly. Those preconditions describe the request
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
 * Signs and sends a bodyless root read invocation (GET or HEAD) via raw
 * `fetch`, optionally carrying an `If-None-Match` validator, and returns the
 * response so its status and headers (the `ETag`) can be read. The low-level
 * primitive is used because the high-level client parses a 200 body as JSON
 * (a bodyless HEAD has none) and rejects a 304 as an error.
 *
 * @param options {object}
 * @param options.url {string}   the URL to read
 * @param options.method {'GET' | 'HEAD'}
 * @param options.invocationSigner {ISigner}   the caller's signer
 * @param [options.ifNoneMatch] {string}   an `If-None-Match` header value
 * @returns {Promise<Response>}
 */
async function readResource({
  url,
  method,
  invocationSigner,
  ifNoneMatch
}: {
  url: string
  method: 'GET' | 'HEAD'
  invocationSigner: ISigner
  ifNoneMatch?: string
}): Promise<Response> {
  const signatureHeaders = await signCapabilityInvocation({
    url,
    method,
    headers: { date: new Date().toUTCString() },
    invocationSigner,
    capabilityAction: method
  })
  return fetch(url, {
    method,
    headers: {
      ...(signatureHeaders as Record<string, string>),
      ...(ifNoneMatch !== undefined && { 'if-none-match': ifNoneMatch })
    }
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
        assert.match(staleEtag, /^"[^"]+"$/, 'expected a quoted ETag validator')
        const secondWrite = await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v2' }
        })
        const currentEtag = secondWrite.headers.get('etag')

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
        assert.equal(check.headers.get('etag'), currentEtag)
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
        assert.match(
          currentEtag,
          /^"[^"]+"$/,
          'expected a quoted ETag validator'
        )

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
        assert.notEqual(updated.headers.get('etag'), currentEtag)

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
        assert.match(
          created.headers.get('etag'),
          /^"[^"]+"$/,
          'expected a quoted ETag validator'
        )

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
        const first = await readResource({
          url: resourceUrl,
          method: 'HEAD',
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
        const second = await readResource({
          url: resourceUrl,
          method: 'HEAD',
          invocationSigner: alice.rootClient.invocationSigner
        })
        assert.equal(second.status, 200)
        const secondEtag = second.headers.get('etag')
        assert.ok(secondEtag, 'expected HEAD to carry an ETag')

        assert.notEqual(secondEtag, firstEtag)
      }
    },
    {
      id: 'conditional.get-if-none-match-304',
      name:
        '[root] GET with an If-None-Match matching the current ETag is 304 ' +
        'Not Modified with the ETag and no body; a stale validator is 200',
      optional: true,
      specRefs: ['https://wallet.storage/spec#caching'],
      run: async (ctx, state) => {
        const { alice, collectionUrl } = state
        const resourceUrl = `${collectionUrl}get-304`
        const invocationSigner = alice.rootClient.invocationSigner

        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v1' }
        })
        const first = await readResource({
          url: resourceUrl,
          method: 'GET',
          invocationSigner
        })
        assert.equal(first.status, 200)
        const etag = first.headers.get('etag')
        assert.ok(etag, 'expected GET to carry an ETag')

        const unchanged = await readResource({
          url: resourceUrl,
          method: 'GET',
          invocationSigner,
          ifNoneMatch: etag
        })
        assert.equal(unchanged.status, 304)
        assert.equal(unchanged.headers.get('etag'), etag)
        assert.equal(await unchanged.text(), '')

        // The content changes, so the held validator goes stale and the full
        // representation is served with the new ETag.
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v2' }
        })
        const stale = await readResource({
          url: resourceUrl,
          method: 'GET',
          invocationSigner,
          ifNoneMatch: etag
        })
        assert.equal(stale.status, 200)
        assert.notEqual(stale.headers.get('etag'), etag)
        const body = await stale.json()
        assert.equal(body.name, 'v2')
      }
    },
    {
      id: 'conditional.head-if-none-match-304',
      name: '[root] HEAD with an If-None-Match matching the current ETag is 304',
      optional: true,
      specRefs: ['https://wallet.storage/spec#caching'],
      run: async (ctx, state) => {
        const { alice, collectionUrl } = state
        const resourceUrl = `${collectionUrl}head-304`
        const invocationSigner = alice.rootClient.invocationSigner

        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v1' }
        })
        const first = await readResource({
          url: resourceUrl,
          method: 'HEAD',
          invocationSigner
        })
        const etag = first.headers.get('etag')
        assert.ok(etag, 'expected HEAD to carry an ETag')

        const unchanged = await readResource({
          url: resourceUrl,
          method: 'HEAD',
          invocationSigner,
          ifNoneMatch: etag
        })
        assert.equal(unchanged.status, 304)
        assert.equal(unchanged.headers.get('etag'), etag)
      }
    },
    {
      id: 'conditional.get-if-none-match-weak-list-any',
      name:
        '[root] If-None-Match uses weak comparison: a W/ validator, a list ' +
        'containing the ETag, and `*` are all 304',
      optional: true,
      specRefs: ['https://wallet.storage/spec#caching'],
      run: async (ctx, state) => {
        const { alice, collectionUrl } = state
        const resourceUrl = `${collectionUrl}get-304-forms`
        const invocationSigner = alice.rootClient.invocationSigner

        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'v1' }
        })
        const first = await readResource({
          url: resourceUrl,
          method: 'GET',
          invocationSigner
        })
        const etag = first.headers.get('etag')
        assert.ok(etag, 'expected GET to carry an ETag')

        for (const ifNoneMatch of [`W/${etag}`, `"stale", ${etag}`, '*']) {
          const response = await readResource({
            url: resourceUrl,
            method: 'GET',
            invocationSigner,
            ifNoneMatch
          })
          assert.equal(
            response.status,
            304,
            `expected 304 for If-None-Match: ${ifNoneMatch}`
          )
        }
      }
    },
    {
      id: 'conditional.under-authorized-conditional-get-masked',
      name:
        "[root] another controller's conditional GET is the 404 mask, never " +
        'a 304 that would confirm the Resource exists',
      optional: true,
      specRefs: [
        'https://wallet.storage/spec#caching',
        'https://wallet.storage/spec#error-responses'
      ],
      run: async (ctx, state) => {
        const { alice, bob, collectionUrl } = state
        const resourceUrl = `${collectionUrl}get-304-masked`

        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'alice-owned' }
        })
        const first = await readResource({
          url: resourceUrl,
          method: 'GET',
          invocationSigner: alice.rootClient.invocationSigner
        })
        const etag = first.headers.get('etag')
        assert.ok(etag, 'expected GET to carry an ETag')

        const masked = await readResource({
          url: resourceUrl,
          method: 'GET',
          invocationSigner: bob.rootClient.invocationSigner,
          ifNoneMatch: etag
        })
        assert.equal(masked.status, 404)
      }
    },
    {
      id: 'conditional.collection-if-none-match-create-then-412',
      name:
        '[root] a Collection PUT with `If-None-Match: *` creates an absent ' +
        'Collection and 412s on a present one',
      group: 'Descriptions',
      specRefs: [
        'https://wallet.storage/spec#conditional-requests',
        'https://wallet.storage/spec#update-or-create-by-id-collection-operation',
        'https://wallet.storage/spec#precondition-failed'
      ],
      run: async (ctx, state) => {
        const { alice, conditionalWritesSupported } = state
        if (!conditionalWritesSupported) {
          ctx.skip('backend does not advertise conditional-writes')
        }
        const collectionUrl = new URL(
          `/space/${alice.space1.id}/guarded-collection`,
          ctx.serverUrl
        ).toString()

        // The guarded create proceeds on an absent Collection.
        const created = await alice.rootClient.request({
          url: collectionUrl,
          method: 'PUT',
          action: 'PUT',
          json: { id: 'guarded-collection', name: 'Winner' },
          headers: { 'if-none-match': '*' }
        })
        assert.equal(created.status, 201)
        assert.match(
          created.headers.get('etag'),
          /^"[^"]+"$/,
          'expected a quoted ETag validator on the create'
        )

        // The loser of a create race: the same guarded PUT MUST NOT replace
        // the winner's description, and MUST 412.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: collectionUrl,
            method: 'PUT',
            action: 'PUT',
            json: { id: 'guarded-collection', name: 'Loser' },
            headers: { 'if-none-match': '*' }
          })
        } catch (err) {
          expectedError = err
        }
        assertPreconditionFailed(expectedError)

        const unchanged = await alice.rootClient.request({
          url: collectionUrl,
          method: 'GET'
        })
        assert.equal(unchanged.data.name, 'Winner')

        // An unconditional PUT still replaces.
        const replaced = await alice.rootClient.request({
          url: collectionUrl,
          method: 'PUT',
          action: 'PUT',
          json: { id: 'guarded-collection', name: 'Replaced' }
        })
        assert.ok(
          replaced.status === 204 || replaced.status === 200,
          `expected a success status, got ${replaced.status}`
        )
      }
    },
    {
      id: 'conditional.space-get-carries-etag',
      name:
        '[root] Read Space carries a quoted ETag and a matching ' +
        '`If-None-Match` is answered 304',
      group: 'Descriptions',
      optional: true,
      specRefs: [
        'https://wallet.storage/spec#caching',
        'https://wallet.storage/spec#read-space-operation'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const spaceUrl = new URL(
          `/space/${alice.space1.id}`,
          ctx.serverUrl
        ).toString()
        const read = await readResource({
          url: spaceUrl,
          method: 'GET',
          invocationSigner: alice.rootClient.invocationSigner
        })
        assert.equal(read.status, 200)
        const etag = read.headers.get('etag')
        assert.match(etag, /^"[^"]+"$/, 'expected a quoted ETag validator')
        const body = await read.json()
        assert.equal(body.id, alice.space1.id)

        const unchanged = await readResource({
          url: spaceUrl,
          method: 'GET',
          invocationSigner: alice.rootClient.invocationSigner,
          ifNoneMatch: etag!
        })
        assert.equal(unchanged.status, 304)
        assert.equal(unchanged.headers.get('etag'), etag)
        assert.equal(await unchanged.text(), '')
      }
    },
    {
      id: 'conditional.space-if-none-match-create-then-412',
      name:
        '[root] a Space PUT with `If-None-Match: *` creates an absent Space ' +
        'and 412s on a present one',
      group: 'Descriptions',
      specRefs: [
        'https://wallet.storage/spec#conditional-requests',
        'https://wallet.storage/spec#update-or-create-by-id-space-operation',
        'https://wallet.storage/spec#precondition-failed'
      ],
      run: async (ctx, state) => {
        const { alice, conditionalWritesSupported } = state
        if (!conditionalWritesSupported) {
          ctx.skip('backend does not advertise conditional-writes')
        }
        const spaceId = ctx.generateId()
        const spaceUrl = new URL(`/space/${spaceId}`, ctx.serverUrl).toString()
        try {
          const created = await alice.rootClient.request({
            url: spaceUrl,
            method: 'PUT',
            action: 'PUT',
            json: { id: spaceId, name: 'Winner', controller: alice.did },
            headers: { 'if-none-match': '*' }
          })
          assert.equal(created.status, 201)
          assert.match(
            created.headers.get('etag'),
            /^"[^"]+"$/,
            'expected a quoted ETag validator on the create'
          )

          // The loser of a provisioning race MUST NOT replace the winner's
          // description, and MUST 412.
          let expectedError: any
          try {
            await alice.rootClient.request({
              url: spaceUrl,
              method: 'PUT',
              action: 'PUT',
              json: { id: spaceId, name: 'Loser', controller: alice.did },
              headers: { 'if-none-match': '*' }
            })
          } catch (err) {
            expectedError = err
          }
          assertPreconditionFailed(expectedError)

          const unchanged = await alice.rootClient.request({
            url: spaceUrl,
            method: 'GET'
          })
          assert.equal(unchanged.data.name, 'Winner')
        } finally {
          try {
            await alice.rootClient.request({
              url: spaceUrl,
              method: 'DELETE',
              action: 'DELETE'
            })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'conditional.space-if-match-cas',
      name:
        '[root] a stale `If-Match` on Update Space 412s; the current one ' +
        'succeeds and an unconditional PUT still replaces',
      group: 'Descriptions',
      specRefs: [
        'https://wallet.storage/spec#conditional-requests',
        'https://wallet.storage/spec#update-or-create-by-id-space-operation',
        'https://wallet.storage/spec#precondition-failed'
      ],
      run: async (ctx, state) => {
        const { alice, conditionalWritesSupported } = state
        if (!conditionalWritesSupported) {
          ctx.skip('backend does not advertise conditional-writes')
        }
        const spaceId = ctx.generateId()
        const spaceUrl = new URL(`/space/${spaceId}`, ctx.serverUrl).toString()
        const description = (name: string) => ({
          id: spaceId,
          name,
          controller: alice.did
        })
        try {
          const created = await alice.rootClient.request({
            url: spaceUrl,
            method: 'PUT',
            action: 'PUT',
            json: description('One')
          })
          const currentEtag = created.headers.get('etag')
          assert.ok(currentEtag, 'expected an ETag on the Space create')

          // A validator that cannot be current MUST NOT write, and MUST 412.
          let expectedError: any
          try {
            await alice.rootClient.request({
              url: spaceUrl,
              method: 'PUT',
              action: 'PUT',
              json: description('Stale'),
              headers: { 'if-match': '"99999"' }
            })
          } catch (err) {
            expectedError = err
          }
          assertPreconditionFailed(expectedError)
          const unchanged = await alice.rootClient.request({
            url: spaceUrl,
            method: 'GET'
          })
          assert.equal(unchanged.data.name, 'One')

          // The matching precondition is satisfied: the write proceeds and
          // the response carries the new validator.
          const swapped = await alice.rootClient.request({
            url: spaceUrl,
            method: 'PUT',
            action: 'PUT',
            json: description('Two'),
            headers: { 'if-match': currentEtag }
          })
          assert.ok(
            swapped.status === 204 || swapped.status === 200,
            `expected a success status, got ${swapped.status}`
          )
          assert.notEqual(swapped.headers.get('etag'), currentEtag)
          const after = await alice.rootClient.request({
            url: spaceUrl,
            method: 'GET'
          })
          assert.equal(after.data.name, 'Two')

          // An unconditional PUT still replaces (last writer wins).
          const replaced = await alice.rootClient.request({
            url: spaceUrl,
            method: 'PUT',
            action: 'PUT',
            json: description('Three')
          })
          assert.ok(
            replaced.status === 204 || replaced.status === 200,
            `expected a success status, got ${replaced.status}`
          )
        } finally {
          try {
            await alice.rootClient.request({
              url: spaceUrl,
              method: 'DELETE',
              action: 'DELETE'
            })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'conditional.post-response-no-store',
      name:
        '[root] the response to a POST (non-idempotent) is marked ' +
        'non-cacheable with Cache-Control: no-store',
      optional: true,
      specRefs: ['https://wallet.storage/spec#caching'],
      run: async (ctx, state) => {
        const { alice, collectionUrl } = state
        const response = await alice.rootClient.request({
          url: collectionUrl,
          method: 'POST',
          action: 'POST',
          json: { name: 'posted' }
        })
        assert.equal(response.status, 201)
        assert.equal(response.headers.get('cache-control'), 'no-store')
      }
    }
  ]
}
