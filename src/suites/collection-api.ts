/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Collections API.
 */
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import type { ISigner } from '@interop/data-integrity-core'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
}

/**
 * Signs and sends a GET capability invocation against a (possibly
 * query-bearing) list URL, using a delegated capability -- the page-follow a
 * replicating consumer performs. The `next` URLs differ only in their query
 * string, which a list capability tolerates (the page selects within an
 * already-authorized target), so the same capability is reused for every page.
 *
 * @param options {object}
 * @param options.url {string}   the page URL to invoke against
 * @param options.capability {IZcap}   the delegated list capability
 * @param options.invocationSigner {ISigner}   the delegate's signer
 * @returns {Promise<Response>}
 */
async function getWithCapability({
  url,
  capability,
  invocationSigner
}: {
  url: string
  capability: IZcap
  invocationSigner: ISigner
}): Promise<Response> {
  const signatureHeaders = await signCapabilityInvocation({
    url,
    method: 'GET',
    headers: { date: new Date().toUTCString() },
    invocationSigner,
    capability,
    capabilityAction: 'GET'
  })
  return fetch(url, {
    method: 'GET',
    headers: signatureHeaders as Record<string, string>
  })
}

/**
 * Provisions a fresh Collection with a random id, returning its `/meta` URL and
 * the Collection URL it hangs off. Every Collection Metadata test works on its
 * own Collection, so the `metaVersion` sequence a test observes is its own.
 *
 * @param options {object}
 * @param options.ctx {any}   the test context (for `serverUrl` / `generateId`)
 * @param options.alice {any}   the suite's root actor
 * @returns {Promise<{collectionUrl: string, metaUrl: string}>}
 */
async function freshCollection({
  ctx,
  alice
}: {
  ctx: any
  alice: any
}): Promise<{ collectionUrl: string; metaUrl: string }> {
  const collectionId = ctx.generateId()
  const collectionUrl = new URL(
    `/space/${alice.space1.id}/${collectionId}`,
    ctx.serverUrl
  ).toString()
  await alice.rootClient.request({
    url: collectionUrl,
    method: 'PUT',
    action: 'PUT',
    json: { id: collectionId, name: 'Metadata Collection' }
  })
  return { collectionUrl, metaUrl: `${collectionUrl}/meta` }
}

/**
 * Sends a signed Collection Metadata request, translating a 501
 * `unsupported-operation` into a skip: Collection Metadata is an OPTIONAL
 * feature, so a server that does not implement it must not be failed for it.
 * Any other error is rethrown for the caller to assert on.
 *
 * @param options {object}
 * @param options.ctx {any}   the test context (for `ctx.skip`)
 * @param options.alice {any}   the suite's root actor
 * @param options.url {string}   the `/meta` URL
 * @param options.method {string}   'GET' or 'PUT'
 * @param [options.json] {object}   the request body, for a PUT
 * @param [options.headers] {object}   extra request headers (preconditions)
 * @returns {Promise<any>}
 */
async function metaRequestOrSkip({
  ctx,
  alice,
  url,
  method,
  json,
  headers
}: {
  ctx: any
  alice: any
  url: string
  method: string
  json?: object
  headers?: Record<string, string>
}): Promise<any> {
  try {
    return await alice.rootClient.request({
      url,
      method,
      action: method,
      ...(json !== undefined && { json }),
      ...(headers !== undefined && { headers })
    })
  } catch (err: any) {
    if (err.response?.status === 501) {
      ctx.skip('Collection Metadata (/meta) not implemented (501)')
    }
    throw err
  }
}

