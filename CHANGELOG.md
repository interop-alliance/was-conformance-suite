# @interop/was-conformance-suite Changelog

## Unreleased - TBD

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
