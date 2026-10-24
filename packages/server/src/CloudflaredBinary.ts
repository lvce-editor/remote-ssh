import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Official cloudflare/cloudflared 2026.10.3 release asset digests.
export const cloudflaredVersion = '2026.10.3'
export const getCloudflaredRelease = (
  platform: string,
  architecture: string,
): { readonly name: string; readonly sha256: string } => {
  if (platform === 'linux' && architecture === 'x64')
    return {
      name: 'cloudflared-linux-amd64',
      sha256:
        '053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0',
    }
  if (platform === 'linux' && architecture === 'arm64')
    return {
      name: 'cloudflared-linux-arm64',
      sha256:
        '89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8',
    }
  throw new Error(
    'Automatic Cloudflare setup supports Linux x64 and ARM64 remote machines',
  )
}
const digest = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')
export const getCloudflared = async (
  root: string,
  signal: AbortSignal,
): Promise<string> => {
  const release = getCloudflaredRelease(process.platform, process.arch)
  const directory = path.join(
    root,
    'cloudflared',
    cloudflaredVersion,
    `${process.platform}-${process.arch}`,
  )
  const destination = path.join(directory, 'cloudflared')
  try {
    if (digest(await readFile(destination)) !== release.sha256)
      throw new Error(
        'Cached cloudflared checksum mismatch; remove the cached binary and retry',
      )
    return destination
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const response = await fetch(
    `https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredVersion}/${release.name}`,
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
  if (digest(data) !== release.sha256)
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
