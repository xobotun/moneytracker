import { describe, it, expect } from 'vitest'
import { gitBlobSha } from '../gitBlobSha'

// Expected values from `printf '<text>' | git hash-object --stdin`.
describe('gitBlobSha', () => {
  it('matches git hash-object for ASCII text', async () => {
    expect(await gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('matches git hash-object for an empty file', async () => {
    expect(await gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  })

  it('hashes the UTF-8 bytes, counting bytes rather than characters', async () => {
    expect(await gitBlobSha('Café ✈️\n')).toBe('e3dd1209fb30975da1605236d7aebe65227e6bca')
  })
})
