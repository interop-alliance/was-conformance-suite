/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Collection `changes` query profile (the replication
 * change feed served at `POST /space/:s/:c/query`; spec "Collection-level
 * reserved endpoints").
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  collectionId: string
  queryUrl: () => string
}

export const changesQueryApi: Suite<State> = {
  id: 'changes-query-api',
  name: 'Collection changes query profile',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const collectionId = 'feed'

    /** Absolute URL for this Space's `feed` collection query endpoint. */
    function queryUrl(): string {
      return new URL(
        `/space/${alice.space1.id}/${collectionId}/query`,
        ctx.serverUrl
      ).toString()
    }

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
      action: 'POST',
      json: { id: collectionId, name: 'Feed' }
    })
    // Three JSON documents by id; the middle one is then soft-deleted.
    for (const id of ['r1', 'r2', 'r3']) {
      await alice.rootClient.request({
        url: new URL(
          `/space/${alice.space1.id}/${collectionId}/${id}`,
          ctx.serverUrl
        ).toString(),
        method: 'PUT',
        action: 'PUT',
        json: { id }
      })
    }
    await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/${collectionId}/r2`,
        ctx.serverUrl
      ).toString(),
      method: 'DELETE'
    })

    return { alice, collectionId, queryUrl }
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
      id: 'changes.live-docs-tombstone-checkpoint',
      name: '[root] returns live documents and a tombstone, with a checkpoint',
      specRefs: ['https://wallet.storage/spec#query-profile-changes'],
      run: async (ctx, state) => {
        const { alice, queryUrl } = state
        const response = await alice.rootClient.request({
          url: queryUrl(),
          method: 'POST',
          action: 'POST',
          json: { profile: 'changes', limit: 100 }
        })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)

        const byId = new Map(
          response.data.documents.map((doc: any) => [doc.id, doc])
        )
        assert.deepEqual([...byId.keys()].sort(), ['r1', 'r2', 'r3'])

        // Live documents carry their body under `data` and `_deleted: false`.
        assert.equal((byId.get('r1') as any)._deleted, false)
        assert.deepEqual((byId.get('r1') as any).data, { id: 'r1' })

        // The deleted document is a tombstone: `_deleted: true`, no `data`.
        const tombstone = byId.get('r2') as any
        assert.equal(tombstone._deleted, true)
        assert.equal(tombstone.data, undefined)

        // The checkpoint is the last returned document's keyset position.
        assert.ok(response.data.checkpoint)
        assert.equal(typeof response.data.checkpoint.id, 'string')
        assert.equal(typeof response.data.checkpoint.updatedAt, 'string')
      }
    },
    {
      id: 'changes.unknown-profile-501',
      name: '[root] rejects an unknown query profile with 501',
      specRefs: ['https://wallet.storage/spec#query-profile-registry'],
      run: async (ctx, state) => {
        const { alice, queryUrl } = state
        let thrown: any
        try {
          await alice.rootClient.request({
            url: queryUrl(),
            method: 'POST',
            action: 'POST',
            json: { profile: 'no-such-profile' }
          })
        } catch (err) {
          thrown = err
        }
        assert.ok(thrown, 'expected an unknown profile to be rejected')
        assert.equal(thrown.response.status, 501)
        assert.match(
          thrown.response.headers.get('content-type'),
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'changes.missing-profile-400',
      name: '[root] rejects a query body with no `profile` with 400',
      specRefs: [
        'https://wallet.storage/spec#query-profile-registry',
        'https://wallet.storage/spec#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice, queryUrl } = state
        // The Query Profile Registry marks `profile` REQUIRED: a body that
        // omits it is malformed (`invalid-request-body`, 400), distinct from
        // naming a profile the server does not serve (501).
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: queryUrl(),
            method: 'POST',
            action: 'POST',
            json: { limit: 10 }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the missing profile to be rejected')
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#invalid-request-body'
        )
      }
    },
    {
      id: 'changes.malformed-checkpoint-400',
      name:
        '[root] a `changes` query with a malformed `checkpoint` is rejected ' +
        'with 400',
      specRefs: [
        'https://wallet.storage/spec#query-profile-changes',
        'https://wallet.storage/spec#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice, queryUrl } = state
        // When present, `checkpoint` MUST be an object with a string `id` and a
        // string `updatedAt`; a string checkpoint is malformed and rejected
        // with `invalid-request-body` (400).
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: queryUrl(),
            method: 'POST',
            action: 'POST',
            json: { profile: 'changes', checkpoint: 'not-an-object' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the malformed checkpoint to be rejected'
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#invalid-request-body'
        )
      }
    }
  ]
}
