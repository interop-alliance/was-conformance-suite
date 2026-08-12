# @interop/was-conformance-suite Changelog

## 0.5.0 - 2026-08-12

### Added

- Collection Metadata (`GET`/`PUT /space/{spaceId}/{collectionId}/meta`) tests
  in the `collection-api` suite, skipped as a group when a server answers 501
  `unsupported-operation` (the endpoints are OPTIONAL): a signed read is 200
  `application/json` while an anonymous one is 404 `application/problem+json`, a
  write sets `custom` and returns an ETag that a read round-trips, a write with
  no `custom` clears it (full replacement), server-managed top-level members in
  the body are ignored (read-modify-write is safe), a write to a nonexistent
  Collection is 404, a non-object `custom` is 400 `invalid-request-body`, a
  stale `If-Match` is 412 `precondition-failed` while the current one succeeds,
  the metadata ETag is independent of the Collection Description ETag, and
  `meta` is a reserved Resource id (409 `reserved-id`).

## 0.4.3 - 2026-08-09

### Added

- Encryption-descriptor `version` tests in the `encryption-descriptor-api`
  suite: an integer `version` round-trips, a non-integer version is 400
  `invalid-request-body`, an explicit `version: 1` on a formerly versionless
  descriptor is accepted (absent means `1`), removing a set version is 409
  `encryption-immutable` (or a no-op that preserves it), raising the version is
  never an immutability conflict, and (optional tier) an unrecognized version of
  a recognized scheme is rejected with `unsupported-encryption-scheme` or stored
  opaquely verbatim.

## 0.4.2 - 2026-08-07

### Added

- Delegated Create Space failure-shape tests in the `spaces-api` suite: a chain
  rooted in a different DID than the body's `controller`, an expired delegation
  (proof backdated via ezcap's `now` override), and a delegation whose proof
  fails verification each yield 400 `controller-mismatch` and leave the Space
  uncreated. An optional-tier test asserts the three failure causes carry
  pairwise-distinct non-empty `detail` strings (top-level or in the `errors`
  array), asserting nothing about wording.

## 0.4.1 - 2026-08-01

### Changed

- Update to latest `@interop/was-client@0.23.0`.

## 0.4.0 - 2026-08-01

### Changed

- **BREAKING: the encryption suite's wire-stable ids renamed to "descriptor"**,
  following the spec's rename of the Collection `encryption` member from
  "marker" to "encryption descriptor". The suite id (CLI `--suite` selector /
  report key) is now `encryption-descriptor-api` (was `encryption-marker-api`),
  and the test ids are `encryption.persist-echo-descriptor`,
  `encryption.delegated-discovers-descriptor`,
  `encryption.malformed-descriptor-400`, and
  `encryption.clear-descriptor-immutable`; `encryption.change-scheme-immutable`
  and `encryption.unrecognized-scheme-400` are unchanged. Report consumers and
  `--suite`/`--grep` invocations keyed on the old strings must update. The
  `encryptionMarkerApi` export is now `encryptionDescriptorApi` (file
  `src/suites/encryption-descriptor-api.ts`), and report-visible test names and
  prose (including the chunks-api test naming the descriptor) follow suit.
- The two `specRefs` pointing at the dangling anchor
  `https://wallet.storage/spec#the-encryption-marker` (which never existed in
  the spec) now point at the real
  `https://wallet.storage/spec#collection-data-model` anchor.

## 0.3.1 - 2026-07-23

### Changed

- `spaces-api` suite: the List All Collections test now accepts the
  spec-optional `public` member on listing items. When a server surfaces it, the
  test enforces the spec's consistency rules (present on every item, and
  explicitly `false` for a Collection with no policy attached) instead of
  failing on the extra field.

## 0.3.0 - 2026-07-22

### Added

- `changes-query-api` suite: a query body with no `profile` member is rejected
  with 400 `invalid-request-body` (the Query Profile Registry marks `profile`
  REQUIRED), distinct from the 501 answered for an unrecognized profile.

