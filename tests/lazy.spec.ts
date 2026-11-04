import { describe, expect, it, vi } from 'vitest'
import { createLazy } from '../src/lazy.ts'

describe('createLazy', () => {
  it('loads once and caches the value', () => {
    const load = vi.fn(() => 41 + 1)
    const lazy = createLazy(load, () => 'unused')
    expect(lazy.peek()).toBe(42)
    expect(lazy.peek()).toBe(42)
    expect(lazy.resolve()).toBe(42)
    expect(load).toHaveBeenCalledTimes(1)
    expect(lazy.failure).toBeUndefined()
  })

  it('never loads before first use', () => {
    const load = vi.fn(() => 'value')
    createLazy(load, () => 'unused')
    expect(load).not.toHaveBeenCalled()
  })

  it('caches the actionable failure and never retries', () => {
    const load = vi.fn(() => { throw new Error('Cannot find module native-package') })
    const lazy = createLazy(load, message => `engine unavailable: ${message}`)
    expect(lazy.peek()).toBeUndefined()
    expect(() => lazy.resolve()).toThrow('engine unavailable: Cannot find module native-package')
    expect(() => lazy.resolve()).toThrow('engine unavailable: Cannot find module native-package')
    expect(load).toHaveBeenCalledTimes(1)
    expect(lazy.failure?.message).toBe('engine unavailable: Cannot find module native-package')
  })
})