export const collectionApi: Suite<State> = {
  id: 'collection-api',
  name: 'Collections API',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    alice.space1 = { id: ctx.generateId() }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1",
        controller: alice.did
      },
      rootClient: alice.rootClient
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
      id: 'collection.create-unauthorized-401',
      name: 'POST /space/:spaceId/ should 401 error when no authorization headers',
      specRefs: [
        'https://wallet.storage/spec#create-collection-add-collection-to-a-space-operation'
      ],
      run: async ctx => {
        const { serverUrl } = ctx
        const response = await fetch(
          new URL('/space/any-space-id/', serverUrl),
          {
            method: 'POST'
          }
        )
        assert.equal(response.status, 401)
        assert.match(
          response.headers.get('content-type')!,
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'collection.create-missing-space-404',
      name: 'POST /space/:spaceId/ should 404 error on not found space id',
      specRefs: [
        'https://wallet.storage/spec#create-collection-add-collection-to-a-space-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const spaceUrl = new URL(
          '/space/space-id-that-does-not-exist/',
          serverUrl
        ).toString()
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: spaceUrl,
            method: 'POST',
            action: 'POST'
          })
        } catch (err) {
          expectedError = err
        }
        assert.equal(expectedError.response.status, 404)
        assert.match(
          expectedError.response.headers.get('content-type'),
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'collection.create-post',
      name: '[root] create collection via POST',
      specRefs: [
        'https://wallet.storage/spec#create-collection-add-collection-to-a-space-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl, withoutCreatedBy } = ctx
        const { alice } = state
        const body = { id: 'credentials', name: 'Verifiable Credentials' }
        const response = await alice.rootClient.request({
          url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
          method: 'POST',
          action: 'POST',
          json: body
        })
        assert.equal(response.status, 201)
        assert.deepStrictEqual(withoutCreatedBy(response.data), {
          id: 'credentials',
          name: 'Verifiable Credentials',
          type: ['Collection'],
          backend: { id: 'default' }
        })
        assert.match(response.headers.get('content-type'), /application\/json/)
        assert.equal(
          response.headers.get('location'),
          `${serverUrl}/space/${alice.space1.id}/${body.id}`
        )
      }
    },
    {
      id: 'collection.create-post-id-conflict-409',
      name: '[root] POST with an existing collection id yields id-conflict (409)',
      specRefs: ['https://wallet.storage/spec#id-conflict'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // 'credentials' was created by the POST test above.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
            method: 'POST',
            action: 'POST',
            json: { id: 'credentials', name: 'Replacement' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the duplicate-id POST to be rejected'
        )
        assert.equal(expectedError.response.status, 409)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#id-conflict'
        )
      }
    },
    {
      id: 'collection.list-items',
      name: '[root] list collection items via GET :collectionId/',
      specRefs: ['https://wallet.storage/spec#list-collection-operation'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/credentials/`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.equal(response.status, 200)
        const listResponse = response.data
        assert.equal(listResponse.id, 'credentials')
        assert.equal(listResponse.url, `/space/${alice.space1.id}/credentials`)
        assert.equal(listResponse.name, 'Verifiable Credentials')
        assert.deepStrictEqual(listResponse.type, ['Collection'])
        assert.equal(typeof listResponse.totalItems, 'number')
        assert.ok(Array.isArray(listResponse.items))
        assert.equal(listResponse.totalItems, listResponse.items.length)
      }
    },
    {
      id: 'collection.read-description',
      name: '[root] get collection description via GET :collectionId',
      specRefs: [
        'https://wallet.storage/spec#get-collection-description-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl, withoutCreatedBy } = ctx
        const { alice } = state
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/credentials`,
            serverUrl
          ).toString(),
          method: 'GET',
          action: 'GET'
        })
        assert.equal(response.status, 200)
        assert.deepStrictEqual(withoutCreatedBy(response.data), {
          id: 'credentials',
          name: 'Verifiable Credentials',
          type: ['Collection'],
          backend: { id: 'default' },
          url: `/space/${alice.space1.id}/credentials`,
          linkset: `/space/${alice.space1.id}/credentials/linkset`
        })
      }
    },
    {
      id: 'collection.paginate-limit-next',
      name: '[root] paginates List Collection via ?limit and follows next (spec Pagination)',
      specRefs: [
        'https://wallet.storage/spec#list-collection-operation',
        'https://wallet.storage/spec#pagination'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice } = state
        // Fresh Collection seeded with > one page of Resources, inserted out of order
        // to prove the listing order is by id, not insertion.
        const collectionId = generateId()
        // WAS does not auto-create parent Collections, so provision it first.
        await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/${collectionId}`,
            serverUrl
          ).toString(),
          method: 'PUT',
          json: { id: collectionId, name: 'Paginated Collection' }
        })
        const ids = ['g05', 'g01', 'g04', 'g02', 'g00', 'g03']
        for (const id of ids) {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/${collectionId}/${id}`,
              serverUrl
            ).toString(),
            method: 'PUT',
            json: { value: id }
          })
        }

        const seen: string[] = []
        let nextUrl: string | undefined = new URL(
          `/space/${alice.space1.id}/${collectionId}/?limit=2`,
          serverUrl
        ).toString()
        let pages = 0
        while (nextUrl) {
          const response: any = await alice.rootClient.request({
            url: nextUrl,
            method: 'GET'
          })
          assert.equal(response.status, 200)
          pages++
          assert.ok(response.data.items.length <= 2, 'page respects the limit')
          seen.push(...response.data.items.map((item: any) => item.id))
          // `next` is server-relative; follow it verbatim, resolved against serverUrl.
          nextUrl = response.data.next
            ? new URL(response.data.next, serverUrl).toString()
            : undefined
        }

        // 6 items at limit 2 -> 3 pages; the last omits `next` (end-of-list signal).
        assert.equal(pages, 3)
        assert.deepStrictEqual(seen, ['g00', 'g01', 'g02', 'g03', 'g04', 'g05'])
      }
    },
    {
      id: 'collection.malformed-cursor-400',
      name: '[root] a malformed cursor yields invalid-cursor (400)',
      specRefs: ['https://wallet.storage/spec#invalid-cursor'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/credentials/?cursor=not-valid-%%%`,
              serverUrl
            ).toString(),
            method: 'GET'
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the malformed cursor to be rejected')
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#invalid-cursor'
        )
      }
    },
    {
      id: 'collection.create-delete-by-id',
      name: '[root] create and delete a collection by id',
      specRefs: [
        'https://wallet.storage/spec#update-or-create-by-id-collection-operation',
        'https://wallet.storage/spec#delete-collection-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const collectionId = 'new-collection'
        const collectionUrl = new URL(
          `/space/${alice.space1.id}/${collectionId}`,
          serverUrl
        ).toString()
        const body = { id: collectionId, name: 'New Collection' }

        await alice.rootClient.request({
          url: collectionUrl,
          method: 'PUT',
          json: body
        })

        const existResponse = await alice.rootClient.request({
          url: collectionUrl,
          method: 'GET'
        })
        assert.equal(existResponse.status, 200)

        const deleteResponse = await alice.rootClient.request({
          url: collectionUrl,
          method: 'DELETE'
        })
        assert.equal(deleteResponse.status, 204)

        let checkResponse: any
        try {
          await alice.rootClient.request({ url: collectionUrl, method: 'GET' })
        } catch (err: any) {
          checkResponse = err.response
        }
        assert.equal(checkResponse.status, 404)
      }
    },
    {
      id: 'collection.create-unknown-backend-409',
      name:
        '[root] creating a Collection naming an unregistered backend id is ' +
        'rejected with 409 unsupported-backend',
      specRefs: [
        'https://wallet.storage/spec#collection-backend-selected',
        'https://wallet.storage/spec#unsupported-backend'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice } = state
        // A Collection's `backend.id` must name a backend in the Space's
        // available list; an unknown id is rejected rather than silently
        // defaulting.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
            method: 'POST',
            action: 'POST',
            json: {
              id: generateId(),
              name: 'Bad Backend Collection',
              backend: { id: 'no-such-backend' }
            }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the unknown-backend create to be rejected'
        )
        assert.equal(expectedError.response.status, 409)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#unsupported-backend'
        )
      }
    },
    {
      id: 'collection.paginate-delegated-no-redelegation',
      name:
        '[delegated] a single list capability reads every page; no per-page ' +
        're-delegation is required',
      specRefs: [
        'https://wallet.storage/spec#pagination',
        'https://wallet.storage/spec#root-capability'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice } = state
        const aliceDelegatedApp = ctx.actors.aliceDelegatedApp
        // Seed a fresh Collection with more than one page of Resources.
        const collectionId = generateId()
        await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/${collectionId}`,
            serverUrl
          ).toString(),
          method: 'PUT',
          json: { id: collectionId, name: 'Delegated Paginated Collection' }
        })
        const ids = ['p04', 'p00', 'p03', 'p01', 'p05', 'p02']
        for (const id of ids) {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/${collectionId}/${id}`,
              serverUrl
            ).toString(),
            method: 'PUT',
            json: { value: id }
          })
        }

        // Alice delegates a read (GET) capability on the list target -- the
        // Collection container URL -- to her delegated app.
        const listTarget = new URL(
          `/space/${alice.space1.id}/${collectionId}/`,
          serverUrl
        ).toString()
        const zcap = await alice.was.grant({
          to: aliceDelegatedApp.did,
          actions: ['GET'],
          target: listTarget
        })

        // The delegate follows `next` across all pages using that SAME
        // capability for every page; only `limit`/`cursor` in the query differ.
        const seen: string[] = []
        let nextUrl: string | undefined = new URL(
          `/space/${alice.space1.id}/${collectionId}/?limit=2`,
          serverUrl
        ).toString()
        let pages = 0
        while (nextUrl) {
          const response = await getWithCapability({
            url: nextUrl,
            capability: zcap,
            invocationSigner: aliceDelegatedApp.signer
          })
          assert.equal(
            response.status,
            200,
            `expected page ${pages + 1} to be authorized by the delegated ` +
              `capability, got ${response.status}`
          )
          const page: any = await response.json()
          pages++
          assert.ok(page.items.length <= 2, 'page respects the limit')
          seen.push(...page.items.map((item: any) => item.id))
          nextUrl = page.next
            ? new URL(page.next, serverUrl).toString()
            : undefined
        }

        assert.equal(pages, 3)
        assert.deepStrictEqual(seen.sort(), [
          'p00',
          'p01',
          'p02',
          'p03',
          'p04',
          'p05'
        ])
      }
    },
    {
      id: 'collection.meta-get-or-skip',
      name: '[root] GET Collection Metadata (/meta), or skip if unimplemented',
      group: 'Collection Metadata',
      specRefs: [
        'https://wallet.storage/spec#read-collection-metadata-operation',
        'https://wallet.storage/spec#collection-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        // Collection Metadata is OPTIONAL: a server that does not implement it
        // responds 501 `unsupported-operation`, which this test treats as a skip.
        const { metaUrl } = await freshCollection({ ctx, alice })
        const response = await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)
        // `metaVersion` is an out-of-band validator (the ETag), never a member
        // of the Metadata body.
        assert.equal(response.data.metaVersion, undefined)

        // An anonymous (unsigned) meta read must not leak existence: the
        // Collection carries no public-read policy, so 404 problem+json.
        const anonResponse = await fetch(new URL(metaUrl))
        assert.equal(anonResponse.status, 404)
        assert.match(
          anonResponse.headers.get('content-type')!,
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'collection.meta-put-get-roundtrip',
      name: '[root] PUT Collection Metadata sets `custom`, round-tripped by GET',
      group: 'Collection Metadata',
      specRefs: [
        'https://wallet.storage/spec#update-collection-metadata-operation',
        'https://wallet.storage/spec#read-collection-metadata-operation'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const { metaUrl } = await freshCollection({ ctx, alice })
        const custom = { name: 'Trip Photos', tags: { app: 'gallery' } }
        const putResponse = await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'PUT',
          json: { custom }
        })
        assert.ok(
          putResponse.status === 204 || putResponse.status === 200,
          `expected a success status, got ${putResponse.status}`
        )
        // The write returns the new metadata validator so a client can chain a
        // conditional metadata write.
        const writtenEtag = putResponse.headers.get('etag')
        assert.ok(writtenEtag, 'expected an ETag on the metadata write')

        const getResponse = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(getResponse.status, 200)
        assert.equal(getResponse.headers.get('etag'), writtenEtag)
        assert.deepStrictEqual(getResponse.data.custom, custom)
        // Server-managed timestamps are recorded once metadata has been written.
        assert.ok(
          !Number.isNaN(Date.parse(getResponse.data.createdAt)),
          '`createdAt` should be a timestamp'
        )
        assert.ok(
          !Number.isNaN(Date.parse(getResponse.data.updatedAt)),
          '`updatedAt` should be a timestamp'
        )
      }
    },
    {
      id: 'collection.meta-put-full-replacement',
      name:
        '[root] PUT Collection Metadata is a full replacement; a body with no ' +
        '`custom` clears it',
      group: 'Collection Metadata',
      specRefs: [
        'https://wallet.storage/spec#update-collection-metadata-operation'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const { metaUrl } = await freshCollection({ ctx, alice })
        const first = await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'PUT',
          json: { custom: { name: 'Temporary', tags: { a: 'b' } } }
        })
        const firstEtag = first.headers.get('etag')

        const cleared = await alice.rootClient.request({
          url: metaUrl,
          method: 'PUT',
          action: 'PUT',
          json: {}
        })
        assert.ok(
          cleared.status === 204 || cleared.status === 200,
          `expected a success status, got ${cleared.status}`
        )
        assert.notEqual(
          cleared.headers.get('etag'),
          firstEtag,
          'the metadata validator advances on every write'
        )

        const getResponse = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(getResponse.status, 200)
        // Every user-writable property is gone (an absent `custom`, or an
        // empty one).
        assert.deepStrictEqual(getResponse.data.custom ?? {}, {})
      }
    },
    {
      id: 'collection.meta-put-ignores-server-managed',
      name:
        '[root] PUT Collection Metadata ignores server-managed top-level ' +
        'members (read-modify-write is safe)',
      group: 'Collection Metadata',
      specRefs: [
        'https://wallet.storage/spec#update-collection-metadata-operation',
        'https://wallet.storage/spec#collection-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const { metaUrl } = await freshCollection({ ctx, alice })
        await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'PUT',
          json: { custom: { name: 'Before' } }
        })

        // Read the whole Metadata object, tweak `custom`, and PUT it back
        // unstripped -- with the server-managed members deliberately falsified.
        const before = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        const managedCreatedAt = before.data.createdAt
        const putResponse = await alice.rootClient.request({
          url: metaUrl,
          method: 'PUT',
          action: 'PUT',
          json: {
            ...before.data,
            createdBy: 'did:key:zSomeoneElse',
            createdAt: '1999-01-01T00:00:00.000Z',
            custom: { name: 'After' }
          }
        })
        assert.ok(
          putResponse.status === 204 || putResponse.status === 200,
          `expected a success status, got ${putResponse.status}`
        )

        const after = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(after.status, 200)
        assert.equal(after.data.createdAt, managedCreatedAt)
        assert.notEqual(after.data.createdBy, 'did:key:zSomeoneElse')
        // Only the user-writable `custom` was applied.
        assert.deepStrictEqual(after.data.custom, { name: 'After' })
      }
    },
    {
      id: 'collection.meta-put-missing-collection-404',
      name:
        '[root] PUT Collection Metadata on a nonexistent Collection 404s ' +
        '(never creates)',
      group: 'Collection Metadata',
      specRefs: [
        'https://wallet.storage/spec#update-collection-metadata-operation',
        'https://wallet.storage/spec#not-found'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // Probe first, so an unimplemented server skips rather than passing on
        // an unrelated 404.
        const { metaUrl } = await freshCollection({ ctx, alice })
        await metaRequestOrSkip({ ctx, alice, url: metaUrl, method: 'GET' })

        const missingMetaUrl = new URL(
          `/space/${alice.space1.id}/collection-that-does-not-exist/meta`,
          serverUrl
        ).toString()
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: missingMetaUrl,
            method: 'PUT',
            action: 'PUT',
            json: { custom: { name: 'nope' } }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected a metadata write on a missing Collection to be rejected'
        )
        assert.equal(expectedError.response.status, 404)
        assert.match(
          expectedError.response.headers.get('content-type'),
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'collection.meta-put-non-object-custom-400',
      name:
        '[root] PUT Collection Metadata with a non-object `custom` is ' +
        'rejected with 400 invalid-request-body',
      group: 'Collection Metadata',
      specRefs: [
        'https://wallet.storage/spec#update-collection-metadata-operation',
        'https://wallet.storage/spec#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const { metaUrl } = await freshCollection({ ctx, alice })
        let expectedError: any
        try {
          await metaRequestOrSkip({
            ctx,
            alice,
            url: metaUrl,
            method: 'PUT',
            json: { custom: 'not-an-object' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected a non-object `custom` to be rejected'
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#invalid-request-body'
        )
      }
    },
    {
      id: 'collection.meta-conditional-if-match',
      name:
        '[root] a stale `If-Match` on Collection Metadata 412s; the current ' +
        'one succeeds',
      group: 'Collection Metadata',
      specRefs: [
        'https://wallet.storage/spec#update-collection-metadata-operation',
        'https://wallet.storage/spec#conditional-requests',
        'https://wallet.storage/spec#precondition-failed'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const { metaUrl } = await freshCollection({ ctx, alice })
        const created = await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'PUT',
          json: { custom: { name: 'One' } }
        })
        const currentEtag = created.headers.get('etag')
        assert.ok(currentEtag, 'expected an ETag on the metadata write')

        // A validator that cannot be current MUST NOT write, and MUST 412.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: metaUrl,
            method: 'PUT',
            action: 'PUT',
            json: { custom: { name: 'Two' } },
            headers: { 'if-match': '"99999"' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected a stale If-Match to be rejected')
        assert.equal(expectedError.response.status, 412)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#precondition-failed'
        )

        // The rejected write left the stored metadata alone.
        const unchanged = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.deepStrictEqual(unchanged.data.custom, { name: 'One' })

        // The matching precondition is satisfied: the write proceeds.
        const updated = await alice.rootClient.request({
          url: metaUrl,
          method: 'PUT',
          action: 'PUT',
          json: { custom: { name: 'Two' } },
          headers: { 'if-match': currentEtag }
        })
        assert.ok(
          updated.status === 204 || updated.status === 200,
          `expected a success status, got ${updated.status}`
        )
        assert.notEqual(updated.headers.get('etag'), currentEtag)

        const after = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.deepStrictEqual(after.data.custom, { name: 'Two' })
      }
    },
    {
      id: 'collection.meta-etag-independent-of-description',
      name:
        '[root] the Collection Metadata ETag is independent of the Collection ' +
        'Description ETag',
      group: 'Collection Metadata',
      specRefs: [
        'https://wallet.storage/spec#collection-metadata-data-model',
        'https://wallet.storage/spec#conditional-requests'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const { collectionUrl, metaUrl } = await freshCollection({ ctx, alice })
        const described = await alice.rootClient.request({
          url: collectionUrl,
          method: 'GET'
        })
        const descriptionEtag = described.headers.get('etag')
        if (!descriptionEtag) {
          ctx.skip('server does not emit an ETag on the Collection Description')
        }

        // A metadata write does not disturb the description validator...
        await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'PUT',
          json: { custom: { name: 'Independent' } }
        })
        const afterMeta = await alice.rootClient.request({
          url: collectionUrl,
          method: 'GET'
        })
        assert.equal(afterMeta.headers.get('etag'), descriptionEtag)
        const metaEtag = (
          await alice.rootClient.request({ url: metaUrl, method: 'GET' })
        ).headers.get('etag')

        // ...and a description write does not disturb the metadata validator.
        await alice.rootClient.request({
          url: collectionUrl,
          method: 'PUT',
          action: 'PUT',
          json: {
            id: described.data.id,
            type: ['Collection'],
            name: 'Renamed'
          }
        })
        const afterDescription = await alice.rootClient.request({
          url: collectionUrl,
          method: 'GET'
        })
        assert.notEqual(afterDescription.headers.get('etag'), descriptionEtag)
        const metaAfter = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(metaAfter.headers.get('etag'), metaEtag)
        assert.deepStrictEqual(metaAfter.data.custom, { name: 'Independent' })
      }
    },
    {
      id: 'collection.meta-reserved-resource-id-409',
      name:
        '[root] `meta` is a reserved Resource id where Collection Metadata is ' +
        'implemented (409 reserved-id)',
      group: 'Collection Metadata',
      specRefs: [
        'https://wallet.storage/spec#reserved-path-segment-registry',
        'https://wallet.storage/spec#reserved-id'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        // The Collection Metadata route occupies the `{resourceId}` position, so
        // a Resource may not be named `meta`. The GET/PUT verbs at that URL are
        // the Metadata operations themselves; DELETE falls through to the
        // Resource route, where the reserved-id check rejects it.
        const { metaUrl } = await freshCollection({ ctx, alice })
        await metaRequestOrSkip({ ctx, alice, url: metaUrl, method: 'GET' })

        let expectedError: any
        try {
          await alice.rootClient.request({
            url: metaUrl,
            method: 'DELETE',
            action: 'DELETE'
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected a Resource named `meta` to be rejected'
        )
        if (expectedError.response.status === 405) {
          ctx.skip('server does not route DELETE at the Collection /meta URL')
        }
        assert.equal(expectedError.response.status, 409)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#reserved-id'
        )
      }
    }
  ]
}