- New `chunks-api` suite: Chunked Resources conformance (skipped unless the
  default backend advertises `chunked-streams`; required-tier once it does).
  Covers the octet-stream round-trip (PUT/GET/HEAD/DELETE plus the chunk
  listing), rejection of non-canonical `{index}` values with 400 `invalid-id`,
  opaque chunk bodies accepted verbatim even on an encryption-marked Collection,
  404 for a chunk PUT to a missing parent Resource, the deliberately
  non-idempotent 404 on deleting an absent chunk, cascade deletion of chunks
  with their parent, chunk-write invisibility to the `changes` feed, capability
  URL-binding via a sibling-chunk probe, and cross-user 404 masking of chunk
  URLs.
- New `conditional-requests-api` suite: conditional writes and caching (skipped
  unless the default backend advertises `conditional-writes`, apart from the
  token-advertisement probe itself). A stale `If-Match` PUT and an
  `If-None-Match: *` PUT against an existing Resource are rejected with 412
  `precondition-failed` without performing the write; the matching happy-path
  anchors succeed; and an under-authorized conditional PUT yields the
  privacy-merged `not-found` (404) mask, never 412. Optional/SHOULD tests assert
  `ETag` on Resource GET and HEAD, changing when content changes.
- New `blinded-index-api` suite: the `blinded-index` query profile (skipped
  unless the default backend advertises `blinded-index-query`). Covers `equals`
  and `has` matching with ascending-id ordering, the `count:true` shape,
  `hasMore`/`cursor` pairing, 400 `invalid-request-body` for a query with
  neither/both of `equals`/`has` or a missing `index`, 400 `invalid-cursor` for
  a garbage continuation token, 409 `id-conflict` for a write claiming an
  already-held `unique` blinded triple, and the 404 mask when an
  under-authorized caller probes a held triple.
- `spaces-api` suite: remaining Create/Update Space MUST branches. A body `id`
  that is not URL-safe is rejected with 400 `invalid-id`; a `controller` that is
  not a DID is rejected with 400 `invalid-request-body`; a delegated Create
  Space (invoked by a delegate whose capability chain is rooted in the body
  controller) succeeds with 201; a conflicting `POST` leaves the existing Space
  untouched; a body-supplied `createdBy` is ignored; a PUT-create not authorized
  by the body controller is rejected with 400 `controller-mismatch` and creates
  nothing; error bodies carry both a non-empty `type` and `title`; and the
  reserved `policy` segment is served as the policy endpoint, not as a
  Collection.
- `collection-api` suite: creating a Collection whose `backend.id` names an
  unregistered backend is rejected with 409 `unsupported-backend`; and a single
  delegated list capability authorizes an entire paginated traversal (following
  `next` across pages without re-delegation).
- `resource-api` suite: multipart uploads with zero or two file parts are
  rejected with 400 `invalid-request-body`; a GET with an unsatisfiable `Accept`
  still returns the stored representation (never 406); and a `PUT .../meta`
  carrying top-level server-managed properties alongside `custom` leaves
  `contentType`/`size` unchanged.
- `changes-query-api` suite: a `changes` query with a malformed `checkpoint` is
  rejected with 400 `invalid-request-body`.
- `encryption-marker-api` suite: a structurally valid envelope written under the
  wrong `Content-Type` into an encryption-marked Collection is rejected with 422
  `encryption-scheme-mismatch`.
- `specRefs` populated on every test in the registry, so spec-vs-suite coverage
  audits are mechanical.
- New `invocation-target-api` suite: capability `invocationTarget` binding
  negatives. Delegates a Resource-scoped capability and invokes it -- via the
  low-level `signCapabilityInvocation` primitive, since a well-behaved client
  refuses to build such a request -- against URLs the capability does not name:
  a sibling Resource (read and delete, asserting the delete is not performed),
  the parent Collection listing, and a Resource in another Space under the same
  controller. Each invocation must be rejected as either a verification failure
  (400 `invalid-authorization-header`) or the privacy-merged `not-found` (404)
  mask, without disclosing the target's content.
- `encryption-marker-api` suite: marker-immutability negatives. Changing the
  `scheme` of an existing `encryption` marker must be rejected -- with 409
  `encryption-immutable`, or with 400 `unsupported-encryption-scheme` on a
  server whose fail-closed registry gate reports the (necessarily unrecognized)
  probe scheme first -- and the stored marker must survive intact. An update
  sent without `encryption` must not clear an existing marker: it is either
  rejected with 409 `encryption-immutable` or accepted with the marker
  preserved. The pre-existing unrecognized-scheme test now probes a fresh
  Collection, so the fail-closed 400 is asserted unambiguously on a first
  declaration rather than overlapping the set-once check.
