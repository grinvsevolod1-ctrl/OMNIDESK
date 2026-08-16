import { describe, expect, it } from 'vitest'
import { assertPublicHttpUrl, SsrfBlockedError } from './ssrf-guard'

describe('assertPublicHttpUrl', () => {
  it('allows a normal public https url', () => {
    const url = assertPublicHttpUrl('https://vk.com/cdn/photo.jpg?x=1')
    expect(url.hostname).toBe('vk.com')
  })

  it('allows a public http url', () => {
    expect(() => assertPublicHttpUrl('http://example.com/a')).not.toThrow()
  })

  it('rejects non-http(s) schemes', () => {
    expect(() => assertPublicHttpUrl('file:///etc/passwd')).toThrow(
      SsrfBlockedError,
    )
    expect(() => assertPublicHttpUrl('ftp://example.com/x')).toThrow(
      SsrfBlockedError,
    )
    expect(() => assertPublicHttpUrl('gopher://x')).toThrow(SsrfBlockedError)
  })

  it('rejects an invalid url', () => {
    expect(() => assertPublicHttpUrl('not a url')).toThrow(SsrfBlockedError)
  })

  it('rejects localhost and *.localhost', () => {
    expect(() => assertPublicHttpUrl('http://localhost/x')).toThrow(
      SsrfBlockedError,
    )
    expect(() => assertPublicHttpUrl('http://api.localhost/x')).toThrow(
      SsrfBlockedError,
    )
  })

  it('rejects loopback and private IPv4 literals', () => {
    for (const host of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(
        () => assertPublicHttpUrl(`http://${host}/x`),
        host,
      ).toThrow(SsrfBlockedError)
    }
  })

  it('allows public IPv4 literals just outside private ranges', () => {
    for (const host of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '100.128.0.1']) {
      expect(() => assertPublicHttpUrl(`http://${host}/x`), host).not.toThrow()
    }
  })

  it('rejects loopback / link-local / unique-local IPv6 literals', () => {
    for (const host of ['[::1]', '[fe80::1]', '[fc00::1]', '[fd12:3456::1]']) {
      expect(() => assertPublicHttpUrl(`http://${host}/x`), host).toThrow(
        SsrfBlockedError,
      )
    }
  })

  it('rejects IPv4-mapped IPv6 loopback', () => {
    expect(() => assertPublicHttpUrl('http://[::ffff:127.0.0.1]/x')).toThrow(
      SsrfBlockedError,
    )
  })
})
