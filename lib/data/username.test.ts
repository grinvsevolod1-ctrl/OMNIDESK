import { describe, expect, it } from 'vitest'
import { sanitizeUsername, usernameFromEmail } from './managers'

describe('sanitizeUsername', () => {
  it('lowercases and strips invalid characters', () => {
    expect(sanitizeUsername('Admin')).toBe('admin')
    expect(sanitizeUsername('  John Doe ')).toBe('johndoe')
    expect(sanitizeUsername('a.b_c-d')).toBe('a.b_c-d')
    expect(sanitizeUsername('Ivan Петров!')).toBe('ivan')
  })

  it('returns empty string when nothing valid remains', () => {
    expect(sanitizeUsername('Пётр')).toBe('')
    expect(sanitizeUsername('   ')).toBe('')
  })
})

describe('usernameFromEmail', () => {
  it('derives the login from the email local-part', () => {
    expect(usernameFromEmail('admin@site.com')).toBe('admin')
    expect(usernameFromEmail('Ivan.Petrov@company.io')).toBe('ivan.petrov')
    expect(usernameFromEmail('john+tag@x.com')).toBe('johntag')
  })
})