- `spaces-api` suite: direct Create/Update Space controller negatives. A
  `POST /spaces/` without a `controller` in the body is rejected with 400
  `invalid-request-body` (asserted on both the onboarding-token and signed-zcap
  provisioning paths); a `POST /spaces/` signed by a key that is not the body's
  `controller` is rejected with 400 `controller-mismatch` and the Space is not
  created (skipped when an onboarding token is configured, since the token then
  vouches for provisioning); and a PUT that swaps `controller` on an existing
  Space, signed by the would-be new controller, is verified against the _stored_
  controller -- it yields the privacy-merged `not-found` (404) mask and does not
  transfer the Space.
- New `write-validation-api` suite: write-validation negatives. Creating a
  Collection with a reserved path-segment id -- via either create wire shape
  (POST with a body `id`, or PUT with the id in the path) -- and creating a
  Resource with a reserved id are rejected with 409 `reserved-id`; a Resource
  write carrying no `Content-Type` header is rejected with 400
  `missing-content-type`.
- New `digest-api` suite: request-body integrity (Digest) negatives. Uses the
  low-level `signCapabilityInvocation` primitive to send requests a well-behaved
  client never produces: a signed body request whose signature does not cover
  the `digest` header (MUST reject with 400 `invalid-authorization-header`), and
  -- as an optional/SHOULD test -- a request whose body was swapped after
  signing, which must be rejected and not performed.
- New `authz-ordering-api` suite: authorization-ordering / no-leak negatives.
  Every test invokes as an under-authorized (cross-user) caller and asserts the
  privacy-merged `not-found` (404) mask instead of the later-stage error a
  server would leak by checking in the wrong order: id-conflict detection (409,
  Collection and Resource create), encrypted-Collection envelope validation
  (422), List-Collection cursor and query-body validation (400/501), Space and
  Collection quota reads (403/501), and Resource DELETE (which must also not be
  performed).

## 0.2.0 - 2026-07-22

### Changed

- **BREAKING**: `@interop/was-client` is now a peerDependency
  (`>=0.18.0 <1.0.0`) instead of a regular dependency, so a host repo that also
  depends on `was-client` gets a single shared copy instead of a nested
  duplicate pinned to this suite's range. Setups with peer auto-install disabled
  must add `@interop/was-client` themselves.

## 0.1.2 - 2026-07-21

### Fixed

- Add `equality-query` to the expected default-backend `features` list in the
  optional backend read/list tests, matching what conforming servers now
  advertise.

## 0.1.0-0.1.1 - 2026-07-19

### Added

- Conformance test suite for Wallet Attached Storage (WAS) servers: black-box
  HTTP tests covering spaces, collections, resources, access-control policies,
  collection change queries, encryption markers, ZCap delegation, space
  export/import, and BYOS backend registration. Tests that reflect
  reference-server behavior rather than clear spec mandates are tagged optional
  and reported as warnings by default.
- Programmatic API: `runConformance({ serverUrl, onboardingToken, onEvent })`
  runs the suite (or a subset) against a server and returns a structured
  `RunReport`; the `suites` registry, runner, and result types are exported for
  embedding in other test harnesses. Isomorphic -- runs in Node and, via a
  bundler, in the browser.
- `was-conformance` command-line runner: point it at a server URL (or
  `TEST_SERVER_URL`), with options for an onboarding token, suite and test-name
  filters, optional-test handling (`--include-optional` / `--skip-optional`), a
  per-test timeout, and `--fail-fast`. Ships `pretty` (default, colorized, live)
  and `json` (CI) reporters, a preflight connectivity check, and CI exit codes
  (0 pass, 1 conformance failures, 2 usage or unreachable server).
- Browser web app (`web/`, deployed to GitHub Pages): paste a server URL and
  optional onboarding token, pick suites and optional-test handling, and watch
  the suite run live -- per-suite progress, expandable failure details with
  expected/actual diffs and spec links, a final conformance verdict, and
  copy/download of the same JSON report the CLI emits. Runs entirely client-side
  (the token never leaves the browser), with a preflight check that
  distinguishes network/CORS unreachability from test failures.
