/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Collections API.
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
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
    }
  ]
}
