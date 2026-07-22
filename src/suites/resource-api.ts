/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Resource API.
 */
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  bob: any
}

/**
 * Signs and sends a raw `multipart/form-data` POST to a Collection container.
 * A well-behaved client never sends a malformed multipart body, so the request
 * is assembled by hand: the exact body bytes are both digested by
 * `signCapabilityInvocation` (Request Body Integrity) and sent verbatim over
 * `fetch`, so the server's recomputed digest matches.
 *
 * @param options {object}
 * @param options.url {string}   the Collection container URL (trailing slash)
 * @param options.body {Uint8Array}   the exact multipart body bytes to send
 * @param options.boundary {string}   the multipart boundary token
 * @param options.invocationSigner {any}   the root controller's signer
 * @returns {Promise<Response>}
 */
async function postMultipart({
  url,
  body,
  boundary,
  invocationSigner
}: {
  url: string
  body: Uint8Array<ArrayBuffer>
  boundary: string
  invocationSigner: any
}): Promise<Response> {
  const signatureHeaders = await signCapabilityInvocation({
    url,
    method: 'POST',
    headers: {
      date: new Date().toUTCString(),
      'content-type': `multipart/form-data; boundary=${boundary}`
    },
    body,
    invocationSigner,
    capabilityAction: 'POST'
  })
  // Wrap in a Blob so the exact same bytes travel over `fetch` (the digest was
  // computed over `body`); the explicit `content-type` header still governs.
  return fetch(url, {
    method: 'POST',
    headers: signatureHeaders as Record<string, string>,
    body: new Blob([body])
  })
}

/**
 * Assembles a `multipart/form-data` body from the given parts, each either a
 * plain form field or a file part, using the shared boundary token.
 *
 * @param options {object}
 * @param options.boundary {string}   the multipart boundary token
 * @param options.parts {Array<object>}   the ordered parts to encode
 * @returns {Uint8Array}
 */
function buildMultipartBody({
  boundary,
  parts
}: {
  boundary: string
  parts: Array<{
    name: string
    filename?: string
    contentType?: string
    value: string
  }>
}): Uint8Array<ArrayBuffer> {
  let text = ''
  for (const part of parts) {
    text += `--${boundary}\r\n`
    if (part.filename !== undefined) {
      text +=
        `Content-Disposition: form-data; name="${part.name}"; ` +
        `filename="${part.filename}"\r\n`
      text += `Content-Type: ${part.contentType ?? 'text/plain'}\r\n`
    } else {
      text += `Content-Disposition: form-data; name="${part.name}"\r\n`
    }
    text += `\r\n${part.value}\r\n`
  }
  text += `--${boundary}--\r\n`
  return new TextEncoder().encode(text)
}

