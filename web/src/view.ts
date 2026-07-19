/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Tiny dependency-free DOM helpers and the live result-row renderers for the
 * run screen. No framework: everything is plain `document.createElement`.
 */
import { formatMs } from './report.js'
import type { TestResult } from '../../src/index.js'

/**
 * Creates an element, applying a props bag (`class`, `text`, `html`,
 * `dataset`, `attrs`, and direct property assignments) and appending children.
 *
 * @param tag {string} the tag name
 * @param [props] {object} class/text/html/dataset/attrs and other properties
 * @param [children] {Array<Node|string>} child nodes or text
 * @returns {HTMLElement}
 */
export function el(
  tag: string,
  props: Record<string, any> = {},
  children: Array<Node | string> = []
): HTMLElement {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) {
      continue
    }
    if (key === 'class') {
      node.className = value
    } else if (key === 'text') {
      node.textContent = value
    } else if (key === 'html') {
      node.innerHTML = value
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value as Record<string, string>)) {
        node.dataset[dk] = dv
      }
    } else if (key === 'attrs') {
      for (const [ak, av] of Object.entries(value as Record<string, string>)) {
        node.setAttribute(ak, av)
      }
    } else {
      ;(node as any)[key] = value
    }
  }
  for (const child of children) {
    node.append(child)
  }
  return node
}

/** The status glyph for a row: pass/fail/warn/skip/running. */
function glyphFor(status: string, warn: boolean): string {
  if (status === 'pass') {
    return '✓'
  }
  if (status === 'skip') {
    return '-'
  }
  if (status === 'running') {
    return '·'
  }
  return warn ? '⚠' : '✗'
}

/**
 * Builds a placeholder row for a test that has started but not finished. It is
 * replaced in place by `testRow` on the matching `test-end` event.
 *
 * @param options {object}
 * @param options.name {string} the test name
 * @param [options.group] {string} the nested group label, if any
 * @returns {HTMLElement}
 */
export function runningRow({
  name,
  group
}: {
  name: string
  group?: string
}): HTMLElement {
  return el(
    'div',
    { class: 'test-row', dataset: { testid: 'test-row', status: 'running' } },
    [
      el('span', { class: 'glyph', text: glyphFor('running', false) }),
      el('span', { class: 'test-name', text: name }),
      group ? el('span', { class: 'test-group', text: group }) : ''
    ].filter(Boolean) as Array<Node | string>
  )
}

/**
 * Builds the finished row for a test result. A non-promoted optional failure
 * (`warn`) is styled as a warning rather than a hard failure; failing rows
 * carry an expanded `<details>` block with the error, expected/actual diff,
 * spec-ref links, and a collapsed stack.
 *
 * @param result {TestResult} the finished result
 * @param options {object}
 * @param options.warn {boolean} render a failure as an amber warning
 * @returns {HTMLElement}
 */
export function testRow(
  result: TestResult,
  { warn }: { warn: boolean }
): HTMLElement {
  const isWarn = result.status === 'fail' && warn
  const row = el('div', {
    class: 'test-row' + (isWarn ? ' test-row--warn' : ''),
    dataset: { testid: 'test-row', status: result.status }
  })
  row.append(
    el('span', { class: 'glyph', text: glyphFor(result.status, isWarn) }),
    el('span', { class: 'test-name', text: result.name })
  )
  if (result.group) {
    row.append(el('span', { class: 'test-group', text: result.group }))
  }
  if (result.status === 'skip' && result.skipReason) {
    row.append(
      el('span', { class: 'test-note', text: `(${result.skipReason})` })
    )
  }
  if (result.status !== 'skip') {
    row.append(
      el('span', { class: 'test-duration', text: formatMs(result.durationMs) })
    )
  }
  if (result.status === 'fail' && result.error) {
    row.append(failureDetails(result, isWarn))
  }
  return row
}

/** The expanded failure block: message, diff, spec links, and stack. */
function failureDetails(result: TestResult, warn: boolean): HTMLElement {
  const error = result.error!
  const details = el('details', {
    class: 'failure' + (warn ? ' failure--warn' : ''),
    open: true
  })
  details.append(
    el('summary', { text: warn ? 'warning detail' : 'failure detail' })
  )
  details.append(el('p', { class: 'failure-message', text: error.message }))

  if (error.expected !== undefined || error.actual !== undefined) {
    const diff = el('div', { class: 'diff' })
    diff.append(
      el('div', { class: 'diff-label', text: 'expected' }),
      el('pre', { class: 'diff-value', text: pretty(error.expected) }),
      el('div', { class: 'diff-label', text: 'actual' }),
      el('pre', { class: 'diff-value', text: pretty(error.actual) })
    )
    details.append(diff)
  }

  const specRefs = result.specRefs ?? []
  if (specRefs.length > 0) {
    const refs = el('div', { class: 'spec-refs' })
    for (const ref of specRefs) {
      refs.append(
        el('a', {
          class: 'spec-ref',
          text: ref,
          href: ref,
          target: '_blank',
          rel: 'noopener noreferrer'
        })
      )
    }
    details.append(refs)
  }

  if (error.stack) {
    const stack = el('details', { class: 'stack' })
    stack.append(
      el('summary', { text: 'stack' }),
      el('pre', { class: 'stack-value', text: error.stack })
    )
    details.append(stack)
  }
  return details
}

/** Pretty-prints a value as 2-space JSON, tolerating non-serializable input. */
function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
