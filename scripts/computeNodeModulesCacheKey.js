import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const root = join(currentDirectory, '..')
const locations = [
  'package.json',
  'package-lock.json',
  '.github/workflows/ci.yml',
  '.github/workflows/pr.yml',
  '.github/workflows/release.yml',
  'scripts/computeNodeModulesCacheKey.js',
]

const contents = await Promise.all(
  locations.map((location) => readFile(join(root, location), 'utf8')),
)
const hash = createHash('sha1')
for (const content of contents) {
  hash.update(content)
}
process.stdout.write(hash.digest('hex'))