export const resourceApi: Suite<State> = {
  id: 'resource-api',
  name: 'Resource API',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    alice.space1 = { id: ctx.generateId() }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    // Pre-create the credentials collection so resource tests can POST/PUT into it
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
      method: 'POST',
      json: { id: 'credentials', name: 'Verifiable Credentials' }
    })
    return { alice, bob }
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
      id: 'resource.anonymous-read-404',
      name: 'GET a resource with no auth headers falls through to policy and 404s (no public policy)',
      specRefs: ['https://wallet.storage/spec#read-resource-operation'],
      run: async ctx => {
        const { serverUrl } = ctx
        // Reads no longer 401 at the hook: an anonymous read is allowed to attempt,
        // and is denied as 404 (no-leak) when no access-control policy grants it.
        const response = await fetch(
          new URL('/space/any-space-id/any-collection/any-resource', serverUrl),
          { method: 'GET' }
        )
        assert.equal(response.status, 404)
        assert.match(
          response.headers.get('content-type')!,
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'resource.read-missing-404',
      name: 'GET /space/:spaceId/:collectionId/:resourceId should 404 error on not found space id',
      specRefs: ['https://wallet.storage/spec#read-resource-operation'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const url = new URL(
          '/space/space-id-that-does-not-exist/unknown-collection/unknown-resource',
          serverUrl
        ).toString()
        let expectedError: any
        try {
          await alice.rootClient.request({ url, method: 'GET' })
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
      id: 'resource.post-get',
      name: '[root] POST and GET Resource with proper authorization',
      specRefs: [
        'https://wallet.storage/spec#create-resource-add-resource-to-collection-operation',
        'https://wallet.storage/spec#read-resource-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const body = {
          id: 'sample-resource',
          name: 'Sample Verifiable Credential'
        }
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/credentials/`,
            serverUrl
          ).toString(),
          method: 'POST',
          action: 'POST',
          json: body
        })
        assert.equal(response.status, 201)
        assert.equal(response.data['content-type'], 'application/json')
        assert.match(response.headers.get('content-type'), /application\/json/)

        const resourceUrl = response.headers.get('location')
        assert.ok(
          resourceUrl.startsWith(
            `${serverUrl}/space/${alice.space1.id}/credentials/`
          )
        )

        const fetchResourceResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(fetchResourceResponse.status, 200)
        assert.match(
          fetchResourceResponse.headers.get('content-type'),
          /application\/json/
        )
        assert.equal(
          fetchResourceResponse.data.name,
          'Sample Verifiable Credential'
        )
      }
    },
    {
      id: 'resource.post-get-non-json',
      name: '[root] POST and GET a non-JSON resource',
      specRefs: [
        'https://wallet.storage/spec#create-resource-add-resource-to-collection-operation',
        'https://wallet.storage/spec#content-types-and-representations'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const body = new Blob(['line 1\nline2\n'], { type: 'text/plain' })
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/credentials/`,
            serverUrl
          ).toString(),
          method: 'POST',
          body
        })
        assert.equal(response.status, 201)

        const createdUrl = response.headers.get('location')
        const fetchResourceResponse = await alice.rootClient.request({
          url: createdUrl,
          method: 'GET'
        })
        assert.equal(fetchResourceResponse.status, 200)
        const responseBody = await fetchResourceResponse.text()
        assert.equal(responseBody, 'line 1\nline2\n')
      }
    },
    {
      id: 'resource.put-get',
      name: '[root] PUT and GET Resource',
      specRefs: [
        'https://wallet.storage/spec#update-or-create-by-id-resource-operation',
        'https://wallet.storage/spec#read-resource-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const resourceId = 'put-resource'
        const resourceUrl = new URL(
          `/space/${alice.space1.id}/credentials/${resourceId}`,
          serverUrl
        ).toString()
        const body = { id: resourceId, name: 'PUT Resource Test' }

        const putResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: body
        })
        assert.equal(putResponse.status, 204)

        const getResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(getResponse.status, 200)
        assert.equal(getResponse.data.name, 'PUT Resource Test')
      }
    },
    {
      id: 'resource.put-missing-collection-404',
      name: '[root] PUT Resource to non-existent collection should 404',
      specRefs: [
        'https://wallet.storage/spec#update-or-create-by-id-resource-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const resourceUrl = new URL(
          `/space/${alice.space1.id}/collection-does-not-exist/some-resource`,
          serverUrl
        ).toString()
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: resourceUrl,
            method: 'PUT',
            json: { name: 'test' }
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
      id: 'resource.put-upsert',
      name: '[root] PUT Resource should update existing resource (upsert)',
      specRefs: [
        'https://wallet.storage/spec#update-or-create-by-id-resource-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const resourceId = 'upsert-resource'
        const resourceUrl = new URL(
          `/space/${alice.space1.id}/credentials/${resourceId}`,
          serverUrl
        ).toString()

        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Original Name' }
        })

        const secondPut = await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Updated Name' }
        })
        assert.equal(secondPut.status, 204)

        const getResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(getResponse.status, 200)
        assert.equal(getResponse.data.name, 'Updated Name')
      }
    },
    {
      id: 'resource.cross-user-read-404',
      name: "[root] Bob should not be able to GET Alice's resources",
      specRefs: ['https://wallet.storage/spec#read-resource-operation'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, bob } = state
        const body = {
          id: 'alice-private-resource',
          name: 'Alice Private Resource'
        }
        const postResponse = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/credentials/`,
            serverUrl
          ).toString(),
          method: 'POST',
          json: body
        })
        assert.equal(postResponse.status, 201)
        const resourceUrl = postResponse.headers.get('location')

        let expectedError: any
        try {
          await bob.rootClient.request({ url: resourceUrl, method: 'GET' })
        } catch (err) {
          expectedError = err
        }
        // Bob gets a 404, not a 403, to avoid revealing the resource's existence
        assert.equal(expectedError.response.status, 404)
        assert.match(
          expectedError.response.headers.get('content-type'),
          /application\/problem\+json/
        )

        await alice.rootClient.request({ url: resourceUrl, method: 'DELETE' })
      }
    },
    {
      id: 'resource.meta-get-or-skip',
      name: '[root] GET Resource Metadata (/meta), or skip if unimplemented',
      specRefs: [
        'https://wallet.storage/spec#read-resource-metadata-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice } = state
        // Resource Metadata is OPTIONAL: a server that does not implement it
        // responds 501 `unsupported-operation`, which this test treats as a skip.
        const resourceId = generateId()
        const resourceUrl = new URL(
          `/space/${alice.space1.id}/credentials/${resourceId}`,
          serverUrl
        ).toString()
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Metadata Resource' }
        })

        const metaUrl = `${resourceUrl}/meta`
        let response: any
        try {
          response = await alice.rootClient.request({
            url: metaUrl,
            method: 'GET'
          })
        } catch (err: any) {
          if (err.response?.status === 501) {
            // Optional endpoint not implemented -- pass with skip.
            ctx.skip('Resource Metadata (/meta) not implemented (501)')
          }
          throw err
        }

        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)
        assert.equal(response.data.contentType, 'application/json')
        assert.ok(
          Number.isInteger(response.data.size) && response.data.size > 0,
          'size should be a positive integer'
        )

        // An anonymous (unsigned) meta read must not leak existence: 404 problem+json.
        const anonResponse = await fetch(new URL(metaUrl))
        assert.equal(anonResponse.status, 404)
        assert.match(
          anonResponse.headers.get('content-type')!,
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'head.binary-resource',
      name: '[root] HEAD a binary resource returns its content-type + content-length, no body',
      group: 'HEAD Resource',
      specRefs: [
        'https://wallet.storage/spec#read-resource-operation',
        'https://wallet.storage/spec#content-types-and-representations'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // 'line 1\nline2\n' is exactly 13 bytes.
        const body = new Blob(['line 1\nline2\n'], { type: 'text/plain' })
        const postResponse = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/credentials/`,
            serverUrl
          ).toString(),
          method: 'POST',
          body
        })
        assert.equal(postResponse.status, 201)
        const resourceUrl = postResponse.headers.get('location')

        const headResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'HEAD'
        })
        assert.equal(headResponse.status, 200)
        assert.match(headResponse.headers.get('content-type'), /text\/plain/)
        assert.equal(headResponse.headers.get('content-length'), '13')
        // HEAD carries no body.
        assert.equal(await headResponse.text(), '')
      }
    },
    {
      id: 'head.private-denied-404',
      name: 'anonymous HEAD of a private resource is denied (404, no leak)',
      group: 'HEAD Resource',
      specRefs: ['https://wallet.storage/spec#read-resource-operation'],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice } = state
        const resourceId = generateId()
        const resourceUrl = new URL(
          `/space/${alice.space1.id}/credentials/${resourceId}`,
          serverUrl
        ).toString()
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Private HEAD Resource' }
        })

        const response = await fetch(new URL(resourceUrl), { method: 'HEAD' })
        assert.equal(response.status, 404)
      }
    },
    {
      id: 'head.public-matches-get',
      name: 'anonymous HEAD of a PublicCanRead resource returns headers matching a GET',
      group: 'HEAD Resource',
      specRefs: [
        'https://wallet.storage/spec#read-resource-operation',
        'https://wallet.storage/spec#content-types-and-representations'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice } = state
        const resourceId = generateId()
        const resourceUrl = new URL(
          `/space/${alice.space1.id}/credentials/${resourceId}`,
          serverUrl
        ).toString()
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Public HEAD Resource' }
        })
        // Grant public read at the resource level.
        await alice.rootClient.request({
          url: `${resourceUrl}/policy`,
          method: 'PUT',
          json: { type: 'PublicCanRead' }
        })

        // The HEAD Content-Type/Content-Length must match what a GET returns
        // (spec "Content Types and Representations": both correspond to the
        // Metadata `contentType`/`size`).
        const getResponse = await fetch(new URL(resourceUrl))
        assert.equal(getResponse.status, 200)
        const getBytes = await getResponse.arrayBuffer()

        const headResponse = await fetch(new URL(resourceUrl), {
          method: 'HEAD'
        })
        assert.equal(headResponse.status, 200)
        assert.equal(
          headResponse.headers.get('content-type'),
          getResponse.headers.get('content-type')
        )
        assert.equal(
          headResponse.headers.get('content-length'),
          String(getBytes.byteLength)
        )
        assert.equal(await headResponse.text(), '')

        // Cleanup: revoke the resource policy.
        await alice.rootClient.request({
          url: `${resourceUrl}/policy`,
          method: 'DELETE'
        })
      }
    },
    {
      id: 'resource.post-delete',
      name: '[root] POST and DELETE Resource with proper authorization',
      specRefs: [
        'https://wallet.storage/spec#create-resource-add-resource-to-collection-operation',
        'https://wallet.storage/spec#delete-resource-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const body = { id: 'sample-resource-to-delete', name: 'Sample Delete' }
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/credentials/`,
            serverUrl
          ).toString(),
          method: 'POST',
          json: body
        })
        assert.equal(response.status, 201)
        assert.equal(response.data['content-type'], 'application/json')
        assert.match(response.headers.get('content-type'), /application\/json/)

        const resourceUrl = response.headers.get('location')
        assert.ok(
          resourceUrl.startsWith(
            `${serverUrl}/space/${alice.space1.id}/credentials/`
          )
        )

        const fetchResourceResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(fetchResourceResponse.status, 200)

        const deleteResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'DELETE'
        })
        assert.equal(deleteResponse.status, 204)

        let checkResponse: any
        try {
          await alice.rootClient.request({ url: resourceUrl, method: 'GET' })
        } catch (err: any) {
          checkResponse = err.response
        }
        assert.equal(checkResponse.status, 404)
      }
    },
    {
      id: 'resource.multipart-zero-file-parts-400',
      name:
        '[root] a multipart upload with no file part is rejected with 400 ' +
        'invalid-request-body',
      specRefs: [
        'https://wallet.storage/spec#content-types-and-representations',
        'https://wallet.storage/spec#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // Multipart upload support is OPTIONAL; where offered, a write targets a
        // single Resource, so a body with no file part MUST be rejected. A
        // server that does not accept multipart at all is treated as a skip.
        const url = new URL(
          `/space/${alice.space1.id}/credentials/`,
          serverUrl
        ).toString()
        const boundary = '----wasconf-zero-parts'
        const body = buildMultipartBody({
          boundary,
          parts: [{ name: 'note', value: 'no file here' }]
        })
        const response = await postMultipart({
          url,
          body,
          boundary,
          invocationSigner: alice.rootClient.invocationSigner
        })
        if (response.status === 415 || response.status === 501) {
          ctx.skip('server does not accept multipart uploads')
        }
        assert.equal(response.status, 400)
        assert.match(
          response.headers.get('content-type') ?? '',
          /application\/problem\+json/
        )
        const problem: any = await response.json()
        assert.equal(
          problem.type,
          'https://wallet.storage/spec#invalid-request-body'
        )
      }
    },
    {
      id: 'resource.multipart-two-file-parts-400',
      name:
        '[root] a multipart upload with two file parts is rejected with 400 ' +
        'invalid-request-body',
      specRefs: [
        'https://wallet.storage/spec#content-types-and-representations',
        'https://wallet.storage/spec#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const url = new URL(
          `/space/${alice.space1.id}/credentials/`,
          serverUrl
        ).toString()
        const boundary = '----wasconf-two-parts'
        const body = buildMultipartBody({
          boundary,
          parts: [
            {
              name: 'file1',
              filename: 'a.txt',
              contentType: 'text/plain',
              value: 'first file'
            },
            {
              name: 'file2',
              filename: 'b.txt',
              contentType: 'text/plain',
              value: 'second file'
            }
          ]
        })
        const response = await postMultipart({
          url,
          body,
          boundary,
          invocationSigner: alice.rootClient.invocationSigner
        })
        if (response.status === 415 || response.status === 501) {
          ctx.skip('server does not accept multipart uploads')
        }
        assert.equal(response.status, 400)
        assert.match(
          response.headers.get('content-type') ?? '',
          /application\/problem\+json/
        )
        const problem: any = await response.json()
        assert.equal(
          problem.type,
          'https://wallet.storage/spec#invalid-request-body'
        )
      }
    },
    {
      id: 'resource.read-ignores-unacceptable-accept',
      name:
        '[root] GET a JSON Resource with an unsatisfiable Accept returns 200, ' +
        'never 406',
      specRefs: [
        'https://wallet.storage/spec#content-types-and-representations'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice } = state
        // A Resource has exactly one stored representation; the Accept header is
        // advisory. A server MUST NOT reject a read for lack of an acceptable
        // representation -- the stored representation is always the answer.
        const resourceId = generateId()
        const resourceUrl = new URL(
          `/space/${alice.space1.id}/credentials/${resourceId}`,
          serverUrl
        ).toString()
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Accept-Ignored Resource' }
        })

        const response = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET',
          headers: { accept: 'application/vnd.nonexistent' }
        })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)
        assert.equal(response.data.name, 'Accept-Ignored Resource')
      }
    },
    {
      id: 'resource.putmeta-ignores-server-managed',
      name:
        '[root] PUT /meta ignores top-level contentType/size and applies only ' +
        'custom',
      specRefs: [
        'https://wallet.storage/spec#update-resource-metadata-operation',
        'https://wallet.storage/spec#resource-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice } = state
        // Resource Metadata is OPTIONAL: a server that does not implement it
        // responds 501 `unsupported-operation`, which this test treats as a skip.
        const resourceId = generateId()
        const resourceUrl = new URL(
          `/space/${alice.space1.id}/credentials/${resourceId}`,
          serverUrl
        ).toString()
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Metadata Resource' }
        })
        const metaUrl = `${resourceUrl}/meta`

        // Read the server-managed metadata first (skips if /meta is 501).
        let before: any
        try {
          before = await alice.rootClient.request({
            url: metaUrl,
            method: 'GET'
          })
        } catch (err: any) {
          if (err.response?.status === 501) {
            ctx.skip('Resource Metadata (/meta) not implemented (501)')
          }
          throw err
        }
        assert.equal(before.data.contentType, 'application/json')
        const managedSize = before.data.size
        assert.ok(Number.isInteger(managedSize) && managedSize > 0)

        // PUT /meta carrying bogus top-level server-managed props alongside
        // `custom`: only `custom` is applied; the rest MUST be ignored.
        const custom = { name: 'User Label', tags: { status: 'draft' } }
        const putResponse = await alice.rootClient.request({
          url: metaUrl,
          method: 'PUT',
          action: 'PUT',
          json: { contentType: 'text/plain', size: 999999, custom }
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
        // Server-managed properties are untouched by the write.
        assert.equal(after.data.contentType, 'application/json')
        assert.equal(after.data.size, managedSize)
        // The user-writable `custom` object was applied.
        assert.deepStrictEqual(after.data.custom, custom)
      }
    }
  ]
}
