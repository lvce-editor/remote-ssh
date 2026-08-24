import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { root } from './root.js'

const locations: string[] = [
  'package.json',
  'package-lock.json',
  '.github/workflows/ci.yml',
  '.github/workflows/pr.yml',
  '.github/workflows/release.yml',
  'packages/build/src/computeNodeModulesCacheKey.ts',
]

const getAbsolutePath = (relativePath: string): string => {
  return join(root, relativePath)
}

const getContent = (absolutePath: string): Promise<string> => {
  return readFile(absolutePath, 'utf8')
}

export const computeHash = (contents: string | string[]): string => {
  const hash = createHash('sha1')
  if (Array.isArray(contents)) {
    for (const content of contents) {
      hash.update(content)
    }
  } else if (typeof contents === 'string') {
    hash.update(contents)
  }
  return hash.digest('hex')
}

const computeCacheKey = async (locations: string[]): Promise<string> => {
  const absolutePaths = locations.map(getAbsolutePath)
  const contents = await Promise.all(absolutePaths.map(getContent))
  const hash = computeHash(contents)
  return hash
}

const main = async (): Promise<void> => {
  const hash = await computeCacheKey(locations)
  process.stdout.write(hash)
}

main()
