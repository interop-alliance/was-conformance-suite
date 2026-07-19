/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Spaces Repository and Space API.
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  aliceDelegatedApp: any
  bob: any
  collectionId: string
  resourceId: string
}

export const spacesApi: Suite<State> = {
  id: 'spaces-api',
  name: 'Spaces',

  setup: async ctx => {
    // Shallow-clone the shared actors so per-suite scratch fields (space ids)
    // do not leak into other suites.
    const alice: any = { ...ctx.actors.alice }
    const aliceDelegatedApp: any = { ...ctx.actors.aliceDelegatedApp }
    const bob: any = { ...ctx.actors.bob }
    alice.space1 = { id: ctx.generateId() }
    alice.space2 = { id: ctx.generateId() }
    alice.space3 = { id: ctx.generateId() }
    // Pre-create alice.space1 so tests that need an existing space are not
    // implicitly coupled to the creation test's ordering
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    return { alice, aliceDelegatedApp, bob, collectionId: '', resourceId: '' }
  },

  teardown: async (ctx, state) => {
    const { alice } = state
    for (const spaceId of [alice.space1.id, alice.space2.id, alice.space3.id]) {
      try {
        await alice.rootClient.request({
          url: new URL(`/space/${spaceId}`, ctx.serverUrl).toString(),
          method: 'DELETE'
        })
      } catch {
        /* best-effort cleanup */
      }
    }
  },

  groups: [
    {
      name: 'Collections API',
      setup: async (ctx, state) => {
        const { alice } = state
        state.collectionId = ctx.generateId()
        state.resourceId = ctx.generateId()

        await ctx.createSpace({
          spaceDescription: {
            id: alice.space3.id,
            name: "Alice's Space #3 (Collections Test)",
            controller: alice.did
          },
          rootClient: alice.rootClient
        })

        await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space3.id}/${state.collectionId}`,
            ctx.serverUrl
          ).toString(),
          method: 'PUT',
          json: { id: state.collectionId, name: 'Test Collection' }
        })

        await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space3.id}/${state.collectionId}/${state.resourceId}`,
            ctx.serverUrl
          ).toString(),
          method: 'PUT',
          json: { id: state.resourceId, name: 'Test Resource' }
        })
      }
    }
  ],

  tests: [
    {
      id: 'repository.anonymous-list-empty',
      name: 'GET /spaces/ without auth headers returns the empty listing (200)',
      group: 'Spaces Repository API',
      run: async ctx => {
        const { serverUrl } = ctx
        // List Spaces is the spec's exception to 404 masking: an anonymous
        // request is not an error -- it is simply authorized to see no spaces.
        const response = await fetch(new URL('/spaces/', serverUrl))
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type')!, /application\/json/)
        const listing = (await response.json()) as any
        assert.equal(listing.url, '/spaces/')
        assert.equal(listing.totalItems, 0)
        assert.deepStrictEqual(listing.items, [])
      }
    },
    {
      id: 'repository.list-scoped-to-controller',
      name: '[root] GET /spaces/ lists only spaces controlled by the requester',
      group: 'Spaces Repository API',
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice, bob } = state
        // A persistent external server may hold any number of spaces for Alice
        // from earlier runs, so assert containment / exclusion, not contents.
        const bobSpaceId = generateId()
        await createSpace({
          spaceDescription: {
            id: bobSpaceId,
            name: "Bob's Listing Space",
            controller: bob.did
          },
          rootClient: bob.rootClient
        })

        try {
          const response = await alice.rootClient.request({
            url: new URL('/spaces/', serverUrl).toString(),
            method: 'GET'
          })
          assert.equal(response.status, 200)
          const listing = response.data
          assert.equal(listing.url, '/spaces/')
          assert.equal(listing.totalItems, listing.items.length)
          const aliceItem = listing.items.find(
            (item: any) => item.id === alice.space1.id
          )
          assert.ok(aliceItem, "Alice's listing includes her pre-created space")
          assert.equal(aliceItem.url, `/space/${alice.space1.id}`)
          assert.ok(
            !listing.items.some((item: any) => item.id === bobSpaceId),
            "Alice's listing must not reveal Bob's space"
          )
        } finally {
          await bob.rootClient.request({
            url: new URL(`/space/${bobSpaceId}`, serverUrl).toString(),
            method: 'DELETE'
          })
        }
      }
    },
    {
      id: 'repository.create-unauthorized-401',
      name: 'POST /spaces/ should 401 error when no authorization headers',
      group: 'Spaces Repository API',
      run: async ctx => {
        const { serverUrl } = ctx
        const response = await fetch(new URL('/spaces/', serverUrl), {
          method: 'POST'
        })
        assert.equal(response.status, 401)
        assert.match(
          response.headers.get('content-type')!,
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'space.create-post',
      name: '[root] create space via POST',
      group: 'Space API',
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId, withoutCreatedBy } = ctx
        const { alice } = state
        const freshSpaceId = generateId()
        const spaceDescription = {
          id: freshSpaceId,
          name: 'Conformance Test Space',
          controller: alice.did
        }
        const response = await createSpace({
          spaceDescription,
          rootClient: alice.rootClient
        })
        assert.equal(response.status, 201)
        assert.deepStrictEqual(withoutCreatedBy(response.data), {
          id: freshSpaceId,
          name: 'Conformance Test Space',
          type: ['Space'],
          controller: alice.did
        })
        assert.match(response.headers.get('content-type')!, /application\/json/)
        assert.equal(
          response.headers.get('location'),
          `${serverUrl}/spaces/${freshSpaceId}`
        )

        // Clean up the space created by this test
        await alice.rootClient.request({
          url: new URL(`/space/${freshSpaceId}`, serverUrl).toString(),
          method: 'DELETE'
        })
      }
    },
    {
      id: 'space.create-post-id-conflict-409',
      name: '[root] POST /spaces/ with an existing id yields id-conflict (409)',
      group: 'Space API',
      specRefs: ['https://wallet.storage/spec#id-conflict'],
      run: async (ctx, state) => {
        const { createSpace } = ctx
        const { alice } = state
        // alice.space1 was pre-created in before(). The onboarding-token path of
        // createSpace() returns the status; the zcap path throws on non-2xx --
        // capture either shape.
        let status: number | undefined, problem: any
        try {
          const response = await createSpace({
            spaceDescription: {
              id: alice.space1.id,
              name: 'Duplicate Space',
              controller: alice.did
            },
            rootClient: alice.rootClient
          })
          status = response.status
          problem = response.data
        } catch (err: any) {
          status = err.response?.status
          problem = err.data
        }
        assert.equal(status, 409)
        assert.equal(problem.type, 'https://wallet.storage/spec#id-conflict')
      }
    },
    {
      id: 'space.create-put',
      name: '[root] create space by id via PUT',
      group: 'Space API',
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const spaceDescription = {
          id: alice.space2.id,
          name: "Alice's Space #2 (School)",
          controller: alice.did
        }
        const spaceUrl = new URL(
          `/space/${alice.space2.id}`,
          serverUrl
        ).toString()
        const response = await alice.rootClient.request({
          url: spaceUrl,
          method: 'PUT',
          json: spaceDescription
        })

        assert.equal(response.headers.get('location'), spaceUrl)

        const checkResponse = await alice.rootClient.request({
          url: spaceUrl,
          method: 'GET'
        })
        assert.equal(checkResponse.status, 200)
      }
    },
    {
      id: 'space.anonymous-read-404',
      name: 'GET a space with no auth headers falls through to policy and 404s (no public policy)',
      group: 'Space API',
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // Reads no longer 401 at the hook: an anonymous read is allowed to
        // attempt, and is denied as 404 (no-leak) when no policy grants it.
        const spaceUrl = new URL(
          `/space/${alice.space1.id}`,
          serverUrl
        ).toString()
        const response = await fetch(spaceUrl, { method: 'GET' })
        assert.equal(response.status, 404)
        assert.match(
          response.headers.get('content-type')!,
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'space.read-missing-404',
      name: 'GET /space/:spaceId should 404 error on not found space id',
      group: 'Space API',
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const spaceUrl = new URL(
          '/space/space-id-that-does-not-exist',
          serverUrl
        ).toString()
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: spaceUrl,
            method: 'GET',
            action: 'GET'
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
      id: 'space.read-authorized',
      name: '[root] read space via GET with proper authorization',
      group: 'Space API',
      run: async (ctx, state) => {
        const { serverUrl, withoutCreatedBy } = ctx
        const { alice } = state
        const spaceUrl = new URL(
          `/space/${alice.space1.id}`,
          serverUrl
        ).toString()
        const response = await alice.rootClient.request({
          url: spaceUrl,
          method: 'GET',
          action: 'GET'
        })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)
        assert.deepStrictEqual(withoutCreatedBy(response.data), {
          id: alice.space1.id,
          name: "Alice's Space #1 (Home)",
          type: ['Space'],
          controller: alice.did,
          url: `/space/${alice.space1.id}`,
          linkset: `/space/${alice.space1.id}/linkset`
        })
      }
    },
    {
      id: 'space.read-delegated',
      name: '[delegated] authorized app should GET /space/:spaceId',
      group: 'Space API',
      run: async (ctx, state) => {
        const { serverUrl, zcapClient, withoutCreatedBy } = ctx
        const { alice, aliceDelegatedApp } = state
        const aliceAppClient = zcapClient({ signer: aliceDelegatedApp.signer })
        const spaceUrl = new URL(
          `/space/${alice.space1.id}`,
          serverUrl
        ).toString()

        const delegatedSpaceCapability = await alice.rootClient.delegate({
          allowedActions: ['GET'],
          invocationTarget: spaceUrl,
          controller: aliceDelegatedApp.did
        })

        const appResponse = await aliceAppClient.request({
          url: spaceUrl,
          capability: delegatedSpaceCapability,
          method: 'GET',
          action: 'GET'
        })
        assert.equal(appResponse.status, 200)
        assert.match(
          appResponse.headers.get('content-type')!,
          /application\/json/
        )
        assert.deepStrictEqual(withoutCreatedBy(appResponse.data), {
          id: alice.space1.id,
          name: "Alice's Space #1 (Home)",
          type: ['Space'],
          controller: alice.did,
          url: `/space/${alice.space1.id}`,
          linkset: `/space/${alice.space1.id}/linkset`
        })
      }
    },
    {
      id: 'space.cross-user-read-404',
      name: '[root] Bob should not be able to GET Alice space',
      group: 'Space API',
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, bob } = state
        const spaceUrl = new URL(
          `/space/${alice.space1.id}`,
          serverUrl
        ).toString()
        let expectedError: any
        try {
          await bob.rootClient.request({ url: spaceUrl, action: 'GET' })
        } catch (err) {
          expectedError = err
        }
        // Bob gets a 404 instead of a 403 to avoid revealing the space's existence
        assert.equal(expectedError.response.status, 404)
        assert.match(
          expectedError.response.headers.get('content-type'),
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'space.delete',
      name: '[root] Alice should be able to DELETE her provisioned space',
      group: 'Space API',
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice } = state
        const spaceId = generateId()
        await createSpace({
          spaceDescription: {
            id: spaceId,
            name: 'Space to Delete',
            controller: alice.did
          },
          rootClient: alice.rootClient
        })

        const spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
        const deleteResponse = await alice.rootClient.request({
          url: spaceUrl,
          method: 'DELETE'
        })
        assert.equal(deleteResponse.status, 204)

        let checkResponse: any
        try {
          await alice.rootClient.request({ url: spaceUrl, method: 'GET' })
        } catch (err: any) {
          checkResponse = err.response
        }
        assert.equal(checkResponse.status, 404)
      }
    },
    {
      id: 'collections.list-for-space',
      name: '[root] GET /space/:spaceId/collections/ lists collections for a space',
      group: 'Collections API',
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, collectionId } = state
        const collectionsUrl = new URL(
          `/space/${alice.space3.id}/collections/`,
          serverUrl
        ).toString()

        const response = await alice.rootClient.request({
          url: collectionsUrl,
          method: 'GET'
        })

        assert.equal(response.status, 200)
        assert.deepStrictEqual(response.data, {
          url: `/space/${alice.space3.id}/collections/`,
          totalItems: 1,
          items: [
            {
              id: collectionId,
              name: 'Test Collection',
              url: `/space/${alice.space3.id}/${collectionId}`
            }
          ]
        })
      }
    }
  ]
}
