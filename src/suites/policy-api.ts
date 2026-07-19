/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Access-control policy (public-read fallback).
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  bob: any
  collectionId: string
  resourceId: string
  resourceUrl: () => string
  policyUrl: () => string
}

export const policyApi: Suite<State> = {
  id: 'policy-api',
  name: 'Access-control policy API',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }

    const collectionId = 'public-credentials'
    const resourceId = 'public-vc'
    const resourceUrl = () =>
      new URL(
        `/space/${alice.space1.id}/${collectionId}/${resourceId}`,
        ctx.serverUrl
      ).toString()
    const policyUrl = () =>
      new URL(
        `/space/${alice.space1.id}/${collectionId}/policy`,
        ctx.serverUrl
      ).toString()

    alice.space1 = { id: ctx.generateId() }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
      method: 'POST',
      json: { id: collectionId, name: 'Public Credentials' }
    })
    await alice.rootClient.request({
      url: resourceUrl(),
      method: 'PUT',
      json: { id: resourceId, name: 'A shared Verifiable Credential' }
    })

    return { alice, bob, collectionId, resourceId, resourceUrl, policyUrl }
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
      id: 'policy.anonymous-no-policy-404',
      name: 'anonymous GET of a resource with no policy is denied (404)',
      run: async (ctx, state) => {
        const { resourceUrl } = state
        const response = await fetch(resourceUrl())
        assert.equal(response.status, 404)
      }
    },
    {
      id: 'policy.put-collection-public-201',
      name: '[controller] PUT a PublicCanRead policy on the collection (201)',
      run: async (ctx, state) => {
        const { alice, policyUrl } = state
        const response = await alice.rootClient.request({
          url: policyUrl(),
          method: 'PUT',
          json: { type: 'PublicCanRead' }
        })
        assert.equal(response.status, 201)
      }
    },
    {
      id: 'policy.anonymous-public-read-200',
      name: 'anonymous GET of a resource in a PublicCanRead collection succeeds (200)',
      run: async (ctx, state) => {
        const { resourceUrl } = state
        const response = await fetch(resourceUrl())
        assert.equal(response.status, 200)
        const body = (await response.json()) as { name: string }
        assert.equal(body.name, 'A shared Verifiable Credential')
      }
    },
    {
      id: 'policy.unauthorized-falls-back-200',
      name: 'a caller whose capability does not authorize falls back to policy (200)',
      run: async (ctx, state) => {
        const { bob, resourceUrl } = state
        // Bob is not the Space controller, so his capability does not verify; the
        // PublicCanRead policy grants the read.
        const response = await bob.rootClient.request({
          url: resourceUrl(),
          method: 'GET'
        })
        assert.equal(response.status, 200)
      }
    },
    {
      id: 'policy.anonymous-write-rejected-401',
      name: 'anonymous write is still rejected (401) on a public collection',
      run: async (ctx, state) => {
        const { resourceUrl } = state
        const response = await fetch(resourceUrl(), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'anon write' })
        })
        assert.equal(response.status, 401)
      }
    },
    {
      id: 'policy.linkset-advertises-policy',
      name: 'the collection linkset advertises the policy resource',
      specRefs: ['https://wallet.storage/spec#policy'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, collectionId } = state
        const response = await fetch(
          new URL(
            `/space/${alice.space1.id}/${collectionId}/linkset`,
            serverUrl
          )
        )
        assert.equal(response.status, 200)
        assert.match(
          response.headers.get('content-type')!,
          /application\/linkset\+json/
        )
        const body = (await response.json()) as {
          linkset: Array<Record<string, any>>
        }
        assert.equal(
          body.linkset[0]!['https://wallet.storage/spec#policy'][0].href,
          `/space/${alice.space1.id}/${collectionId}/policy`
        )
      }
    },
    {
      id: 'policy.delete-revokes-404',
      name: '[controller] DELETE the policy revokes public access (404)',
      run: async (ctx, state) => {
        const { alice, policyUrl, resourceUrl } = state
        const del = await alice.rootClient.request({
          url: policyUrl(),
          method: 'DELETE'
        })
        assert.equal(del.status, 204)

        const response = await fetch(resourceUrl())
        assert.equal(response.status, 404)
      }
    },
    {
      id: 'policy.resource-level-grant',
      name: 'a resource-level policy grants public read on a single resource',
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, resourceUrl } = state
        // The collection policy was just removed, so this isolates resource-level.
        await alice.rootClient.request({
          url: new URL(`${resourceUrl()}/policy`, serverUrl).toString(),
          method: 'PUT',
          json: { type: 'PublicCanRead' }
        })
        const response = await fetch(resourceUrl())
        assert.equal(response.status, 200)

        // Clean up so it does not mask the space-level inheritance check below.
        await alice.rootClient.request({
          url: new URL(`${resourceUrl()}/policy`, serverUrl).toString(),
          method: 'DELETE'
        })
        assert.equal((await fetch(resourceUrl())).status, 404)
      }
    },
    {
      id: 'policy.space-level-inherited',
      name: 'a space-level policy is inherited by resources',
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, collectionId } = state
        // A second resource with no policy of its own.
        const inheritedUrl = new URL(
          `/space/${alice.space1.id}/${collectionId}/inherited-vc`,
          serverUrl
        ).toString()
        await alice.rootClient.request({
          url: inheritedUrl,
          method: 'PUT',
          json: { id: 'inherited-vc', name: 'Inherited' }
        })
        assert.equal((await fetch(inheritedUrl)).status, 404)

        // A space-level PublicCanRead policy makes it readable by inheritance.
        await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/policy`,
            serverUrl
          ).toString(),
          method: 'PUT',
          json: { type: 'PublicCanRead' }
        })
        assert.equal((await fetch(inheritedUrl)).status, 200)
      }
    }
  ]
}
