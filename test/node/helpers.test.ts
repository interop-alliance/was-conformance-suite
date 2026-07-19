/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect } from 'vitest'
import { withoutCreatedBy } from '../../src/helpers.js'

describe('withoutCreatedBy', () => {
  it('strips a present createdBy property, keeping the rest', () => {
    const input = { id: 'space-1', name: 'Test', createdBy: 'did:key:z6Mk' }
    const result = withoutCreatedBy(input)
    expect(result).toEqual({ id: 'space-1', name: 'Test' })
    expect(result).not.toHaveProperty('createdBy')
  })

  it('does not mutate the original object', () => {
    const input = { id: 'space-1', createdBy: 'did:key:z6Mk' }
    withoutCreatedBy(input)
    expect(input).toHaveProperty('createdBy', 'did:key:z6Mk')
  })

  it('returns an object without createdBy unchanged (same reference)', () => {
    const input = { id: 'space-1', name: 'Test' }
    expect(withoutCreatedBy(input)).toBe(input)
  })

  it('returns non-object values unchanged', () => {
    expect(withoutCreatedBy(null)).toBe(null)
    expect(withoutCreatedBy(undefined)).toBe(undefined)
    expect(withoutCreatedBy('hello')).toBe('hello')
    expect(withoutCreatedBy(42)).toBe(42)
  })
})
