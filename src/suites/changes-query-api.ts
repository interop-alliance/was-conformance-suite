/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Collection `changes` query profile (the replication
 * change feed served at `POST /space/:s/:c/query`; spec "Collection-level
 * reserved endpoints").
 *
 * The profile is OPTIONAL and advertised server-wide: a server that serves it
 * carries the `changes-query` token in the `features` array of its service
 * description's WAS version entry. It varies by whether the server keeps an
 * ordered change log at all rather than by backend, which is why the token sits
 * there and not on a Backend description. `setup()` reads the document and the
 * tests exercising the profile skip when the token is absent; the two that
 * exercise the query endpoint's profile dispatch (an unknown profile, an
 * omitted one) hold for any server serving the endpoint and run unconditionally.
 *
 * The checkpoint is an opaque string the server issues, scoped to the server
 * and Collection. These tests compare it by equality only and never read inside
 * it. Tests that write to the feed do so in a Collection of their own, so the
 * shared `feed` Collection keeps exactly the three documents `setup()` wrote.
 */
import assert from '../harness/assert.js'
import { serviceFeatures } from '../harness/serviceDescription.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  collectionId: string
  changesSupported: boolean
  queryUrl: () => string
  /**
   * Creates a fresh Collection in Alice's Space and returns its id.
   */
  createCollection: () => Promise<string>
  /**
   * Writes the JSON `body` to a Resource by id.
   */
  putResource: (options: {
    collectionId: string
    resourceId: string
    body: unknown
  }) => Promise<void>
  /**
   * Posts one `changes` query to a Collection and returns the response body.
   */
  pullPage: (options: {
    collectionId: string
    checkpoint?: unknown
    limit?: number
  }) => Promise<{ documents: any[]; checkpoint: string | null }>
}

const PROBLEM_INVALID_REQUEST_BODY = 'https://w3id.org/pws#invalid-request-body'

/**
 * Asserts that a feed page carries an opaque string checkpoint on each
 * document, and that the page's checkpoint equals the last document's (or is
 * `null` on an empty page).
 *
 * @param page {object}
 * @param page.documents {any[]}
 * @param page.checkpoint {string | null}
 */
