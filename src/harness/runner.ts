/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import assert from './assert.js'
import type {
  ConformanceContext,
  RunCounts,
  RunEvent,
  RunReport,
  Suite,
  SuiteResult,
  TestCase,
  TestError,
  TestResult
} from './types.js'

/** Generous default: remote servers over a WAN can be slow. */
export const DEFAULT_TEST_TIMEOUT_MS = 60_000

/** Thrown by `ctx.skip()`; the runner records a skip result. */
class SkipSignal extends Error {
  constructor(public reason?: string) {
    super(reason ?? 'skipped')
    this.name = 'SkipSignal'
  }
}

class TimeoutSignal extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`)
    this.name = 'TimeoutSignal'
  }
}

async function withTimeout(fn: () => Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutSignal(ms)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function toTestError(err: unknown): TestError {
  if (err instanceof assert.AssertionError) {
    return {
      message: err.message,
      expected: err.expected,
      actual: err.actual,
      operator: err.operator,
      stack: err.stack
    }
  }
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack }
  }
  return { message: String(err) }
}

function emptyCounts(): RunCounts {
  return { total: 0, pass: 0, fail: 0, skip: 0, optionalFail: 0 }
}

function tally(counts: RunCounts, result: TestResult): void {
  counts.total++
  counts[result.status]++
  if (result.status === 'fail' && result.optional) {
    counts.optionalFail++
  }
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now()
}

/**
 * Runs the given suites sequentially against a prepared context, emitting
 * progress events along the way. Never throws for test failures -- those are
 * captured in the returned report.
 *
 * @param options {object}
 * @param options.suites {Suite[]} suites to run, in order
 * @param options.ctx {ConformanceContext} context from `createContext()`
 * @param [options.onEvent] {Function} progress-event callback
 * @param [options.testTimeoutMs] {number} per-test (and per-hook) timeout
 * @param [options.failFast] {boolean} stop after the first non-optional
 *   failure; remaining tests are reported as skipped
 * @returns {Promise<RunReport>}
 */
export async function runSuites({
  suites,
  ctx,
  onEvent,
  testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS,
  failFast = false
}: {
  suites: Array<Suite<any>>
  ctx: ConformanceContext
  onEvent?: (event: RunEvent) => void
  testTimeoutMs?: number
  failFast?: boolean
}): Promise<RunReport> {
  const emit = (event: RunEvent): void => {
    onEvent?.(event)
  }
  const runStart = now()
  const startedAt = new Date().toISOString()
  emit({
    type: 'run-start',
    serverUrl: ctx.serverUrl,
    suiteCount: suites.length,
    testCount: suites.reduce((sum, s) => sum + s.tests.length, 0)
  })

  const suiteResults: SuiteResult[] = []
  const runCounts = emptyCounts()
  // Set once a non-optional test fails under failFast; every test after that
  // is reported as skipped instead of run.
  let aborted = false

  for (const suite of suites) {
    const suiteStart = now()
    const suiteCounts = emptyCounts()
    const results: TestResult[] = []
    emit({
      type: 'suite-start',
      suiteId: suite.id,
      name: suite.name,
      optional: suite.optional ?? false,
      testCount: suite.tests.length
    })

    let state: any
    let setupError: TestError | undefined
    if (!aborted && suite.setup) {
      try {
        await withTimeout(async () => {
          state = await suite.setup!(ctx)
        }, testTimeoutMs)
      } catch (err) {
        setupError = toTestError(err)
        setupError.message = `suite setup failed: ${setupError.message}`
      }
    }

    // Group setup hooks run lazily, before the first test of their group;
    // a failed group setup fails that group's tests.
    const groupErrors = new Map<string, TestError>()
    const enteredGroups = new Set<string>()

    const runTest = async (test: TestCase): Promise<TestResult> => {
      const optional = (suite.optional ?? false) || (test.optional ?? false)
      const base = {
        suiteId: suite.id,
        testId: test.id,
        name: test.name,
        ...(test.group !== undefined && { group: test.group }),
        optional,
        ...(test.specRefs !== undefined && { specRefs: test.specRefs })
      }
      if (aborted) {
        return {
          ...base,
          status: 'skip',
          durationMs: 0,
          skipReason: 'skipped (fail-fast)'
        }
      }
      if (setupError) {
        return { ...base, status: 'fail', durationMs: 0, error: setupError }
      }
      if (test.group !== undefined && !enteredGroups.has(test.group)) {
        enteredGroups.add(test.group)
        const group = suite.groups?.find(g => g.name === test.group)
        if (group) {
          try {
            await withTimeout(() => group.setup(ctx, state), testTimeoutMs)
          } catch (err) {
            const error = toTestError(err)
            error.message = `group setup failed: ${error.message}`
            groupErrors.set(test.group, error)
          }
        }
      }
      const groupError =
        test.group !== undefined ? groupErrors.get(test.group) : undefined
      if (groupError) {
        return { ...base, status: 'fail', durationMs: 0, error: groupError }
      }

      const testCtx = {
        ...ctx,
        skip: (reason?: string): never => {
          throw new SkipSignal(reason)
        }
      }
      const testStart = now()
      try {
        await withTimeout(() => test.run(testCtx, state), testTimeoutMs)
        return { ...base, status: 'pass', durationMs: now() - testStart }
      } catch (err) {
        if (err instanceof SkipSignal) {
          return {
            ...base,
            status: 'skip',
            durationMs: now() - testStart,
            ...(err.reason !== undefined && { skipReason: err.reason })
          }
        }
        return {
          ...base,
          status: 'fail',
          durationMs: now() - testStart,
          error: toTestError(err)
        }
      }
    }

    for (const test of suite.tests) {
      emit({
        type: 'test-start',
        suiteId: suite.id,
        testId: test.id,
        name: test.name,
        ...(test.group !== undefined && { group: test.group }),
        optional: (suite.optional ?? false) || (test.optional ?? false)
      })
      const result = await runTest(test)
      tally(suiteCounts, result)
      tally(runCounts, result)
      results.push(result)
      emit({ type: 'test-end', result })
      if (failFast && result.status === 'fail' && !result.optional) {
        aborted = true
      }
    }

    let teardownError: string | undefined
    if (!setupError && suite.teardown) {
      try {
        await withTimeout(() => suite.teardown!(ctx, state), testTimeoutMs)
      } catch (err) {
        teardownError = toTestError(err).message
      }
    }

    const suiteResult: SuiteResult = {
      suiteId: suite.id,
      name: suite.name,
      optional: suite.optional ?? false,
      durationMs: now() - suiteStart,
      counts: suiteCounts,
      results,
      ...(teardownError !== undefined && { teardownError })
    }
    suiteResults.push(suiteResult)
    emit({ type: 'suite-end', result: suiteResult })
  }

  const report: RunReport = {
    serverUrl: ctx.serverUrl,
    startedAt,
    durationMs: now() - runStart,
    counts: runCounts,
    conformant: runCounts.fail === runCounts.optionalFail,
    suites: suiteResults
  }
  emit({ type: 'run-end', report })
  return report
}
