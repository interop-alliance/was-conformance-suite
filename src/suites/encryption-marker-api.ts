/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Collection client-side encryption marker.
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

import { Collection } from '@interop/was-client'

/**
 * A minimal conforming EDV Encrypted Document: the stored representation for an
 * `edv` Collection (a JSON object whose `jwe` member is a JWE-JSON envelope),
 * reused for both a content write and a `/meta` `custom` envelope.
 */
const edvDocument = {
  id: 'z1',
  sequence: 0,
  indexed: [],
  jwe: { protected: 'eyJhbGciOiJkaXI', ciphertext: 'c1phertext' }
}

interface State {
  alice: any
  bob: any
  createCollection: (json: object) => Promise<any>
}

export const encryptionMarkerApi: Suite<State> = {
  id: 'encryption-marker-api',
  name: 'Encryption marker API',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    alice.space1 = { id: ctx.generateId() }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Encryption Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })

    /** POSTs a Collection (raw, so an `encryption` marker can be sent). */
    function createCollection(json: object): Promise<any> {
      return alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
        method: 'POST',
        action: 'POST',
        json
      })
    }

    return { alice, bob, createCollection }
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
      id: 'encryption.persist-echo-marker',
      name: '[root] persists and echoes the marker on create',
      specRefs: [
        'https://wallet.storage/spec#the-encryption-marker',
        'https://wallet.storage/spec#collection-data-model'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, createCollection } = state
        const response = await createCollection({
          id: 'vault',
          name: 'Vault',
          encryption: { scheme: 'edv' }
        })
        assert.equal(response.status, 201)
        assert.deepStrictEqual(response.data.encryption, { scheme: 'edv' })

        const read = await alice.rootClient.request({
          url: new URL(`/space/${alice.space1.id}/vault`, serverUrl).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.encryption, { scheme: 'edv' })
      }
    },
    {
      id: 'encryption.delegated-discovers-marker',
      name: 'a delegated consumer discovers the marker by reading the Description',
      specRefs: ['https://wallet.storage/spec#the-encryption-marker'],
      run: async (ctx, state) => {
        const { alice, bob } = state
        // Alice grants Bob read on the vault; Bob -- who did not create it --
        // rebuilds a handle and reads the Description, seeing the marker (this is how
        // a consuming app learns to decrypt with its own keys).
        const zcap = await alice.was
          .space(alice.space1.id)
          .collection('vault')
          .grant({ to: bob.did, actions: ['GET'] })

        const handle = bob.was.fromCapability(zcap)
        assert.ok(handle instanceof Collection)
        const description = (await handle.describe()) as any
        assert.deepStrictEqual(description.encryption, { scheme: 'edv' })
      }
    },
    {
      id: 'encryption.malformed-marker-400',
      name: '[root] rejects a malformed marker (400 invalid-request-body)',
      specRefs: ['https://wallet.storage/spec#invalid-request-body'],
      run: async (ctx, state) => {
        const { createCollection } = state
        let expectedError: any
        try {
          await createCollection({ id: 'bad', encryption: { foo: 1 } })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the malformed-marker create to be rejected'
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#invalid-request-body'
        )
      }
    },
    {
      id: 'encryption.unrecognized-scheme-400',
      name: '[root] rejects an unrecognized scheme on first declaration (400 unsupported-encryption-scheme)',
      specRefs: ['https://wallet.storage/spec#unsupported-encryption-scheme'],
      run: async (ctx, state) => {
        const { createCollection } = state
        // The fail-closed scheme gate (spec "Encryption Scheme Registry"): a
        // first declaration naming a scheme the server does not recognize is
        // rejected rather than stored opaquely. A fresh Collection keeps this
        // unambiguous -- on an already-marked one the set-once
        // `encryption-immutable` check may fire instead (see the
        // marker-immutability tests below).
        let expectedError: any
        try {
          await createCollection({
            id: 'bad-scheme',
            encryption: { scheme: 'other' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the unrecognized scheme to be rejected'
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#unsupported-encryption-scheme'
        )
      }
    },
    {
      id: 'encryption.change-scheme-immutable',
      name: '[root] rejects changing the scheme of an existing marker and preserves it',
      specRefs: [
        'https://wallet.storage/spec#encryption-immutable',
        'https://wallet.storage/spec#collection-data-model'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // The marker is set-once: changing an existing marker's scheme MUST be
        // rejected with `encryption-immutable` (409). A generic suite cannot
        // name a second scheme the server recognizes, so a server whose
        // fail-closed registry gate runs first may instead report the probe
        // scheme as 400 `unsupported-encryption-scheme` -- both rejections are
        // accepted; either way the stored marker must survive intact.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/vault`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { id: 'vault', encryption: { scheme: 'other' } }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the scheme change to be rejected')
        const { status } = expectedError.response
        assert.ok(
          status === 409 || status === 400,
          `expected 409 or 400 for the scheme change, got ${status}`
        )
        assert.equal(
          expectedError.data.type,
          status === 409
            ? 'https://wallet.storage/spec#encryption-immutable'
            : 'https://wallet.storage/spec#unsupported-encryption-scheme'
        )

        // The stored marker must be unchanged.
        const read = await alice.rootClient.request({
          url: new URL(`/space/${alice.space1.id}/vault`, serverUrl).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.encryption, { scheme: 'edv' })
      }
    },
    {
      id: 'encryption.clear-marker-immutable',
      name: '[root] an update cannot clear an existing marker',
      specRefs: [
        'https://wallet.storage/spec#encryption-immutable',
        'https://wallet.storage/spec#collection-data-model'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // Clearing is forbidden on the same set-once terms as changing. An
        // update sent without `encryption` is either rejected with
        // `encryption-immutable` (409, a server that reads the omission as a
        // clear attempt) or accepted with the stored marker preserved (a
        // server whose updates leave omitted fields untouched). What MUST NOT
        // happen is the marker silently disappearing.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/vault`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { id: 'vault', name: 'Vault' }
          })
        } catch (err) {
          expectedError = err
        }
        if (expectedError) {
          assert.equal(expectedError.response.status, 409)
          assert.equal(
            expectedError.data.type,
            'https://wallet.storage/spec#encryption-immutable'
          )
        }

        // Either way, the stored marker must survive.
        const read = await alice.rootClient.request({
          url: new URL(`/space/${alice.space1.id}/vault`, serverUrl).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.encryption, { scheme: 'edv' })
      }
    },
    {
      id: 'encryption.non-envelope-write-422',
      name: '[root] rejects a non-envelope write into an encrypted Collection (422 scheme-mismatch)',
      specRefs: ['https://wallet.storage/spec#encryption-scheme-mismatch'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // The fail-closed guarantee (spec "Encryption Scheme Registry"): the `vault`
        // Collection is `edv`, so a plaintext JSON write is structurally rejected --
        // server-visible plaintext can never land in an encrypted Collection, even
        // from a writer that forgets (or refuses) to encrypt.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/vault/plaintext-doc`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { hello: 'world' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the plaintext write to be rejected')
        assert.equal(expectedError.response.status, 422)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#encryption-scheme-mismatch'
        )
      }
    },
    {
      id: 'encryption.wrong-content-type-write-422',
      name:
        '[root] rejects a valid envelope written under the wrong Content-Type ' +
        '(422 scheme-mismatch)',
      specRefs: ['https://wallet.storage/spec#encryption-scheme-mismatch'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // The `edv` scheme's registered media type is `application/json`. A
        // write whose body IS a structurally valid envelope but whose
        // Content-Type is something else (here `text/plain`) fails the
        // media-type gate and MUST be rejected with `encryption-scheme-mismatch`
        // -- so no representation can slip past the fail-closed guarantee by
        // mislabelling its content type.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/vault/mislabelled-doc`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            body: new TextEncoder().encode(JSON.stringify(edvDocument)),
            headers: { 'content-type': 'text/plain' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the wrong-Content-Type envelope write to be rejected'
        )
        assert.equal(expectedError.response.status, 422)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#encryption-scheme-mismatch'
        )
      }
    },
    {
      id: 'encryption.accepts-edv-document',
      name: '[root] accepts a conforming EDV Document into an encrypted Collection',
      specRefs: ['https://wallet.storage/spec#encryption-scheme-registry'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // The stored representation is an EDV Encrypted Document (`{ jwe, ... }`)
        // under `application/json` -- what the EDV codec actually produces.
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/vault/envelope-doc`,
            serverUrl
          ).toString(),
          method: 'PUT',
          action: 'PUT',
          body: new TextEncoder().encode(JSON.stringify(edvDocument)),
          headers: { 'content-type': 'application/json' }
        })
        assert.equal(response.status, 204)
      }
    },
    {
      id: 'encryption.plaintext-meta-422',
      name: '[root] rejects a plaintext `custom` on PUT /meta of an encrypted Collection (422)',
      specRefs: ['https://wallet.storage/spec#encryption-scheme-mismatch'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // Spec "Encrypted Collections": on an encrypted Collection a resource's
        // user-writable `custom` metadata MUST be a conforming envelope, so a
        // plaintext `{ name }` is fail-closed rejected -- server-visible plaintext
        // name/tags can never land in an encrypted Collection.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/vault/envelope-doc/meta`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { custom: { name: 'leaked' } }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the plaintext /meta write to be rejected'
        )
        assert.equal(expectedError.response.status, 422)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#encryption-scheme-mismatch'
        )
      }
    },
    {
      id: 'encryption.envelope-meta-etag',
      name: '[root] accepts an envelope `custom` on PUT /meta and returns its metaVersion ETag',
      optional: true,
      specRefs: [
        'https://wallet.storage/spec#update-resource-metadata-operation',
        'https://wallet.storage/spec#resource-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/vault/envelope-doc/meta`,
            serverUrl
          ).toString(),
          method: 'PUT',
          action: 'PUT',
          json: { custom: edvDocument }
        })
        assert.equal(response.status, 204)
        // The `/meta` sub-resource carries its own ETag (`metaVersion`).
        assert.ok(response.headers.get('etag'), 'expected a /meta ETag')

        // GET /meta returns the opaque envelope verbatim (no plaintext name leaked).
        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/vault/envelope-doc/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.custom, edvDocument)
      }
    },
    {
      id: 'encryption.replicates-metadata-changes',
      name: '[root] replicates the encrypted metadata edit in the changes feed',
      optional: true,
      specRefs: ['https://wallet.storage/spec#query-profile-changes'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // Decision 6: a metadata-only edit rides the change feed -- the resource
        // re-surfaces carrying the opaque `custom` envelope and a `metaVersion`, so a
        // replicating client picks up the metadata change without decryption.
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/vault/query`,
            serverUrl
          ).toString(),
          method: 'POST',
          action: 'POST',
          json: { profile: 'changes', limit: 100 }
        })
        assert.equal(response.status, 200)
        const doc = response.data.documents.find(
          (entry: any) => entry.id === 'envelope-doc'
        )
        assert.ok(doc, 'expected the edited resource in the feed')
        assert.deepStrictEqual(doc.custom, edvDocument)
        assert.equal(typeof doc.metaVersion, 'number')
      }
    }
  ]
}
