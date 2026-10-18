/**
 * The SHA-1 git assigns to a file with this content (`git hash-object`): the
 * hash of `blob <byte length>\0` followed by the UTF-8 bytes. Lets the GitHub
 * backend recognise files the remote already holds without asking GitHub.
 */
export async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content)
  const header = new TextEncoder().encode(`blob ${body.length}\0`)
  const bytes = new Uint8Array(header.length + body.length)
  bytes.set(header)
  bytes.set(body, header.length)
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
