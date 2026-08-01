import { describe, expect, it } from 'vitest'
import {
  envToText,
  isValidDomain,
  isValidEnvKey,
  isValidHost,
  isValidIpv4,
  isValidPort,
  isValidRepoUrl,
  parseEnvText,
} from './validate'

describe('isValidIpv4', () => {
  it('accepts valid addresses', () => {
    expect(isValidIpv4('1.2.3.4')).toBe(true)
    expect(isValidIpv4('192.168.0.1')).toBe(true)
    expect(isValidIpv4('255.255.255.255')).toBe(true)
    expect(isValidIpv4('0.0.0.0')).toBe(true)
  })
  it('rejects invalid addresses', () => {
    expect(isValidIpv4('256.1.1.1')).toBe(false)
    expect(isValidIpv4('1.2.3')).toBe(false)
    expect(isValidIpv4('1.2.3.4.5')).toBe(false)
    expect(isValidIpv4('01.2.3.4')).toBe(false) // leading zero
    expect(isValidIpv4('a.b.c.d')).toBe(false)
    expect(isValidIpv4('')).toBe(false)
  })
})

describe('isValidHost', () => {
  it('accepts IPs and hostnames', () => {
    expect(isValidHost('1.2.3.4')).toBe(true)
    expect(isValidHost('example.com')).toBe(true)
    expect(isValidHost('sub.domain.example.com')).toBe(true)
    expect(isValidHost('my-server')).toBe(true)
  })
  it('rejects malformed hosts', () => {
    expect(isValidHost('')).toBe(false)
    expect(isValidHost('-bad.example.com')).toBe(false)
    expect(isValidHost('bad-.example.com')).toBe(false)
    expect(isValidHost('a'.repeat(300))).toBe(false)
  })
})

describe('isValidPort', () => {
  it('accepts 1–65535', () => {
    expect(isValidPort(1)).toBe(true)
    expect(isValidPort(22)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
  })
  it('rejects out-of-range and non-integers', () => {
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(-5)).toBe(false)
    expect(isValidPort(22.5)).toBe(false)
    expect(isValidPort(Number.NaN)).toBe(false)
  })
})

describe('isValidRepoUrl', () => {
  it('accepts https and scp-style git URLs', () => {
    expect(isValidRepoUrl('https://github.com/user/repo.git')).toBe(true)
    expect(isValidRepoUrl('https://gitlab.com/group/sub/repo')).toBe(true)
    expect(isValidRepoUrl('git@github.com:user/repo.git')).toBe(true)
  })
  it('rejects dangerous or malformed URLs', () => {
    expect(isValidRepoUrl('')).toBe(false)
    expect(isValidRepoUrl('file:///etc/passwd')).toBe(false)
    expect(isValidRepoUrl('not a url')).toBe(false)
    expect(isValidRepoUrl('ftp://example.com/repo')).toBe(false)
  })
})

describe('isValidDomain', () => {
  it('accepts real domains', () => {
    expect(isValidDomain('example.com')).toBe(true)
    expect(isValidDomain('app.example.com')).toBe(true)
  })
  it('rejects bare labels and schemes', () => {
    expect(isValidDomain('localhost')).toBe(false)
    expect(isValidDomain('http://example.com')).toBe(false)
    expect(isValidDomain('')).toBe(false)
  })
})

describe('isValidEnvKey', () => {
  it('accepts POSIX-style names', () => {
    expect(isValidEnvKey('DATABASE_URL')).toBe(true)
    expect(isValidEnvKey('_private')).toBe(true)
    expect(isValidEnvKey('PORT2')).toBe(true)
  })
  it('rejects invalid names', () => {
    expect(isValidEnvKey('2PORT')).toBe(false)
    expect(isValidEnvKey('MY-KEY')).toBe(false)
    expect(isValidEnvKey('has space')).toBe(false)
    expect(isValidEnvKey('')).toBe(false)
  })
})

describe('parseEnvText', () => {
  it('parses KEY=VALUE lines, ignoring blanks and comments', () => {
    const res = parseEnvText('# comment\nA=1\n\nB=hello world\n')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.env).toEqual({ A: '1', B: 'hello world' })
  })
  it('strips a single pair of surrounding quotes', () => {
    const res = parseEnvText('A="quoted"\nB=\'single\'')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.env).toEqual({ A: 'quoted', B: 'single' })
  })
  it('keeps = signs inside values', () => {
    const res = parseEnvText('URL=postgres://u:p@h/db?x=1')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.env.URL).toBe('postgres://u:p@h/db?x=1')
  })
  it('rejects lines without =', () => {
    const res = parseEnvText('JUSTAKEY')
    expect(res.ok).toBe(false)
  })
  it('rejects invalid keys', () => {
    const res = parseEnvText('BAD-KEY=1')
    expect(res.ok).toBe(false)
  })
  it('rejects duplicate keys', () => {
    const res = parseEnvText('A=1\nA=2')
    expect(res.ok).toBe(false)
  })
})

describe('envToText round-trip', () => {
  it('serializes then parses back to the same map', () => {
    const env = { A: '1', B: 'two', C: 'https://x/y?z=1' }
    const text = envToText(env)
    const res = parseEnvText(text)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.env).toEqual(env)
  })
})
