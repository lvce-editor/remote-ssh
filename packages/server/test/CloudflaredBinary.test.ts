import { rejects, strictEqual, throws } from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  cloudflaredVersion,
  getCloudflared,
  getCloudflaredRelease,
} from '../src/CloudflaredBinary.ts'
void test(
  'a modified cached cloudflared binary cannot be executed',
  {
    skip:
      process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch),
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lvce-cloudflared-'))
    try {
      const directory = path.join(
        root,
        'cloudflared',
        cloudflaredVersion,
        `${process.platform}-${process.arch}`,
      )
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, 'cloudflared'), 'modified binary')
      await rejects(
        getCloudflared(root, new AbortController().signal),
        /checksum mismatch/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

void test('selects a verified Linux asset for each supported architecture', () => {
  strictEqual(
    getCloudflaredRelease('linux', 'x64').name,
    'cloudflared-linux-amd64',
  )
  strictEqual(
    getCloudflaredRelease('linux', 'arm64').name,
    'cloudflared-linux-arm64',
  )
  strictEqual(
    getCloudflaredRelease('linux', 'arm64').sha256,
    '89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8',
  )
  throws(() => getCloudflaredRelease('linux', 'arm'), /supports Linux/)
  throws(() => getCloudflaredRelease('darwin', 'arm64'), /supports Linux/)
})
