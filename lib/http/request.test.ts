import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readJson } from './request'

const schema = z.object({ name: z.string().min(1).max(10) }).strict()

function jsonRequest(body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/test', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('readJson', () => {
  it('parses a valid payload', async () => {
    await expect(readJson(jsonRequest('{"name":"desk"}'), schema, 100)).resolves.toEqual({ name: 'desk' })
  })

  it('rejects malformed JSON', async () => {
    await expect(readJson(jsonRequest('{'), schema, 100)).rejects.toMatchObject({ code: 'invalid_json', status: 400 })
  })

  it('rejects actual bodies over the limit', async () => {
    await expect(readJson(jsonRequest('{"name":"desk"}'), schema, 4)).rejects.toMatchObject({ code: 'payload_too_large', status: 413 })
  })

  it('rejects unknown fields', async () => {
    await expect(readJson(jsonRequest('{"name":"desk","admin":true}'), schema, 100)).rejects.toMatchObject({ code: 'validation_error', status: 422 })
  })
})
