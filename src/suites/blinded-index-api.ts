/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- the `blinded-index` query profile (matching over
 * client-computed blinded / HMAC'd attributes, served at
 * `POST /space/:s/:c/query`; spec "Query Profile Registry", the
 * `blinded-index-query` backend feature).
 *
 * The profile is an OPTIONAL spec feature: a server opts in by advertising the
 * `blinded-index-query` feature on a backend it hosts. This suite is therefore
 * NOT suite-level optional -- once a server advertises the feature, the
 * profile's MUSTs are required-tier. `setup()` detects the feature via the
 * Space's `GET .../backends` descriptor list; when it is absent, every test
 * calls `ctx.skip(...)`.
 *
 * The stored documents are EDV encrypted-document envelopes whose `indexed`
 * attributes stand in for the client's HMAC-blinded base64url tokens -- the
 * server matches them opaquely, so no real crypto is exercised here. Signed
 * queries and writes use the raw `ZcapClient.request()` escape hatch, like the
 * sibling `changes` profile suite.
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

/** The (opaque) HMAC key id every seeded envelope indexes under. */
const HMAC_ID = 'did:key:zHmacBlindedIndexKeyA'

interface State {
  alice: any
  bob: any
  advertised: boolean
  queryUrl: (collectionId: string) => string
  resourceUrl: (collectionId: string, resourceId: string) => string
}

/**
 * Builds a stored EDV encrypted-document envelope carrying one blinded
 * `indexed` entry (structurally what `@interop/edv-client` produces). Each
 * attribute's `name` / `value` is an opaque blinded token; `unique` marks a
 * uniqueness claim.
 *
 * @param options {object}
 * @param options.id {string}   the document (Resource) id
 * @param options.attributes {Array<{ name: string, value: string, unique?: boolean }>}
 * @returns {object}   the envelope document
 */
function envelope({
  id,
  attributes
}: {
  id: string
  attributes: Array<{ name: string; value: string; unique?: boolean }>
}): Record<string, unknown> {
  return {
    id,
    sequence: 0,
    indexed: [
      {
        hmac: { id: HMAC_ID, type: 'Sha256HmacKey2019' },
        sequence: 0,
        attributes
      }
    ],
    jwe: {
      protected: 'eyJlbmMiOiJYQzIwUCJ9',
      iv: 'aXY',
      ciphertext: 'Y2lwaGVydGV4dA',
      tag: 'dGFn'
    }
  }
}