function assertPageCheckpoints(page: {
  documents: any[]
  checkpoint: string | null
}): void {
  for (const doc of page.documents) {
    assert.equal(
      typeof doc.checkpoint,
      'string',
      `document "${doc.id}" carries no string checkpoint`
    )
  }
  if (page.documents.length === 0) {
    assert.equal(page.checkpoint, null)
    return
  }
  assert.equal(typeof page.checkpoint, 'string')
  assert.equal(
    page.checkpoint,
    page.documents[page.documents.length - 1].checkpoint
  )
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

    const features = await serviceFeatures({ serverUrl: ctx.serverUrl })
    const changesSupported = features.includes('changes-query')

    /**
     * Creates a fresh Collection in Alice's Space.
     *
     * @returns {Promise<string>} the new Collection's id
     */
    async function createCollection(): Promise<string> {
      const id = ctx.generateId()
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
        method: 'POST',
        action: 'POST',
        json: { id, name: 'Feed ordering' }
      })
      return id
    }

    /**
     * Writes a JSON body to a Resource by id.
     *
     * @param options {object}
     * @param options.collectionId {string}
     * @param options.resourceId {string}
     * @param options.body {unknown}
     */
    async function putResource({
      collectionId: targetCollectionId,
      resourceId,
      body
    }: {
      collectionId: string
      resourceId: string
      body: unknown
    }): Promise<void> {
      await alice.rootClient.request({
        url: new URL(
          `/space/${alice.space1.id}/${targetCollectionId}/${resourceId}`,
          ctx.serverUrl
        ).toString(),
        method: 'PUT',
        action: 'PUT',
        json: body
      })
    }

    /**
     * Posts one `changes` query to a Collection.
     *
     * @param options {object}
     * @param options.collectionId {string}
     * @param [options.checkpoint] {unknown}   sent verbatim when present
     * @param [options.limit] {number}
     * @returns {Promise<object>} the response body
     */
    async function pullPage({
      collectionId: targetCollectionId,
      checkpoint,
      limit = 100
    }: {
      collectionId: string
      checkpoint?: unknown
      limit?: number
    }): Promise<{ documents: any[]; checkpoint: string | null }> {
      const response = await alice.rootClient.request({
        url: new URL(
          `/space/${alice.space1.id}/${targetCollectionId}/query`,
          ctx.serverUrl
        ).toString(),
        method: 'POST',
        action: 'POST',
        json: {
          profile: 'changes',
          ...(checkpoint !== undefined && { checkpoint }),
          limit
        }
      })
      assert.equal(response.status, 200)
      return response.data
    }

    return {
      alice,
      collectionId,
      changesSupported,
      queryUrl,
      createCollection,
      putResource,
      pullPage
    }
  },

  teardown: async (ctx, state) => {
    const { alice } = state
    try {
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
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
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const { alice, queryUrl, changesSupported } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
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

        // The checkpoint is an opaque string equal to the last returned
        // document's own checkpoint, and every document carries one.
        assert.ok(response.data.checkpoint)
        assertPageCheckpoints(response.data)
      }
    },
    {
      id: 'changes.unknown-profile-501',
      name: '[root] rejects an unknown query profile with 501',
      specRefs: ['https://w3id.org/pws#query-profile-registry'],
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
        'https://w3id.org/pws#query-profile-registry',
        'https://w3id.org/pws#invalid-request-body'
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
          'https://w3id.org/pws#invalid-request-body'
        )
      }
    },
    {
      id: 'changes.malformed-checkpoint-400',
      name:
        '[root] a `changes` query with a malformed `checkpoint` is rejected ' +
        'with 400',
      specRefs: [
        'https://w3id.org/pws#query-profile-changes',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice, queryUrl, changesSupported } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        // A checkpoint the server did not issue is rejected with
        // `invalid-request-body` (400).
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: queryUrl(),
            method: 'POST',
            action: 'POST',
            json: {
              profile: 'changes',
              checkpoint: 'not-issued-by-this-server'
            }
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
          'https://w3id.org/pws#invalid-request-body'
        )
      }
    },
    {
      id: 'changes.concurrent-writes-not-skipped',
      name:
        '[root] two concurrent writes to one Collection both surface when ' +
        'the feed is paged between them',
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const { changesSupported, createCollection, putResource, pullPage } =
          state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        // Two writes fired together are likely to share an `updatedAt`. The
        // feed is ordered by the server's feed position, so neither may be
        // skipped by a checkpoint taken between them.
        const targetCollectionId = await createCollection()
        await Promise.all(
          ['a', 'b'].map(resourceId =>
            putResource({
              collectionId: targetCollectionId,
              resourceId,
              body: { resourceId }
            })
          )
        )

        const first = await pullPage({
          collectionId: targetCollectionId,
          limit: 1
        })
        assert.equal(first.documents.length, 1)
        assertPageCheckpoints(first)
        const second = await pullPage({
          collectionId: targetCollectionId,
          checkpoint: first.checkpoint,
          limit: 1
        })
        assert.equal(second.documents.length, 1)
        assertPageCheckpoints(second)
        assert.notEqual(second.checkpoint, first.checkpoint)
        assert.deepEqual(
          [first.documents[0].id, second.documents[0].id].sort(),
          ['a', 'b']
        )
        const end = await pullPage({
          collectionId: targetCollectionId,
          checkpoint: second.checkpoint,
          limit: 1
        })
        assert.deepEqual(end.documents, [])
        assert.equal(end.checkpoint, null)

        // A document's own checkpoint resumes right after that document.
        const whole = await pullPage({ collectionId: targetCollectionId })
        assert.equal(whole.documents.length, 2)
        assertPageCheckpoints(whole)
        const rest = await pullPage({
          collectionId: targetCollectionId,
          checkpoint: whole.documents[0].checkpoint
        })
        assert.deepEqual(
          rest.documents.map((doc: any) => doc.id),
          [whole.documents[1].id]
        )
      }
    },
    {
      id: 'changes.rewrite-after-checkpoint-surfaces',
      name:
        '[root] a write made after a checkpoint was issued surfaces when ' +
        'that checkpoint is echoed back',
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const { changesSupported, createCollection, putResource, pullPage } =
          state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        const targetCollectionId = await createCollection()
        await putResource({
          collectionId: targetCollectionId,
          resourceId: 'x',
          body: { revision: 1 }
        })

        // Drain the feed to its end, keeping the last checkpoint issued.
        let checkpoint: string | undefined
        for (let page = 0; page < 50; page++) {
          const result = await pullPage({
            collectionId: targetCollectionId,
            ...(checkpoint !== undefined && { checkpoint })
          })
          if (result.checkpoint === null) {
            break
          }
          checkpoint = result.checkpoint
        }
        assert.ok(checkpoint, 'expected the feed to issue a checkpoint')

        // Rewrite `x` right away, then resume from the checkpoint.
        await putResource({
          collectionId: targetCollectionId,
          resourceId: 'x',
          body: { revision: 2 }
        })
        const resumed = await pullPage({
          collectionId: targetCollectionId,
          checkpoint
        })
        assertPageCheckpoints(resumed)
        const rewritten = resumed.documents.find((doc: any) => doc.id === 'x')
        assert.ok(
          rewritten,
          'expected the rewrite to surface past the checkpoint'
        )
        assert.deepEqual(rewritten.data, { revision: 2 })
      }
    },
    {
      id: 'changes.retired-object-checkpoint-400',
      name:
        '[root] a `changes` query with an `{ id, updatedAt }` object ' +
        'checkpoint is rejected with 400',
      specRefs: [
        'https://w3id.org/pws#query-profile-changes',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice, queryUrl, changesSupported } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        // The checkpoint is an opaque string; the retired object shape is a
        // checkpoint the server did not issue.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: queryUrl(),
            method: 'POST',
            action: 'POST',
            json: {
              profile: 'changes',
              checkpoint: { id: 'r1', updatedAt: '2026-01-01T00:00:00.000Z' }
            }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the object checkpoint to be rejected'
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(expectedError.data.type, PROBLEM_INVALID_REQUEST_BODY)
      }
    },
    {
      id: 'changes.foreign-collection-checkpoint-400',
      name:
        '[root] a checkpoint issued for another Collection is rejected ' +
        'with 400',
      specRefs: [
        'https://w3id.org/pws#query-profile-changes',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const {
          alice,
          queryUrl,
          changesSupported,
          createCollection,
          putResource,
          pullPage
        } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        // A checkpoint is scoped to the Collection that issued it.
        const otherCollectionId = await createCollection()
        await putResource({
          collectionId: otherCollectionId,
          resourceId: 'elsewhere',
          body: { elsewhere: true }
        })
        const other = await pullPage({ collectionId: otherCollectionId })
        assert.equal(typeof other.checkpoint, 'string')

        let expectedError: any
        try {
          await alice.rootClient.request({
            url: queryUrl(),
            method: 'POST',
            action: 'POST',
            json: { profile: 'changes', checkpoint: other.checkpoint }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          "expected another Collection's checkpoint to be rejected"
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(expectedError.data.type, PROBLEM_INVALID_REQUEST_BODY)
      }
    }
  ]
}
