import { strictEqual } from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

const version = process.argv[2] || 'dev'
if (!/^(dev|v\d+\.\d+\.\d+)$/.test(version))
  throw new Error('Expected a release tag or dev')
const archiveName = `lvce-remote-ssh-server-${version}${process.arch === 'arm64' ? '-linux-arm64' : ''}.tar.gz`
const manifest = JSON.parse(
  await readFile(`lvce-remote-ssh-server-manifest-${version}.json`, 'utf8'),
)
const checksum = createHash('sha256')
  .update(await readFile(archiveName))
  .digest('hex')
const serverChecksums: string[] = []
for (const [platform, entry] of Object.entries(manifest.platforms) as [
  string,
  { node: { name: string }; server: { name: string; sha256: string } },
][]) {
  const content = await readFile(entry.server.name)
  strictEqual(
    createHash('sha256').update(content).digest('hex'),
    entry.server.sha256,
  )
  strictEqual(
    entry.node.name,
    `node-${manifest.nodeVersion}-${platform}.tar.gz`,
  )
  serverChecksums.push(entry.server.sha256)
}
strictEqual(serverChecksums.includes(checksum), true)

const directory = await mkdtemp(path.join(tmpdir(), 'lvce-release-verify-'))
try {
  const archive = path.join(directory, 'extension.tar')
  await writeFile(
    archive,
    brotliDecompressSync(await readFile('extension.tar.br')),
  )
  const entries = ['dist/remoteSshClient.js', 'dist/remoteSshProcess.js']
  await promisify(execFile)('tar', [
    '-xf',
    archive,
    '-C',
    directory,
    ...entries,
  ])
  for (const entry of entries) {
    const content = await readFile(path.join(directory, entry), 'utf8')
    for (const serverChecksum of serverChecksums)
      strictEqual(
        content.includes(serverChecksum),
        true,
        `${entry} does not contain the published server archive checksum`,
      )
  }
} finally {
  await rm(directory, { force: true, recursive: true })
}
console.log(
  `Verified matching server, manifest, and SSH archives for ${version}`,
)
