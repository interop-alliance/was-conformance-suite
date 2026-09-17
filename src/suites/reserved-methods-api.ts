/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Methods at Reserved Endpoints (spec "Methods at
 * Reserved Endpoints").
 *
 * A request to a reserved endpoint (see the spec's three Reserved Path
 * Segment Registry tables) with a method the server does not implement there
 * MUST be answered `405 Method Not Allowed`, with an `Allow` header naming
 * the methods it does implement, an `about:blank` problem type, and the
 * title "Method Not Allowed". An endpoint whose whole feature group is an
 * OPTIONAL extension the server does not implement at all is instead
 * governed by that group's own rule -- typically `unsupported-operation`
 * (501) -- so most cases here accept a 501 in place of the 405. Every case
 * is still required, since either answer is spec-conformant and any other
 * answer is not. A method this specification never assigns an operation to
 * anywhere (`PATCH`), and the container-URL `PUT` refusal, carry no 501
 * escape.
 *
 * Every request is a signed root invocation by Alice: several reserved
 * endpoints require authorization for unsafe methods before the refusal is
 * ever reached (`requireAuthHeadersOrPublicRead` lets only safe methods
 * through unauthenticated), so signing throughout keeps every case on the
 * same footing. Raw `signCapabilityInvocation` + `fetch` is used instead of
 * the high-level `ZcapClient.request()` so arbitrary methods (`PATCH`,
 * `HEAD`) and bodyless success responses can be inspected directly, without
 * the high-level client's success-body JSON parsing or its throw-on-4xx/5xx
 * behavior getting in the way.
 */
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import type { ISigner } from '@interop/data-integrity-core'
import assert from '../harness/assert.js'
import type { Suite, TestCase } from '../harness/types.js'

interface State {
  alice: any
  collectionId: string
  resourceId: string
}

/**
 * Signs a raw capability invocation for an arbitrary method and sends it via
 * `fetch`, returning the response untouched.
 *
 * @param options {object}
 * @param options.url {string}   the target URL
 * @param options.method {string}   the HTTP method to send
 * @param options.invocationSigner {ISigner}   the caller's signer
 * @param [options.json] {object}   an optional JSON body
 * @returns {Promise<Response>}
 */
async function signedRequest({
  url,
  method,
  invocationSigner,
  json
}: {
  url: string
  method: string
  invocationSigner: ISigner
  json?: object
}): Promise<Response> {
  const body =
    json === undefined
      ? undefined
      : new TextEncoder().encode(JSON.stringify(json))
  const signatureHeaders = await signCapabilityInvocation({
    url,
    method,
    headers: {
      date: new Date().toUTCString(),
      ...(body !== undefined && { 'content-type': 'application/json' })
    },
    ...(body !== undefined && { body }),
    invocationSigner,
    capabilityAction: method
  })
  return fetch(url, {
    method,
    headers: signatureHeaders as Record<string, string>,
    ...(body !== undefined && { body: new Blob([body]) })
  })
}

/**
 * Reads a `application/problem+json` body, or `undefined` for a bodyless
 * response.
 *
 * @param response {Response}
 * @returns {Promise<any>}
 */
async function readProblem(response: Response): Promise<any> {
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

/**
 * Splits an `Allow` header into its method tokens.
 *
 * @param allow {string | null}
 * @returns {string[]}
 */
function allowedMethods(allow: string | null): string[] {
  return (allow ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
}

/**
 * Sends a signed request for a method this specification does not define at
 * `url`, and asserts the spec "Methods at Reserved Endpoints" refusal: `405`,
 * an `Allow` header that does not name the refused method, and an
 * `about:blank` problem body titled "Method Not Allowed". When `tolerate501`
 * is set, a `501 unsupported-operation` is also accepted -- the endpoint's
 * whole feature group may be unimplemented, in which case the group's own
 * rule governs instead of this subsection.
 *
 * @param options {object}
 * @param options.invocationSigner {ISigner}
 * @param options.url {string}
 * @param options.method {string}
 * @param [options.tolerate501] {boolean}
 * @returns {Promise<{ status: number; allow: string }>}
 */
async function assertMethodRefused({
  invocationSigner,
  url,
  method,
  tolerate501
}: {
  invocationSigner: ISigner
  url: string
  method: string
  tolerate501?: boolean
}): Promise<{ status: number; allow: string }> {
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
  const response = await signedRequest({
    url,
    method,
    invocationSigner,
    ...(needsBody && { json: {} })
  })
  if (tolerate501 && response.status === 501) {
    return { status: 501, allow: '' }
  }
  assert.equal(
    response.status,
    405,
    `expected 405 for ${method} ${url}, got ${response.status}`
  )
  const allow = response.headers.get('allow') ?? ''
  assert.ok(
    !allowedMethods(allow).includes(method),
    `Allow header should not list ${method} for ${url} (got "${allow}")`
  )
  assert.match(
    response.headers.get('content-type') ?? '',
    /application\/problem\+json/,
    `expected a problem+json body refusing ${method} ${url}`
  )
  const problem = await readProblem(response)
  assert.equal(
    problem?.type,
    'about:blank',
    `expected an about:blank problem type refusing ${method} ${url}`
  )
  assert.equal(
    problem?.title,
    'Method Not Allowed',
    `expected the title "Method Not Allowed" refusing ${method} ${url}`
  )
  return { status: 405, allow }
}

/**
 * Builds the URL for a reserved segment at the given container level.
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.level {'space' | 'collection' | 'resource'}
 * @param options.segment {string}   the reserved segment, e.g. `meta`
 * @returns {string}
 */
function reservedEndpointUrl({
  serverUrl,
  spaceId,
  collectionId,
  resourceId,
  level,
  segment
}: {
  serverUrl: string
  spaceId: string
  collectionId: string
  resourceId: string
  level: 'space' | 'collection' | 'resource'
  segment: string
}): string {
  let relativePath: string
  if (level === 'space') {
    relativePath = `/space/${spaceId}/${segment}`
  } else if (level === 'collection') {
    relativePath = `/space/${spaceId}/${collectionId}/${segment}`
  } else {
    relativePath = `/space/${spaceId}/${collectionId}/${resourceId}/${segment}`
  }
  return new URL(relativePath, serverUrl).toString()
}

/**
 * One reserved-segment table entry: a level, its reserved path segment, the
 * method(s) this specification never assigns an operation to there, and
 * whether the endpoint's whole feature group is an OPTIONAL extension a
 * conformant server may not implement at all (in which case a 501 is
 * accepted in place of the 405).
 */
interface ReservedEndpointCheck {
  id: string
  name: string
  level: 'space' | 'collection' | 'resource'
  segment: string
  methods: string[]
  tolerate501: boolean
  specRefs: string[]
}

const RESERVED_ENDPOINT_CHECKS: ReservedEndpointCheck[] = [
  // Space-level reserved endpoints (spec "Space-level reserved endpoints").
  {
    id: 'reserved-methods.space-meta-delete',
    name: '[root] DELETE /space/:s/meta is refused (405)',
    level: 'space',
    segment: 'meta',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#space-metadata-data-model',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-policy-patch',
    name: '[root] PATCH /space/:s/policy is refused (405)',
    level: 'space',
    segment: 'policy',
    methods: ['PATCH'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#space-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-backends-patch',
    name: '[root] PATCH /space/:s/backends is refused (405)',
    level: 'space',
    segment: 'backends',
    methods: ['PATCH'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#space-backends-available',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-collections-retired',
    name:
      '[root] DELETE/PATCH /space/:s/collections are refused (405) -- the ' +
      'retired segment defines no operation',
    level: 'space',
    segment: 'collections',
    methods: ['DELETE', 'PATCH'],
    tolerate501: false,
    specRefs: [
      'https://w3id.org/pws#space-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-export-get',
    name: '[root] GET /space/:s/export is refused (405)',
    level: 'space',
    segment: 'export',
    methods: ['GET'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#space-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-import-get',
    name: '[root] GET /space/:s/import is refused (405)',
    level: 'space',
    segment: 'import',
    methods: ['GET'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#space-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-linkset-delete',
    name: '[root] DELETE /space/:s/linkset is refused (405)',
    level: 'space',
    segment: 'linkset',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#space-linkset',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-query-refused',
    name:
      '[root] GET/PUT/DELETE/PATCH /space/:s/query are refused (405) -- no ' +
      'cross-collection query operation is defined for them',
    level: 'space',
    segment: 'query',
    methods: ['GET', 'PUT', 'DELETE', 'PATCH'],
    tolerate501: false,
    specRefs: [
      'https://w3id.org/pws#space-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-quotas-put',
    name: '[root] PUT /space/:s/quotas is refused (405)',
    level: 'space',
    segment: 'quotas',
    methods: ['PUT'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#quotas',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  // Collection-level reserved endpoints (spec "Collection-level reserved
  // endpoints"). The Collection need not exist -- the refusal reads no ids.
  {
    id: 'reserved-methods.collection-policy-patch',
    name: '[root] PATCH /space/:s/:c/policy is refused (405)',
    level: 'collection',
    segment: 'policy',
    methods: ['PATCH'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#collection-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.collection-backend-delete',
    name: '[root] DELETE /space/:s/:c/backend is refused (405)',
    level: 'collection',
    segment: 'backend',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#collection-backend-selected',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.collection-linkset-delete',
    name: '[root] DELETE /space/:s/:c/linkset is refused (405)',
    level: 'collection',
    segment: 'linkset',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#collection-linkset',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.collection-meta-delete',
    name: '[root] DELETE /space/:s/:c/meta is refused (405)',
    level: 'collection',
    segment: 'meta',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#collection-metadata-data-model',
      'https://w3id.org/pws#collection-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.collection-meta-log-delete',
    name: '[root] DELETE /space/:s/:c/meta/log is refused (405)',
    level: 'collection',
    segment: 'meta/log',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#collection-governing-history-log',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.collection-query-get',
    name: '[root] GET /space/:s/:c/query is refused (405)',
    level: 'collection',
    segment: 'query',
    methods: ['GET'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#query-profile-registry',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.collection-quota-put',
    name: '[root] PUT /space/:s/:c/quota is refused (405)',
    level: 'collection',
    segment: 'quota',
    methods: ['PUT'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#quotas',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  // Resource-level reserved endpoints (spec "Resource-level reserved
  // endpoints"). Neither the Collection nor the Resource need exist.
  {
    id: 'reserved-methods.resource-meta-post',
    name: '[root] POST /space/:s/:c/:r/meta is refused (405)',
    level: 'resource',
    segment: 'meta',
    methods: ['POST'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#resource-metadata-data-model',
      'https://w3id.org/pws#resource-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.resource-chunks-delete',
    name: '[root] DELETE /space/:s/:c/:r/chunks/ is refused (405)',
    level: 'resource',
    segment: 'chunks/',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws/encrypted-collections#chunked-resources',
      'https://w3id.org/pws#resource-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  }
]

const reservedEndpointTests: Array<TestCase<State>> =
  RESERVED_ENDPOINT_CHECKS.map(check => ({
    id: check.id,
    name: check.name,
    specRefs: check.specRefs,
    run: async (ctx, state) => {
      const { alice, collectionId, resourceId } = state
      const url = reservedEndpointUrl({
        serverUrl: ctx.serverUrl,
        spaceId: alice.space1.id,
        collectionId,
        resourceId,
        level: check.level,
        segment: check.segment
      })
      for (const method of check.methods) {
        await assertMethodRefused({
          invocationSigner: alice.rootClient.invocationSigner,
          url,
          method,
          tolerate501: check.tolerate501
        })
      }
    }
  }))

export const reservedMethodsApi: Suite<State> = {
  id: 'reserved-methods-api',
  name: 'Methods at reserved endpoints (405)',
  specRefs: [
    'https://w3id.org/pws#reserved-path-segment-registry',
    'https://w3id.org/pws#methods-at-reserved-endpoints'
  ],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    alice.space1 = { id: ctx.generateId() }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Reserved-Methods Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    return {
      alice,
      // Neither Collection nor Resource need exist: the refusal reads no
      // ids, so a plain literal id exercises the same code path as a real
      // one without any provisioning cost.
      collectionId: 'reserved-methods-collection',
      resourceId: 'reserved-methods-resource'
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
    ...reservedEndpointTests,
    {
      id: 'reserved-methods.space-container-put',
      name: '[root] PUT /space/:s/ is refused (405), Allow excludes PUT',
      specRefs: [
        'https://w3id.org/pws#space-metadata-data-model',
        'https://w3id.org/pws#methods-at-reserved-endpoints'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const url = new URL(
          `/space/${alice.space1.id}/`,
          ctx.serverUrl
        ).toString()
        await assertMethodRefused({
          invocationSigner: alice.rootClient.invocationSigner,
          url,
          method: 'PUT'
        })
      }
    },
    {
      id: 'reserved-methods.collection-container-put',
      name: '[root] PUT /space/:s/:c/ is refused (405), Allow excludes PUT',
      specRefs: [
        'https://w3id.org/pws#collection-metadata-data-model',
        'https://w3id.org/pws#methods-at-reserved-endpoints'
      ],
      run: async (ctx, state) => {
        const { alice, collectionId } = state
        const url = new URL(
          `/space/${alice.space1.id}/${collectionId}/`,
          ctx.serverUrl
        ).toString()
        await assertMethodRefused({
          invocationSigner: alice.rootClient.invocationSigner,
          url,
          method: 'PUT'
        })
      }
    },
    {
      id: 'reserved-methods.identical-for-absent-space',
      name: '[root] the 405 refusal is identical whether the Space exists',
      specRefs: [
        'https://w3id.org/pws#methods-at-reserved-endpoints',
        'https://w3id.org/pws#error-handling'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const answers: Array<{ status: number; allow: string }> = []
        for (const spaceId of [alice.space1.id, `absent-${ctx.generateId()}`]) {
          const url = new URL(`/space/${spaceId}/`, ctx.serverUrl).toString()
          answers.push(
            await assertMethodRefused({
              invocationSigner: alice.rootClient.invocationSigner,
              url,
              method: 'PUT'
            })
          )
        }
        assert.equal(answers[0]!.status, 405)
        assert.deepStrictEqual(
          answers[1],
          answers[0],
          'the refusal must read no ids: an absent Space gets the same answer'
        )
      }
    },
    {
      id: 'reserved-methods.head-follows-get',
      name:
        '[root] HEAD is not refused where GET is defined at a reserved ' +
        'endpoint',
      optional: true,
      specRefs: [
        'https://w3id.org/pws#methods-at-reserved-endpoints',
        'https://w3id.org/pws#space-linkset'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const url = new URL(
          `/space/${alice.space1.id}/linkset`,
          ctx.serverUrl
        ).toString()
        const getResponse = await signedRequest({
          url,
          method: 'GET',
          invocationSigner: alice.rootClient.invocationSigner
        })
        if (getResponse.status === 501) {
          ctx.skip('Space Linkset (GET) not implemented (501)')
        }
        assert.notEqual(
          getResponse.status,
          405,
          'GET should not itself be refused'
        )
        const headResponse = await signedRequest({
          url,
          method: 'HEAD',
          invocationSigner: alice.rootClient.invocationSigner
        })
        assert.notEqual(
          headResponse.status,
          405,
          'HEAD should follow GET rather than being refused'
        )
      }
    },
    {
      id: 'reserved-methods.options-preflight-not-refused',
      name:
        '[root] an OPTIONS CORS preflight at a reserved endpoint is not ' +
        'refused',
      optional: true,
      specRefs: ['https://w3id.org/pws#methods-at-reserved-endpoints'],
      run: async (ctx, state) => {
        const { alice } = state
        const url = new URL(
          `/space/${alice.space1.id}/linkset`,
          ctx.serverUrl
        ).toString()
        const response = await fetch(url, {
          method: 'OPTIONS',
          headers: {
            origin: 'https://app.example',
            'access-control-request-method': 'DELETE'
          }
        })
        assert.notEqual(
          response.status,
          405,
          'an OPTIONS preflight must not be caught by the reserved-methods ' +
            'refusal'
        )
      }
    }
  ]
}