export const blindedIndexApi: Suite<State> = {
  id: 'blinded-index-api',
  name: 'Blinded-index query profile',
  specRefs: [
    'https://wallet.storage/spec#query-profile-blinded-index',
    'https://wallet.storage/spec#query-profile-registry'
  ],

  setup: async ctx => {
    // Shallow-clone the shared actors so per-suite scratch fields do not leak.
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    alice.space1 = { id: ctx.generateId() }

    /** Absolute URL for a Collection's reserved `/query` endpoint. */
    function queryUrl(collectionId: string): string {
      return new URL(
        `/space/${alice.space1.id}/${collectionId}/query`,
        ctx.serverUrl
      ).toString()
    }

    /** Absolute URL for a Resource within a Collection. */
    function resourceUrl(collectionId: string, resourceId: string): string {
      return new URL(
        `/space/${alice.space1.id}/${collectionId}/${resourceId}`,
        ctx.serverUrl
      ).toString()
    }

    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Blinded-Index Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })

    // Detect the OPTIONAL feature from the Space's backend descriptor list. The
    // list is a bare array of descriptors, each carrying a `features` array.
    const backendsResponse = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/backends`,
        ctx.serverUrl
      ).toString(),
      method: 'GET'
    })
    const advertised = Array.isArray(backendsResponse.data)
      ? backendsResponse.data.some((backend: any) =>
          (backend?.features ?? []).includes('blinded-index-query')
        )
      : false

    // Seed fixtures only when the feature is supported; otherwise every test
    // skips and nothing needs to be provisioned.
    if (advertised) {
      // Creates a Collection and PUTs each envelope at its id.
      async function seedCollection(
        collectionId: string,
        documents: Array<Record<string, unknown>>
      ): Promise<void> {
        await alice.rootClient.request({
          url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
          method: 'POST',
          action: 'POST',
          json: { id: collectionId, name: collectionId }
        })
        for (const document of documents) {
          await alice.rootClient.request({
            url: resourceUrl(collectionId, document.id as string),
            method: 'PUT',
            action: 'PUT',
            json: document
          })
        }
      }

      // The main fixture: `alpha` and `beta` share the `n1:v1` term; only
      // `alpha` also carries `n2:v2`; `gamma` differs on value.
      await seedCollection('vault', [
        envelope({
          id: 'alpha',
          attributes: [
            { name: 'n1', value: 'v1' },
            { name: 'n2', value: 'v2' }
          ]
        }),
        envelope({ id: 'beta', attributes: [{ name: 'n1', value: 'v1' }] }),
        envelope({ id: 'gamma', attributes: [{ name: 'n1', value: 'vX' }] })
      ])

      // A uniqueness-claim fixture: `holder` claims the `un1:uv1` triple.
      await seedCollection('vault-unique', [
        envelope({
          id: 'holder',
          attributes: [{ name: 'un1', value: 'uv1', unique: true }]
        })
      ])
    }

    return { alice, bob, advertised, queryUrl, resourceUrl }
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
      id: 'blinded.equals-match-ascending',
      name: '[root] equals matches documents by blinded term, ascending by id',
      specRefs: ['https://wallet.storage/spec#query-profile-blinded-index'],
      run: async (ctx, state) => {
        const { alice, advertised, queryUrl } = state
        if (!advertised) {
          ctx.skip('backend does not advertise blinded-index-query')
        }
        const response = await alice.rootClient.request({
          url: queryUrl('vault'),
          method: 'POST',
          action: 'POST',
          json: {
            profile: 'blinded-index',
            index: HMAC_ID,
            equals: [{ n1: 'v1' }]
          }
        })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)
        // `alpha` and `beta` carry `n1:v1`; `gamma` does not. Order is the
        // spec-mandated ascending Resource id.
        assert.deepEqual(
          response.data.documents.map((doc: any) => doc.id),
          ['alpha', 'beta']
        )
        assert.equal(response.data.hasMore, false)
        // `cursor` is present if and only if `hasMore` is true.
        assert.equal(response.data.cursor, undefined)
        // The stored envelope round-trips verbatim.
        assert.deepEqual(
          response.data.documents[1],
          envelope({ id: 'beta', attributes: [{ name: 'n1', value: 'v1' }] })
        )
      }
    },
    {
      id: 'blinded.has-match',
      name: '[root] has matches documents carrying every named blinded attribute',
      specRefs: ['https://wallet.storage/spec#query-profile-blinded-index'],
      run: async (ctx, state) => {
        const { alice, advertised, queryUrl } = state
        if (!advertised) {
          ctx.skip('backend does not advertise blinded-index-query')
        }
        // Only `alpha` carries both `n1` and `n2`.
        const response = await alice.rootClient.request({
          url: queryUrl('vault'),
          method: 'POST',
          action: 'POST',
          json: {
            profile: 'blinded-index',
            index: HMAC_ID,
            has: ['n1', 'n2']
          }
        })
        assert.equal(response.status, 200)
        assert.deepEqual(
          response.data.documents.map((doc: any) => doc.id),
          ['alpha']
        )
      }
    },
    {
      id: 'blinded.count-shape',
      name: '[root] count:true returns exactly a { count } shape',
      specRefs: ['https://wallet.storage/spec#query-profile-blinded-index'],
      run: async (ctx, state) => {
        const { alice, advertised, queryUrl } = state
        if (!advertised) {
          ctx.skip('backend does not advertise blinded-index-query')
        }
        // `n1:v1` (alpha, beta) OR `n1:vX` (gamma) matches all three.
        const response = await alice.rootClient.request({
          url: queryUrl('vault'),
          method: 'POST',
          action: 'POST',
          json: {
            profile: 'blinded-index',
            index: HMAC_ID,
            equals: [{ n1: 'v1' }, { n1: 'vX' }],
            count: true
          }
        })
        assert.equal(response.status, 200)
        assert.deepEqual(response.data, { count: 3 })
      }
    },
    {
      id: 'blinded.pagination-cursor',
      name: '[root] a limited page pairs hasMore with an opaque continuation cursor',
      optional: true,
      specRefs: [
        'https://wallet.storage/spec#query-profile-blinded-index',
        'https://wallet.storage/spec#pagination'
      ],
      run: async (ctx, state) => {
        const { alice, advertised, queryUrl } = state
        if (!advertised) {
          ctx.skip('backend does not advertise blinded-index-query')
        }
        const firstPage = await alice.rootClient.request({
          url: queryUrl('vault'),
          method: 'POST',
          action: 'POST',
          json: {
            profile: 'blinded-index',
            index: HMAC_ID,
            equals: [{ n1: 'v1' }],
            limit: 1
          }
        })
        assert.equal(firstPage.status, 200)
        // `cursor` is present if and only if `hasMore` is true, whether or not
        // the server honored the small `limit` (clamping down is permitted).
        if (firstPage.data.hasMore === true) {
          assert.ok(
            firstPage.data.cursor,
            'a non-final page must carry a continuation cursor'
          )
          assert.deepEqual(
            firstPage.data.documents.map((doc: any) => doc.id),
            ['alpha']
          )
          const secondPage = await alice.rootClient.request({
            url: queryUrl('vault'),
            method: 'POST',
            action: 'POST',
            json: {
              profile: 'blinded-index',
              index: HMAC_ID,
              equals: [{ n1: 'v1' }],
              limit: 1,
              cursor: firstPage.data.cursor
            }
          })
          assert.deepEqual(
            secondPage.data.documents.map((doc: any) => doc.id),
            ['beta']
          )
          assert.equal(secondPage.data.hasMore, false)
          assert.equal(secondPage.data.cursor, undefined)
        } else {
          // Lenient `limit`: the whole result was returned in one page.
          assert.equal(firstPage.data.cursor, undefined)
          assert.deepEqual(
            firstPage.data.documents.map((doc: any) => doc.id),
            ['alpha', 'beta']
          )
        }
      }
    },
    {
      id: 'blinded.invalid-query-body-400',
      name: '[root] a body with neither, or both, of equals/has is invalid-request-body (400)',
      specRefs: [
        'https://wallet.storage/spec#query-profile-blinded-index',
        'https://wallet.storage/spec#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice, advertised, queryUrl } = state
        if (!advertised) {
          ctx.skip('backend does not advertise blinded-index-query')
        }

        // Neither `equals` nor `has`.
        let neitherError: any
        try {
          await alice.rootClient.request({
            url: queryUrl('vault'),
            method: 'POST',
            action: 'POST',
            json: { profile: 'blinded-index', index: HMAC_ID }
          })
        } catch (err) {
          neitherError = err
        }
        assert.ok(neitherError, 'expected a body with neither clause to fail')
        assert.equal(neitherError.response.status, 400)
        assert.match(
          neitherError.response.headers.get('content-type'),
          /application\/problem\+json/
        )
        assert.equal(
          neitherError.data.type,
          'https://wallet.storage/spec#invalid-request-body'
        )

        // Both `equals` and `has`.
        let bothError: any
        try {
          await alice.rootClient.request({
            url: queryUrl('vault'),
            method: 'POST',
            action: 'POST',
            json: {
              profile: 'blinded-index',
              index: HMAC_ID,
              equals: [{ n1: 'v1' }],
              has: ['n1']
            }
          })
        } catch (err) {
          bothError = err
        }
        assert.ok(bothError, 'expected a body with both clauses to fail')
        assert.equal(bothError.response.status, 400)
        assert.equal(
          bothError.data.type,
          'https://wallet.storage/spec#invalid-request-body'
        )

        // Missing the REQUIRED `index`.
        let missingIndexError: any
        try {
          await alice.rootClient.request({
            url: queryUrl('vault'),
            method: 'POST',
            action: 'POST',
            json: { profile: 'blinded-index', has: ['n1'] }
          })
        } catch (err) {
          missingIndexError = err
        }
        assert.ok(missingIndexError, 'expected a body missing index to fail')
        assert.equal(missingIndexError.response.status, 400)
        assert.equal(
          missingIndexError.data.type,
          'https://wallet.storage/spec#invalid-request-body'
        )
      }
    },
    {
      id: 'blinded.invalid-cursor-400',
      name: '[root] a malformed continuation cursor is invalid-cursor (400)',
      specRefs: [
        'https://wallet.storage/spec#query-profile-blinded-index',
        'https://wallet.storage/spec#invalid-cursor'
      ],
      run: async (ctx, state) => {
        const { alice, advertised, queryUrl } = state
        if (!advertised) {
          ctx.skip('backend does not advertise blinded-index-query')
        }
        let cursorError: any
        try {
          await alice.rootClient.request({
            url: queryUrl('vault'),
            method: 'POST',
            action: 'POST',
            json: {
              profile: 'blinded-index',
              index: HMAC_ID,
              has: ['n1'],
              cursor: 'not!!a-valid-cursor'
            }
          })
        } catch (err) {
          cursorError = err
        }
        assert.ok(cursorError, 'expected a malformed cursor to be rejected')
        assert.equal(cursorError.response.status, 400)
        assert.equal(
          cursorError.data.type,
          'https://wallet.storage/spec#invalid-cursor'
        )
      }
    },
    {
      id: 'blinded.unique-conflict-409',
      name: '[root] a write claiming a held unique blinded triple is id-conflict (409)',
      specRefs: [
        'https://wallet.storage/spec#unique-blinded-attributes',
        'https://wallet.storage/spec#id-conflict'
      ],
      run: async (ctx, state) => {
        const { alice, advertised, resourceUrl } = state
        if (!advertised) {
          ctx.skip('backend does not advertise blinded-index-query')
        }
        // `holder` already claims `un1:uv1` with unique:true; a different
        // Resource claiming the same triple must be rejected.
        let conflictError: any
        try {
          await alice.rootClient.request({
            url: resourceUrl('vault-unique', 'claimant'),
            method: 'PUT',
            action: 'PUT',
            json: envelope({
              id: 'claimant',
              attributes: [{ name: 'un1', value: 'uv1', unique: true }]
            })
          })
        } catch (err) {
          conflictError = err
        }
        assert.ok(
          conflictError,
          'expected the conflicting claim to be rejected'
        )
        assert.equal(conflictError.response.status, 409)
        assert.equal(
          conflictError.data.type,
          'https://wallet.storage/spec#id-conflict'
        )

        // The same pair carried WITHOUT `unique` coexists freely (both-sides
        // rule): this write succeeds.
        const coexisting = await alice.rootClient.request({
          url: resourceUrl('vault-unique', 'bystander'),
          method: 'PUT',
          action: 'PUT',
          json: envelope({
            id: 'bystander',
            attributes: [{ name: 'un1', value: 'uv1' }]
          })
        })
        assert.ok([200, 201, 204].includes(coexisting.status))
      }
    },
    {
      id: 'blinded.authz-before-uniqueness-404',
      name: "[root] Bob's write of a held unique triple into Alice's collection is 404, not 409",
      specRefs: [
        'https://wallet.storage/spec#unique-blinded-attributes',
        'https://wallet.storage/spec#error-type-registry',
        'https://wallet.storage/spec#not-found'
      ],
      run: async (ctx, state) => {
        const { bob, advertised, resourceUrl } = state
        if (!advertised) {
          ctx.skip('backend does not advertise blinded-index-query')
        }
        // Authorization MUST be verified before the uniqueness check: a 409
        // here would let Bob probe Alice's Collection for held unique triples.
        let maskedError: any
        try {
          await bob.rootClient.request({
            url: resourceUrl('vault-unique', 'intruder'),
            method: 'PUT',
            action: 'PUT',
            json: envelope({
              id: 'intruder',
              attributes: [{ name: 'un1', value: 'uv1', unique: true }]
            })
          })
        } catch (err) {
          maskedError = err
        }
        assert.ok(maskedError, "expected Bob's write to be rejected")
        assert.equal(maskedError.response.status, 404)
        assert.match(
          maskedError.response.headers.get('content-type'),
          /application\/problem\+json/
        )
        assert.equal(
          maskedError.data.type,
          'https://wallet.storage/spec#not-found'
        )
      }
    }
  ]
}
