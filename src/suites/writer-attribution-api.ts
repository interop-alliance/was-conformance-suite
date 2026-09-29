/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- writer attribution (spec "Writer attribution:
 * `writerId` and `createdBy`").
 *
 * `writerId` is an opaque, client-declared attribution label on a Resource's
 * current revision. It rides the same Resource Metadata Data Model as
 * `custom` and `epoch`, so it is gated behind the same OPTIONAL `metadata`
 * feature token the server advertises in its service description. `setup()`
 * reads the document once; every test that depends on `/meta` or the Update
 * Resource Metadata operation skips when the token is absent, matching how
 * `changes-query-api` gates its own feature. The tombstone check further
 * depends on the `changes-query` feature, since the only place a delete's
 * `writerId` surfaces is that feed. The Collection listing check runs
 * unconditionally, matching `collection-api`'s own unconditional listing
 * test.
 *
 * A content write (`PUT` or `POST`) and a `DELETE` declare the label via the
 * `Writer-Id` request header; an Update Resource Metadata request (`PUT
 * .../meta`) declares it via a top-level `writerId` member. Every write is
 * declare-or-clear: an absent header or member clears the stored label
 * rather than preserving it.
 */
import assert from '../harness/assert.js'
import { serviceFeatures } from '../harness/serviceDescription.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  collectionId: string
  metadataSupported: boolean
  changesSupported: boolean
  resourceUrl: (id: string) => string
  queryUrl: () => string
}

