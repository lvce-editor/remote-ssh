import { strictEqual, throws } from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  manifest,
  readFrontendVersion,
  selectFrontendVersion,
} from '../src/parts/ServerManifest/ServerManifest.ts'

void test('selects the packaged About version while preserving verified bootstrap archives', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lvce-frontend-version-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  const entry = path.join(
    root,
    'static',
    'commit',
    'extensions',
    'builtin.remote-ssh',
    'dist',
    'remoteSshProcess.js',
  )
  await mkdir(path.dirname(entry), { recursive: true })
  const url = pathToFileURL(entry).href
  strictEqual(readFrontendVersion(url), undefined)
  await writeFile(
    path.join(root, 'config.json'),
    JSON.stringify({ version: '0.120.10' }),
  )
  const selected = selectFrontendVersion(manifest, readFrontendVersion(url))
  strictEqual(selected.editorVersion, '0.120.10')
  strictEqual(
    selected.serverVersion,
    `${manifest.serverVersion}-editor-0.120.10`,
  )
  strictEqual(selected.serverArchiveUrl, manifest.serverArchiveUrl)
  strictEqual(selected.serverArchiveSha256, manifest.serverArchiveSha256)
  strictEqual(selectFrontendVersion(manifest, undefined), manifest)
  await writeFile(
    path.join(root, 'config.json'),
    JSON.stringify({ version: 'v0.120.11' }),
  )
  strictEqual(readFrontendVersion(url), '0.120.11')
  await writeFile(
    path.join(root, 'config.json'),
    JSON.stringify({ version: 'dev' }),
  )
  strictEqual(readFrontendVersion(url), undefined)
  await writeFile(
    path.join(root, 'config.json'),
    JSON.stringify({ version: '0.120.10; touch /tmp/injected' }),
  )
  throws(() => readFrontendVersion(url), /Unsupported frontend editor version/)
  await writeFile(path.join(root, 'config.json'), '{broken')
  throws(() => readFrontendVersion(url), SyntaxError)
})
