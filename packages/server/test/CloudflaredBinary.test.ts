import { rejects } from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { cloudflaredVersion, getCloudflared } from '../src/CloudflaredBinary.ts'
void test(
  'a modified cached cloudflared binary cannot be executed',
  { skip: process.platform !== 'linux' || process.arch !== 'x64' },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lvce-cloudflared-'))
    try {
      const directory = path.join(root, 'cloudflared', cloudflaredVersion)
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
