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
      specRefs: ['https://wallet.storage/spec#list-spaces-operation'],
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
      specRefs: ['https://wallet.storage/spec#list-spaces-operation'],
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
      specRefs: ['https://wallet.storage/spec#create-space-operation'],
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
      id: 'repository.create-missing-controller-400',
      name: 'POST /spaces/ without a "controller" in the body yields invalid-request-body (400)',
      group: 'Spaces Repository API',
      specRefs: [
        'https://wallet.storage/spec#create-space-errors',
        'https://wallet.storage/spec#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { createSpace, generateId } = ctx
        const { alice } = state
        // The `controller` requirement applies before any provisioning or
        // capability concern, so this holds on both the onboarding-token and
        // signed-zcap paths. The token path of createSpace() returns the
        // status; the zcap path throws on non-2xx -- capture either shape.
        let status: number | undefined, problem: any
        try {
          const response = await createSpace({
            spaceDescription: {
              id: generateId(),
              name: 'Space With No Controller'
            },
            rootClient: alice.rootClient
          })
          status = response.status
          problem = response.data
        } catch (err: any) {
          status = err.response?.status
          problem = err.data
        }
        assert.equal(status, 400)
        assert.equal(
          problem.type,
          'https://wallet.storage/spec#invalid-request-body'
        )
      }
    },
    {
      id: 'repository.create-controller-mismatch-400',
      name: "[root] POST /spaces/ signed by a key that is not the body's controller yields controller-mismatch (400)",
      group: 'Spaces Repository API',
      specRefs: [
        'https://wallet.storage/spec#create-space-errors',
        'https://wallet.storage/spec#controller-mismatch'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice, bob } = state
        if (ctx.onboardingToken) {
          // With an onboarding token configured, the token itself vouches for
          // provisioning (delegated provisioning), so the signer-vs-body
          // consent check under test here is legitimately skipped.
          ctx.skip(
            'onboarding token configured: token vouches for provisioning'
          )
        }
        // Create Space is verified against the *body's* controller: Bob signs
        // the invocation but names Alice as controller, with no delegation
        // chain rooted in her -- the direct signer-mismatch shape.
        const spaceId = generateId()
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: new URL('/spaces/', serverUrl).toString(),
            method: 'POST',
            action: 'POST',
            json: {
              id: spaceId,
              name: 'Space Bob Claims For Alice',
              controller: alice.did
            }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the mismatched create to fail')
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#controller-mismatch'
        )

        // The Space must not have been created: its named controller (Alice)
        // would be able to read it if it had been.
        let checkError: any
        try {
          await alice.rootClient.request({
            url: new URL(`/space/${spaceId}`, serverUrl).toString(),
            method: 'GET'
          })
        } catch (err) {
          checkError = err
        }
        assert.ok(checkError, 'the rejected Space must not exist')
        assert.equal(checkError.response.status, 404)
      }
    },
    {
      id: 'repository.create-invalid-id-400',
      name: 'POST /spaces/ with a non-URL-safe space id yields invalid-id (400)',
      group: 'Spaces Repository API',
      specRefs: [
        'https://wallet.storage/spec#identifiers',
        'https://wallet.storage/spec#invalid-id'
      ],
      run: async (ctx, state) => {
        const { createSpace } = ctx
        const { alice } = state
        // The id is carried in the request body (not the URL), so it reaches
        // id validation rather than being reshaped by routing. A space
        // character is outside the RFC 3986 unreserved set, so the id is not
        // URL-safe (spec: Identifier Required Properties). Rejection precedes
        // any provisioning concern, so this holds on both the onboarding-token
        // and signed-zcap paths: the token path of createSpace() returns the
        // status; the zcap path throws on non-2xx -- capture either shape.
        let status: number | undefined, problem: any
        try {
          const response = await createSpace({
            spaceDescription: {
              id: 'a b',
              name: 'Space With An Unsafe Id',
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
        assert.equal(status, 400)
        assert.equal(problem.type, 'https://wallet.storage/spec#invalid-id')
      }
    },
    {
      id: 'repository.create-controller-not-did-400',
      name: 'POST /spaces/ whose body controller is not a DID is rejected (400 invalid-request-body)',
      group: 'Spaces Repository API',
      specRefs: [
        'https://wallet.storage/spec#create-space-errors',
        'https://wallet.storage/spec#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { createSpace, generateId } = ctx
        const { alice } = state
        // A `controller` that is present but not a DID (here an https URL) is a
        // malformed request body -- rejected before any provisioning concern,
        // so this holds on both the onboarding-token and signed-zcap paths. The
        // token path of createSpace() returns the status; the zcap path throws
        // on non-2xx -- capture either shape.
        let status: number | undefined, problem: any
        try {
          const response = await createSpace({
            spaceDescription: {
              id: generateId(),
              name: 'Space With A Non-DID Controller',
              controller: 'https://example.com/alice'
            },
            rootClient: alice.rootClient
          })
          status = response.status
          problem = response.data
        } catch (err: any) {
          status = err.response?.status
          problem = err.data
        }
        assert.equal(status, 400)
        assert.equal(
          problem.type,
          'https://wallet.storage/spec#invalid-request-body'
        )
      }
    },
    {
      id: 'repository.create-delegated-201',
      name: "[delegated] a provisioning app creates a Space on Alice's behalf via POST (201)",
      group: 'Spaces Repository API',
      specRefs: [
        'https://wallet.storage/spec#create-space-operation',
        'https://wallet.storage/spec#was-authorization-profile-v0-1'
      ],
      run: async (ctx, state) => {
        const { serverUrl, zcapClient, generateId } = ctx
        const { alice, aliceDelegatedApp } = state
        if (ctx.onboardingToken) {
          // With an onboarding token configured, the token vouches for
          // provisioning, so the delegated-consent path under test here is
          // legitimately bypassed.
          ctx.skip(
            'onboarding token configured: token vouches for provisioning'
          )
        }
        // Alice delegates a POST /spaces/ capability to her app; the app
        // invokes it, naming Alice as the controller. The invocation is
        // authorized by a delegation chain rooted in the body's controller, so
        // the create succeeds and Alice controls the Space from the start
        // (delegated provisioning).
        const spacesUrl = new URL('/spaces/', serverUrl).toString()
        const aliceAppClient = zcapClient({ signer: aliceDelegatedApp.signer })
        const provisioningCapability = await alice.rootClient.delegate({
          allowedActions: ['POST'],
          invocationTarget: spacesUrl,
          controller: aliceDelegatedApp.did
        })

        const spaceId = generateId()
        const spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
        try {
          const response = await aliceAppClient.request({
            url: spacesUrl,
            capability: provisioningCapability,
            method: 'POST',
            action: 'POST',
            json: {
              id: spaceId,
              name: 'Provisioned for Alice',
              controller: alice.did
            }
          })
          assert.equal(response.status, 201)
          assert.equal((response.data as any).controller, alice.did)

          // The Space exists and is controlled by Alice: her root key reads it.
          const checkResponse = await alice.rootClient.request({
            url: spaceUrl,
            method: 'GET',
            action: 'GET'
          })
          assert.equal(checkResponse.status, 200)
          assert.equal(checkResponse.data.controller, alice.did)
        } finally {
          try {
            await alice.rootClient.request({ url: spaceUrl, method: 'DELETE' })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'repository.error-body-type-and-title',
      name: 'an error response carries both a non-empty `type` and a non-empty `title`',
      group: 'Spaces Repository API',
      specRefs: ['https://wallet.storage/spec#error-handling'],
      run: async ctx => {
        const { serverUrl } = ctx
        // An unauthenticated Create Space is a request/credential failure (401),
        // returned as problem+json. The spec makes `type` and `title` REQUIRED
        // members of every error body.
        const response = await fetch(new URL('/spaces/', serverUrl), {
          method: 'POST'
        })
        assert.equal(response.status, 401)
        assert.match(
          response.headers.get('content-type')!,
          /application\/problem\+json/
        )
        const problem = (await response.json()) as {
          type?: unknown
          title?: unknown
        }
        assert.equal(typeof problem.type, 'string')
        assert.ok(
          (problem.type as string).length > 0,
          'error `type` must be non-empty'
        )
        assert.equal(typeof problem.title, 'string')
        assert.ok(
          (problem.title as string).length > 0,
          'error `title` must be non-empty'
        )
      }
    },
    {
      id: 'space.create-post',
      name: '[root] create space via POST',
      group: 'Space API',
      specRefs: ['https://wallet.storage/spec#create-space-operation'],
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
      specRefs: [
        'https://wallet.storage/spec#update-or-create-by-id-space-operation'
      ],
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
      id: 'space.update-controller-swap-404',
      name: "[root] a PUT swapping 'controller', signed by the would-be new controller, yields 404 and does not transfer the Space",
      group: 'Space API',
      specRefs: [
        'https://wallet.storage/spec#update-or-create-by-id-space-operation',
        'https://wallet.storage/spec#not-found'
      ],
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice, bob } = state
        // An update MUST be verified against the *stored* controller, not the
        // body's proposed one -- otherwise any caller could seize an existing
        // Space by PUTting its id with themselves as controller. Bob attempts
        // exactly that takeover; as an unauthorized write to an existing
        // Space, it gets the privacy-merged not-found (404) mask.
        const spaceId = generateId()
        await createSpace({
          spaceDescription: {
            id: spaceId,
            name: 'Escalation Target Space',
            controller: alice.did
          },
          rootClient: alice.rootClient
        })

        const spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
        try {
          let expectedError: any
          try {
            await bob.rootClient.request({
              url: spaceUrl,
              method: 'PUT',
              action: 'PUT',
              json: {
                id: spaceId,
                name: 'Seized Space',
                controller: bob.did
              }
            })
          } catch (err) {
            expectedError = err
          }
          assert.ok(expectedError, 'expected the takeover PUT to fail')
          assert.equal(expectedError.response.status, 404)
          assert.match(
            expectedError.response.headers.get('content-type'),
            /application\/problem\+json/
          )
          assert.equal(
            expectedError.data.type,
            'https://wallet.storage/spec#not-found'
          )

          // The operation must not have been performed: Alice still controls
          // the Space, name and controller unchanged.
          const checkResponse = await alice.rootClient.request({
            url: spaceUrl,
            method: 'GET'
          })
          assert.equal(checkResponse.status, 200)
          assert.equal(checkResponse.data.controller, alice.did)
          assert.equal(checkResponse.data.name, 'Escalation Target Space')
        } finally {
          try {
            await alice.rootClient.request({ url: spaceUrl, method: 'DELETE' })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'space.anonymous-read-404',
      name: 'GET a space with no auth headers falls through to policy and 404s (no public policy)',
      group: 'Space API',
      specRefs: [
        'https://wallet.storage/spec#read-space-operation',
        'https://wallet.storage/spec#read-space-errors'
      ],
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
      specRefs: [
        'https://wallet.storage/spec#read-space-operation',
        'https://wallet.storage/spec#read-space-errors'
      ],
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
      specRefs: ['https://wallet.storage/spec#read-space-operation'],
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
      specRefs: [
        'https://wallet.storage/spec#read-space-operation',
        'https://wallet.storage/spec#was-authorization-profile-v0-1'
      ],
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
      specRefs: [
        'https://wallet.storage/spec#read-space-operation',
        'https://wallet.storage/spec#read-space-errors'
      ],
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
      specRefs: ['https://wallet.storage/spec#delete-space-operation'],
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
      id: 'space.create-post-conflict-preserves-original',
      name: '[root] a conflicting POST leaves the original Space untouched (409)',
      group: 'Space API',
      specRefs: [
        'https://wallet.storage/spec#create-space-errors',
        'https://wallet.storage/spec#id-conflict'
      ],
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice, bob } = state
        const spaceId = generateId()
        const spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
        await createSpace({
          spaceDescription: {
            id: spaceId,
            name: 'Original Space',
            controller: alice.did
          },
          rootClient: alice.rootClient
        })
        try {
          // POST the same id again with a different name and controller. The
          // existence check precedes any provisioning concern, so this is a 409
          // id-conflict; create-or-replace by id is PUT's job. The token path
          // of createSpace() returns the status; the zcap path throws on
          // non-2xx -- capture either shape.
          let status: number | undefined, problem: any
          try {
            const response = await createSpace({
              spaceDescription: {
                id: spaceId,
                name: 'Usurping Space',
                controller: bob.did
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

          // The original Space is untouched: its name and controller are as
          // first created, not the conflicting POST's proposed values.
          const checkResponse = await alice.rootClient.request({
            url: spaceUrl,
            method: 'GET',
            action: 'GET'
          })
          assert.equal(checkResponse.status, 200)
          assert.equal(checkResponse.data.name, 'Original Space')
          assert.equal(checkResponse.data.controller, alice.did)
        } finally {
          try {
            await alice.rootClient.request({ url: spaceUrl, method: 'DELETE' })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'space.create-ignores-body-createdby',
      name: '[root] a body-supplied `createdBy` is ignored by the server',
      group: 'Space API',
      specRefs: ['https://wallet.storage/spec#space-data-model'],
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice } = state
        // `createdBy` is server-managed and read-only: the spec requires a
        // server to ignore a `createdBy` supplied in a request body. The value
        // below is a well-formed but bogus DID that is not the creator.
        const bogusCreatedBy =
          'did:key:z6MkpBMbMaRSv5nsgifRAwEKvHHoiKDMhiAHShTFNmkJXXXX'
        const spaceId = generateId()
        const spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
        await createSpace({
          spaceDescription: {
            id: spaceId,
            name: 'Space With A Bogus createdBy',
            controller: alice.did,
            createdBy: bogusCreatedBy
          },
          rootClient: alice.rootClient
        })
        try {
          const response = await alice.rootClient.request({
            url: spaceUrl,
            method: 'GET',
            action: 'GET'
          })
          assert.equal(response.status, 200)
          // Either absent (token-provisioned create records no createdBy) or
          // set to the real invoker -- never the bogus body value.
          assert.notEqual(
            response.data.createdBy,
            bogusCreatedBy,
            'the server must ignore a body-supplied createdBy'
          )
        } finally {
          try {
            await alice.rootClient.request({ url: spaceUrl, method: 'DELETE' })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'space.create-put-controller-mismatch-400',
      name: '[root] PUT-creating a new Space, signed by someone other than the body controller, yields controller-mismatch (400)',
      group: 'Space API',
      specRefs: [
        'https://wallet.storage/spec#update-or-create-by-id-space-operation',
        'https://wallet.storage/spec#controller-mismatch'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice, bob } = state
        // The create branch of PUT is authorized by the *body's* controller,
        // just like Create Space via POST. Bob signs a PUT that would create a
        // new Space naming Alice as controller, with no delegation chain rooted
        // in her -- the direct signer-mismatch shape (this is the CREATE
        // branch; the update branch is covered by space.update-controller-swap).
        const spaceId = generateId()
        const spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: spaceUrl,
            method: 'PUT',
            action: 'PUT',
            json: {
              id: spaceId,
              name: 'Consentless Space',
              controller: alice.did
            }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the unconsented PUT-create to fail')
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://wallet.storage/spec#controller-mismatch'
        )

        // The Space must not have been created: its named controller (Alice)
        // would be able to read it if it had been.
        let checkError: any
        try {
          await alice.rootClient.request({
            url: spaceUrl,
            method: 'GET',
            action: 'GET'
          })
        } catch (err) {
          checkError = err
        }
        assert.ok(checkError, 'the rejected Space must not exist')
        assert.equal(checkError.response.status, 404)
      }
    },
    {
      id: 'space.reserved-policy-segment',
      name: "[root] GET /space/:spaceId/policy is served as the policy endpoint, not a collection named 'policy'",
      group: 'Space API',
      specRefs: [
        'https://wallet.storage/spec#reserved-path-segment-registry',
        'https://wallet.storage/spec#space-level-reserved-endpoints'
      ],
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice } = state
        const spaceId = generateId()
        const spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
        const policyUrl = new URL(
          `/space/${spaceId}/policy`,
          serverUrl
        ).toString()
        await createSpace({
          spaceDescription: {
            id: spaceId,
            name: 'Reserved Segment Space',
            controller: alice.did
          },
          rootClient: alice.rootClient
        })
        try {
          // `policy` is a reserved space-level segment: it addresses the
          // access-control policy resource, and MUST NOT be repurposed as a
          // Collection id. Set a policy, then read it back through the same
          // segment to confirm it is served as the policy endpoint.
          await alice.rootClient.request({
            url: policyUrl,
            method: 'PUT',
            action: 'PUT',
            json: { type: 'PublicCanRead' }
          })
          const response = await alice.rootClient.request({
            url: policyUrl,
            method: 'GET',
            action: 'GET'
          })
          assert.equal(response.status, 200)
          // The response is a policy document -- it carries the policy `type`
          // we stored -- not a Collection listing (which would carry `items`).
          assert.equal(response.data.type, 'PublicCanRead')
          assert.equal(
            response.data.items,
            undefined,
            'the policy endpoint must not return a Collection listing'
          )
        } finally {
          try {
            await alice.rootClient.request({ url: spaceUrl, method: 'DELETE' })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'collections.list-for-space',
      name: '[root] GET /space/:spaceId/collections/ lists collections for a space',
      group: 'Collections API',
      specRefs: ['https://wallet.storage/spec#list-all-collections-operation'],
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
