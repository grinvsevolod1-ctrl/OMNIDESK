import { afterEach, describe, expect, it } from 'vitest'
import { clientIpFromHeaders, isValidIp } from './client-ip'

const ORIGINAL_TRUST_PROXY = process.env.TRUST_PROXY

afterEach(() => {
  if (ORIGINAL_TRUST_PROXY === undefined) delete process.env.TRUST_PROXY
  else process.env.TRUST_PROXY = ORIGINAL_TRUST_PROXY
})

function h(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

describe('isValidIp', () => {
  it('accepts valid IPv4', () => {
    expect(isValidIp('1.2.3.4')).toBe(true)
    expect(isValidIp('255.255.255.255')).toBe(true)
  })
  it('rejects out-of-range IPv4 octets', () => {
    expect(isValidIp('256.1.1.1')).toBe(false)
    expect(isValidIp('999.999.999.999')).toBe(false)
  })
  it('accepts valid IPv6 including mapped IPv4', () => {
    expect(isValidIp('::1')).toBe(true)
    expect(isValidIp('2001:db8::8a2e:370:7334')).toBe(true)
    expect(isValidIp('::ffff:192.168.0.1')).toBe(true)
  })
  it('rejects junk', () => {
    expect(isValidIp('')).toBe(false)
    expect(isValidIp('<script>alert(1)</script>')).toBe(false)
    expect(isValidIp('evil')).toBe(false)
    expect(isValidIp('a'.repeat(100))).toBe(false)
  })
})

describe('clientIpFromHeaders', () => {
  it('returns unknown when TRUST_PROXY=false regardless of headers', () => {
    process.env.TRUST_PROXY = 'false'
    expect(clientIpFromHeaders(h({ 'x-real-ip': '1.2.3.4' }))).toBe('unknown')
  })

  it('prefers cf-connecting-ip, then x-real-ip', () => {
    expect(
      clientIpFromHeaders(
        h({ 'cf-connecting-ip': '9.9.9.9', 'x-real-ip': '1.2.3.4' }),
      ),
    ).toBe('9.9.9.9')
    expect(clientIpFromHeaders(h({ 'x-real-ip': '1.2.3.4' }))).toBe('1.2.3.4')
  })

  it('takes the RIGHTMOST valid x-forwarded-for hop', () => {
    expect(
      clientIpFromHeaders(h({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7' })),
    ).toBe('7.7.7.7')
  })

  it('skips invalid hops and empty entries', () => {
    expect(
      clientIpFromHeaders(h({ 'x-forwarded-for': '5.5.5.5, garbage' })),
    ).toBe('5.5.5.5')
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': ',,,' }))).toBe('unknown')
  })

  it('rejects spoofed junk in x-real-ip and falls through', () => {
    expect(
      clientIpFromHeaders(
        h({ 'x-real-ip': 'not-an-ip', 'x-forwarded-for': '2.2.2.2' }),
      ),
    ).toBe('2.2.2.2')
  })

  it('strips a port from IPv4 and brackets from IPv6', () => {
    expect(clientIpFromHeaders(h({ 'x-real-ip': '1.2.3.4:5678' }))).toBe(
      '1.2.3.4',
    )
    expect(clientIpFromHeaders(h({ 'x-real-ip': '[::1]:443' }))).toBe('::1')
  })

  it('returns unknown with no headers', () => {
    expect(clientIpFromHeaders(h({}))).toBe('unknown')
  })
})
