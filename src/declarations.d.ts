/**
 * Types for the npm `assert` package (isomorphic port of `node:assert`),
 * which ships no type declarations of its own. The `src` program is
 * isomorphic and deliberately excludes `@types/node`, so the relevant
 * subset of the node:assert surface is declared here.
 */
declare module 'assert/build/assert.js' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- referenced via `typeof` in the Assert interface below
  class AssertionError extends Error {
    actual: unknown
    expected: unknown
    operator: string
    generatedMessage: boolean
    code: 'ERR_ASSERTION'
    constructor(options?: {
      message?: string
      actual?: unknown
      expected?: unknown
      operator?: string
    })
  }

  type AssertPredicate =
    | RegExp
    | (new () => object)
    | ((thrown: unknown) => boolean)
    | object
    | Error

  interface Assert {
    (value: unknown, message?: string | Error): asserts value
    ok(value: unknown, message?: string | Error): asserts value
    fail(message?: string | Error): never
    equal(actual: unknown, expected: unknown, message?: string | Error): void
    notEqual(actual: unknown, expected: unknown, message?: string | Error): void
    strictEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error
    ): void
    notStrictEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error
    ): void
    deepEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error
    ): void
    notDeepEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error
    ): void
    deepStrictEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error
    ): void
    notDeepStrictEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error
    ): void
    match(value: string, regExp: RegExp, message?: string | Error): void
    doesNotMatch(value: string, regExp: RegExp, message?: string | Error): void
    throws(
      block: () => unknown,
      error?: AssertPredicate,
      message?: string | Error
    ): void
    rejects(
      block: (() => Promise<unknown>) | Promise<unknown>,
      error?: AssertPredicate,
      message?: string | Error
    ): Promise<void>
    doesNotReject(
      block: (() => Promise<unknown>) | Promise<unknown>,
      error?: AssertPredicate,
      message?: string | Error
    ): Promise<void>
    ifError(value: unknown): void
    AssertionError: typeof AssertionError
  }

  const assert: Assert
  export = assert
}
