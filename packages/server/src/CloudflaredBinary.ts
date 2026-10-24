import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Official cloudflare/cloudflared 2026.10.3 linux-amd64 release asset digest.
export const cloudflaredVersion = '2026.10.3'
export const cloudflaredSha256 =
  '053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0'
const digest = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')
export const getCloudflared = async (
  root: string,
  signal: AbortSignal,
): Promise<string> => {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error(
      'Automatic Cloudflare setup supports Linux x64 remote machines',
    )
  const directory = path.join(root, 'cloudflared', cloudflaredVersion)
  const destination = path.join(directory, 'cloudflared')
  try {
    if (digest(await readFile(destination)) !== cloudflaredSha256)
      throw new Error(
        'Cached cloudflared checksum mismatch; remove the cached binary and retry',
      )
    return destination
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const response = await fetch(
    `https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredVersion}/cloudflared-linux-amd64`,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) },
  )
  if (!response.ok || !response.body)
    throw new Error('Could not download the verified cloudflared binary')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 100 * 1024 * 1024)
      throw new Error('cloudflared download exceeds the size limit')
    chunks.push(chunk)
  }
  const data = Buffer.concat(chunks)
  if (digest(data) !== cloudflaredSha256)
    throw new Error('Downloaded cloudflared checksum mismatch')
  const temporary = `${destination}.${process.pid}.tmp`
  try {
    await writeFile(temporary, data, { mode: 0o700, flag: 'wx' })
    await chmod(temporary, 0o700)
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
  return destination
}