export const writerAttributionApi: Suite<State> = {
  id: 'writer-attribution-api',
  name: 'Writer attribution (writerId)',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const collectionId = 'attribution'

    /** Absolute URL for a Resource in this Space's `attribution` collection. */
    function resourceUrl(id: string): string {
      return new URL(
        `/space/${alice.space1.id}/${collectionId}/${id}`,
        ctx.serverUrl
      ).toString()
    }

    /** Absolute URL for the `attribution` collection's changes-query endpoint. */
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
        name: "Alice's Writer Attribution Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: { id: collectionId, name: 'Writer Attribution' }
    })

    const features = await serviceFeatures({ serverUrl: ctx.serverUrl })
    const metadataSupported = features.includes('metadata')
    const changesSupported = features.includes('changes-query')

    return {
      alice,
      collectionId,
      metadataSupported,
      changesSupported,
      resourceUrl,
      queryUrl
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
      id: 'writer-attribution.content-write-declares-and-clears',
      name:
        '[root] a content write declares `writerId` (/meta, listing, ' +
        'changes feed); a following write with no header clears it',
      specRefs: [
        'https://w3id.org/pws#writer-attribution',
        'https://w3id.org/pws#resource-metadata-data-model',
        'https://w3id.org/pws#update-or-create-by-id-resource-operation',
        'https://w3id.org/pws#list-collection-operation',
        'https://w3id.org/pws#query-profile-changes'
      ],
      run: async (ctx, state) => {
        const { alice, collectionId, metadataSupported, changesSupported } =
          state
        if (!metadataSupported) {
          ctx.skip('the service description does not advertise metadata')
        }
        const resourceId = ctx.generateId()
        const url = state.resourceUrl(resourceId)

        // A PUT declaring `Writer-Id: w1` stores it.
        await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId },
          headers: { 'writer-id': 'w1' }
        })

        const meta1 = await alice.rootClient.request({
          url: `${url}/meta`,
          method: 'GET'
        })
        assert.equal(meta1.data.writerId, 'w1')

        const listing1 = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/${collectionId}/`,
            ctx.serverUrl
          ).toString(),
          method: 'GET'
        })
        const item1 = listing1.data.items.find(
          (it: any) => it.id === resourceId
        )
        assert.ok(item1, 'expected the written resource in the listing')
        assert.equal(item1.writerId, 'w1')

        if (changesSupported) {
          const changes1 = await alice.rootClient.request({
            url: state.queryUrl(),
            method: 'POST',
            action: 'POST',
            json: { profile: 'changes', limit: 1000 }
          })
          const doc1 = changes1.data.documents.find(
            (doc: any) => doc.id === resourceId
          )
          assert.ok(doc1, 'expected the written resource in the changes feed')
          assert.equal(doc1.writerId, 'w1')
        }

        // A following PUT with no `Writer-Id` header clears the stored label.
        await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId, updated: true }
        })

        const meta2 = await alice.rootClient.request({
          url: `${url}/meta`,
          method: 'GET'
        })
        assert.equal(meta2.data.writerId, undefined)

        const listing2 = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/${collectionId}/`,
            ctx.serverUrl
          ).toString(),
          method: 'GET'
        })
        const item2 = listing2.data.items.find(
          (it: any) => it.id === resourceId
        )
        assert.ok(item2, 'expected the updated resource in the listing')
        assert.equal(item2.writerId, undefined)

        if (changesSupported) {
          const changes2 = await alice.rootClient.request({
            url: state.queryUrl(),
            method: 'POST',
            action: 'POST',
            json: { profile: 'changes', limit: 1000 }
          })
          const doc2 = changes2.data.documents.find(
            (doc: any) => doc.id === resourceId
          )
          assert.ok(doc2, 'expected the cleared resource in the changes feed')
          assert.equal(doc2.writerId, undefined)
        }
      }
    },
    {
      id: 'writer-attribution.create-post-declares',
      name: '[root] POST (create) with `Writer-Id` stores it too',
      specRefs: [
        'https://w3id.org/pws#writer-attribution',
        'https://w3id.org/pws#create-resource-add-resource-to-collection-operation'
      ],
      run: async (ctx, state) => {
        const { alice, collectionId, metadataSupported } = state
        if (!metadataSupported) {
          ctx.skip('the service description does not advertise metadata')
        }
        const created = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/${collectionId}/`,
            ctx.serverUrl
          ).toString(),
          method: 'POST',
          action: 'POST',
          json: { message: 'hi' },
          headers: { 'writer-id': 'w3' }
        })
        const resourceUrl = created.headers.get('location')
        assert.ok(resourceUrl, 'expected a Location header on the create')

        const meta = await alice.rootClient.request({
          url: `${resourceUrl}/meta`,
          method: 'GET'
        })
        assert.equal(meta.data.writerId, 'w3')
      }
    },
    {
      id: 'writer-attribution.delete-tombstone-writer-id',
      name: '[root] DELETE with `Writer-Id` attributes the tombstone',
      specRefs: [
        'https://w3id.org/pws#writer-attribution',
        'https://w3id.org/pws#delete-resource-operation',
        'https://w3id.org/pws#query-profile-changes'
      ],
      run: async (ctx, state) => {
        const { alice, changesSupported } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        const resourceId = ctx.generateId()
        const url = state.resourceUrl(resourceId)
        await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId }
        })
        await alice.rootClient.request({
          url,
          method: 'DELETE',
          headers: { 'writer-id': 'w2' }
        })

        const changes = await alice.rootClient.request({
          url: state.queryUrl(),
          method: 'POST',
          action: 'POST',
          json: { profile: 'changes', limit: 1000 }
        })
        const tombstone = changes.data.documents.find(
          (doc: any) => doc.id === resourceId
        )
        assert.ok(
          tombstone,
          'expected the deleted resource in the changes feed'
        )
        assert.equal(tombstone._deleted, true)
        assert.equal(tombstone.writerId, 'w2')
      }
    },
    {
      id: 'writer-attribution.meta-put-member-declares-and-clears',
      name:
        '[root] Update Resource Metadata declares `writerId` via a ' +
        'top-level member; omitting it clears the stored label',
      specRefs: [
        'https://w3id.org/pws#writer-attribution',
        'https://w3id.org/pws#update-resource-metadata-operation'
      ],
      run: async (ctx, state) => {
        const { alice, metadataSupported } = state
        if (!metadataSupported) {
          ctx.skip('the service description does not advertise metadata')
        }
        const resourceId = ctx.generateId()
        const url = state.resourceUrl(resourceId)
        await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId }
        })

        await alice.rootClient.request({
          url: `${url}/meta`,
          method: 'PUT',
          action: 'PUT',
          json: { writerId: 'w5' }
        })
        const meta1 = await alice.rootClient.request({
          url: `${url}/meta`,
          method: 'GET'
        })
        assert.equal(meta1.data.writerId, 'w5')

        // A metadata write is itself a revision: omitting `writerId` CLEARS
        // it, unlike `epoch`, which a metadata write preserves on omission.
        await alice.rootClient.request({
          url: `${url}/meta`,
          method: 'PUT',
          action: 'PUT',
          json: { custom: {} }
        })
        const meta2 = await alice.rootClient.request({
          url: `${url}/meta`,
          method: 'GET'
        })
        assert.equal(meta2.data.writerId, undefined)
      }
    },
    {
      id: 'writer-attribution.invalid-header-empty-400',
      name: '[root] an empty `Writer-Id` header is invalid-request-body (400)',
      specRefs: ['https://w3id.org/pws#writer-attribution'],
      run: async (ctx, state) => {
        const { alice, metadataSupported } = state
        if (!metadataSupported) {
          ctx.skip('the service description does not advertise metadata')
        }
        const resourceId = ctx.generateId()
        const url = state.resourceUrl(resourceId)
        let expectedError: any
        try {
          await alice.rootClient.request({
            url,
            method: 'PUT',
            action: 'PUT',
            json: { id: resourceId },
            headers: { 'writer-id': '' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the empty header to be rejected')
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#invalid-request-body'
        )
      }
    },
    {
      id: 'writer-attribution.invalid-meta-member-empty-400',
      name:
        '[root] an empty-string top-level `writerId` member is ' +
        'invalid-request-body (400)',
      specRefs: [
        'https://w3id.org/pws#writer-attribution',
        'https://w3id.org/pws#update-resource-metadata-operation'
      ],
      run: async (ctx, state) => {
        const { alice, metadataSupported } = state
        if (!metadataSupported) {
          ctx.skip('the service description does not advertise metadata')
        }
        const resourceId = ctx.generateId()
        const url = state.resourceUrl(resourceId)
        await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId }
        })

        let expectedError: any
        try {
          await alice.rootClient.request({
            url: `${url}/meta`,
            method: 'PUT',
            action: 'PUT',
            json: { writerId: '' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the empty-string writerId member to be rejected'
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#invalid-request-body'
        )
      }
    },
    {
      id: 'writer-attribution.invalid-meta-member-type-400',
      name:
        '[root] a non-string top-level `writerId` member is ' +
        'invalid-request-body (400)',
      specRefs: [
        'https://w3id.org/pws#writer-attribution',
        'https://w3id.org/pws#update-resource-metadata-operation'
      ],
      run: async (ctx, state) => {
        const { alice, metadataSupported } = state
        if (!metadataSupported) {
          ctx.skip('the service description does not advertise metadata')
        }
        const resourceId = ctx.generateId()
        const url = state.resourceUrl(resourceId)
        await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId }
        })

        let expectedError: any
        try {
          await alice.rootClient.request({
            url: `${url}/meta`,
            method: 'PUT',
            action: 'PUT',
            json: { writerId: 123 }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the non-string writerId member to be rejected'
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#invalid-request-body'
        )
      }
    }
  ]
}
