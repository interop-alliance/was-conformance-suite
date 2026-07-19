/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- high-level WasClient: Spaces & Collections.
 *
 * Drives the published `@interop/was-client` against a live server over the
 * HTTP contract, rather than the low-level `ZcapClient` used by the `*-api`
 * suites. This is where the client's own integration coverage lives, so the
 * client repo can stay free of any dependency on this server.
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

import { NotFoundError } from '@interop/was-client'
import type { Space } from '@interop/was-client'

interface State {
  alice: any
  createdSpaces: Space[]
  newSpace: (name: string) => Promise<Space>
  space: Space
}

export const clientSpaces: Suite<State> = {
  id: 'client-spaces',
  name: 'WasClient — Spaces & Collections',

  setup: async ctx => {
    // Shallow-clone the shared actor so per-suite scratch fields do not leak
    // into other suites.
    const alice: any = { ...ctx.actors.alice }
    const createdSpaces: Space[] = []

    // Creates a space via the high-level client and registers it for teardown.
    const newSpace = async (name: string): Promise<Space> => {
      const space = await ctx.provisionSpace({ was: alice.was, name })
      createdSpaces.push(space)
      return space
    }

    return { alice, createdSpaces, newSpace, space: undefined as any }
  },

  teardown: async (ctx, state) => {
    for (const space of state.createdSpaces) {
      try {
        await space.delete()
      } catch {
        /* best-effort cleanup */
      }
    }
  },

  groups: [
    {
      name: 'collections',
      setup: async (ctx, state) => {
        state.space = await state.newSpace('Collections Space')
      }
    },
    {
      name: 'backend & quota',
      setup: async (ctx, state) => {
        state.space = await state.newSpace('Backend & Quota Space')
      }
    },
    {
      name: 'space backends & quotas',
      setup: async (ctx, state) => {
        state.space = await state.newSpace('Backends & Quotas Space')
        const collection = await state.space.createCollection({ id: 'docs' })
        await collection.add({ hello: 'world' })
      }
    }
  ],

  tests: [
    {
      id: 'spaces.create-and-read',
      name: 'creates a space and reads it back',
      group: 'spaces',
      run: async (ctx, state) => {
        const { withoutCreatedBy } = ctx
        const { alice, newSpace } = state
        const space = await newSpace('Home')
        const description = await space.describe()
        assert.deepStrictEqual(withoutCreatedBy(description), {
          id: space.id,
          type: ['Space'],
          name: 'Home',
          controller: alice.did,
          url: `/space/${space.id}`,
          linkset: `/space/${space.id}/linkset`
        })
      }
    },
    {
      id: 'spaces.describe-missing-null',
      name: 'returns null when describing a missing space (404 conflation)',
      group: 'spaces',
      run: async (ctx, state) => {
        const { alice } = state
        const missing = await alice.was.space('no-such-space').describe()
        assert.equal(missing, null)
      }
    },
    {
      id: 'spaces.delete-idempotent',
      name: 'deletes a space and is idempotent',
      group: 'spaces',
      run: async (ctx, state) => {
        const { newSpace } = state
        const space = await newSpace('Disposable')
        await space.delete()
        assert.equal(await space.describe(), null)
        // Deleting again must not throw.
        await space.delete()
      }
    },
    {
      id: 'spaces.configure-update',
      name: 'configures (updates) an existing space',
      group: 'spaces',
      run: async (ctx, state) => {
        const { newSpace } = state
        const space = await newSpace('Original')
        const updated = await space.configure({ name: 'Renamed' })
        assert.equal(updated.name, 'Renamed')
        const reread = await space.describe()
        assert.equal(reread?.name, 'Renamed')
      }
    },
    {
      id: 'spaces.list-includes-created',
      name: 'listSpaces includes a created space',
      group: 'spaces',
      run: async (ctx, state) => {
        const { alice, newSpace } = state
        // A persistent external server may hold other spaces for Alice from
        // earlier runs, so assert containment rather than exact contents.
        const space = await newSpace('Listed Space')
        const listing = await alice.was.listSpaces()
        assert.equal(listing.url, '/spaces/')
        assert.equal(listing.totalItems, listing.items.length)
        assert.deepStrictEqual(
          listing.items.find((item: { id: string }) => item.id === space.id),
          { id: space.id, name: 'Listed Space', url: `/space/${space.id}` }
        )
      }
    },
    {
      id: 'collections.create-and-describe',
      name: 'creates a collection by id and reads its description',
      group: 'collections',
      run: async (ctx, state) => {
        const { withoutCreatedBy } = ctx
        const { space } = state
        const collection = await space.createCollection({
          id: 'credentials',
          name: 'Verifiable Credentials'
        })
        assert.equal(collection.id, 'credentials')
        assert.deepStrictEqual(withoutCreatedBy(await collection.describe()), {
          id: 'credentials',
          type: ['Collection'],
          name: 'Verifiable Credentials',
          backend: { id: 'default' },
          url: `/space/${space.id}/credentials`,
          linkset: `/space/${space.id}/credentials/linkset`
        })
      }
    },
    {
      id: 'collections.list-in-space',
      name: 'lists collections in a space',
      group: 'collections',
      run: async (ctx, state) => {
        const { space } = state
        const listing = await space.collections()
        assert.ok(listing)
        assert.ok(listing.totalItems >= 1)
        assert.ok(listing.items.some(item => item.id === 'credentials'))
      }
    },
    {
      id: 'collections.add-missing-space-not-found',
      name: 'throws NotFoundError adding to a collection in a missing space',
      group: 'collections',
      run: async (ctx, state) => {
        const { alice } = state
        const orphan = alice.was.space('missing-space').collection('c')
        await assert.rejects(
          orphan.add({ hello: 'world' }),
          (err: unknown) => err instanceof NotFoundError
        )
      }
    },
    {
      id: 'backend-quota.read-collection-backend',
      name: 'reads the backend a collection is stored on',
      group: 'backend & quota',
      optional: true,
      run: async (ctx, state) => {
        const { space } = state
        const collection = await space.createCollection({ id: 'backend-probe' })
        const backend = await collection.backend()
        assert.ok(backend)
        // The display name is server-specific (e.g. 'Server Filesystem' or
        // 'Server PostgreSQL'); the suite runs against any conforming server.
        const { name, ...rest } = backend
        assert.ok(typeof name === 'string' && name.length > 0)
        assert.deepStrictEqual(rest, {
          id: 'default',
          managedBy: 'server',
          storageMode: ['document', 'blob'],
          persistence: 'durable',
          features: [
            'conditional-writes',
            'changes-query',
            'blinded-index-query',
            'key-epochs',
            'chunked-streams'
          ]
        })
      }
    },
    {
      id: 'backend-quota.missing-collection-backend-null',
      name: 'returns null reading the backend of a missing collection (404 conflation)',
      group: 'backend & quota',
      optional: true,
      run: async (ctx, state) => {
        const { space } = state
        const missing = space.collection('no-such-collection')
        assert.equal(await missing.backend(), null)
      }
    },
    {
      id: 'backend-quota.read-collection-quota',
      name: "reads a collection's storage quota, scoped to its backend",
      group: 'backend & quota',
      optional: true,
      run: async (ctx, state) => {
        const { space } = state
        const collection = await space.createCollection({ id: 'quota-probe' })
        await collection.add({ hello: 'world' })
        const usage = await collection.quota()
        assert.ok(usage)
        assert.equal(usage.id, 'default')
        assert.equal(usage.managedBy, 'server')
        assert.equal(usage.state, 'ok')
        assert.ok(usage.usageBytes > 0, 'expected non-zero collection usage')
        // The default filesystem backend has no configured capacity (unlimited).
        assert.deepStrictEqual(usage.limit, { isUnlimited: true })
        assert.deepStrictEqual(usage.restrictedActions, [])
        assert.match(usage.measuredAt, /^\d{4}-\d{2}-\d{2}T/)
        // The per-collection report is the whole report -- no nested breakdown.
        assert.equal(usage.usageByCollection, undefined)
      }
    },
    {
      id: 'backend-quota.missing-collection-quota-null',
      name: 'returns null reading the quota of a missing collection (404 conflation)',
      group: 'backend & quota',
      optional: true,
      run: async (ctx, state) => {
        const { space } = state
        const missing = space.collection('no-such-collection')
        assert.equal(await missing.quota(), null)
      }
    },
    {
      id: 'space-backends.list-backends',
      name: 'lists the storage backends available in the space',
      group: 'space backends & quotas',
      optional: true,
      run: async (ctx, state) => {
        const { space } = state
        const backends = await space.backends()
        assert.ok(backends)
        assert.equal(backends.length, 1)
        // The display name is server-specific (e.g. 'Server Filesystem' or
        // 'Server PostgreSQL'); the suite runs against any conforming server.
        const { name, ...rest } = backends[0]!
        assert.ok(typeof name === 'string' && name.length > 0)
        assert.deepStrictEqual(rest, {
          id: 'default',
          managedBy: 'server',
          storageMode: ['document', 'blob'],
          persistence: 'durable',
          features: [
            'conditional-writes',
            'changes-query',
            'blinded-index-query',
            'key-epochs',
            'chunked-streams'
          ]
        })
      }
    },
    {
      id: 'space-backends.missing-space-backends-null',
      name: 'returns null listing backends of a missing space (404 conflation)',
      group: 'space backends & quotas',
      optional: true,
      run: async (ctx, state) => {
        const { alice } = state
        assert.equal(await alice.was.space('no-such-space').backends(), null)
      }
    },
    {
      id: 'space-backends.read-space-quotas',
      name: 'reads the space storage quota report, grouped by backend',
      group: 'space backends & quotas',
      optional: true,
      run: async (ctx, state) => {
        const { space } = state
        const report = await space.quotas()
        assert.ok(report)
        assert.match(report.respondedAt, /^\d{4}-\d{2}-\d{2}T/)
        assert.equal(report.backends.length, 1)
        const entry = report.backends[0]
        assert.ok(entry)
        assert.equal(entry.id, 'default')
        // Server-specific display name; just require one.
        assert.ok(typeof entry.name === 'string' && entry.name.length > 0)
        assert.equal(entry.managedBy, 'server')
        assert.equal(entry.state, 'ok')
        assert.ok(entry.usageBytes > 0, 'expected non-zero usage')
        // The default filesystem backend has no configured capacity (unlimited).
        assert.deepStrictEqual(entry.limit, { isUnlimited: true })
        assert.deepStrictEqual(entry.restrictedActions, [])
        assert.match(entry.measuredAt, /^\d{4}-\d{2}-\d{2}T/)
        // The per-Collection breakdown is opt-in (spec `?include=collections`), so
        // a bare report omits it.
        assert.equal(entry.usageByCollection, undefined)
      }
    },
    {
      id: 'space-backends.include-collections-breakdown',
      name: 'reads the per-collection breakdown with includeCollections',
      group: 'space backends & quotas',
      optional: true,
      run: async (ctx, state) => {
        const { space } = state
        const report = await space.quotas({ includeCollections: true })
        assert.ok(report)
        const entry = report.backends[0]
        assert.ok(entry)
        // With the opt-in, the space-level report carries a per-collection breakdown.
        const breakdown = entry.usageByCollection
        assert.ok(breakdown, 'expected a usageByCollection breakdown')
        assert.ok(
          breakdown.some(item => item.id === 'docs'),
          'expected the docs collection in the breakdown'
        )
      }
    },
    {
      id: 'space-backends.missing-space-quotas-null',
      name: 'returns null reading quotas of a missing space (404 conflation)',
      group: 'space backends & quotas',
      optional: true,
      run: async (ctx, state) => {
        const { alice } = state
        assert.equal(await alice.was.space('no-such-space').quotas(), null)
      }
    }
  ]
}
