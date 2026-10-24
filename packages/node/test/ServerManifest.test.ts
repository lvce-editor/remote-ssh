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
  selectRemotePlatform,
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

void test('selects the remote architecture independently of the local client architecture', () => {
  const supported = {
    ...manifest,
    serverArm64: {
      name: 'server-linux-arm64.tar.gz',
      sha256: 'arm64-server-checksum',
      url: 'https://example.com/server-linux-arm64.tar.gz',
    },
  }
  const x64 = selectRemotePlatform(manifest, 'Linux:x86_64')
  strictEqual(x64.nodeArchitecture, 'x64')
  strictEqual(x64.nodeArchiveName, 'node-v24.15.0-linux-x64.tar.gz')
  for (const platform of ['Linux:aarch64', 'Linux:arm64']) {
    const arm64 = selectRemotePlatform(supported, platform)
    strictEqual(arm64.nodeArchitecture, 'arm64')
    strictEqual(arm64.nodeArchiveName, 'node-v24.15.0-linux-arm64.tar.gz')
    strictEqual(
      arm64.nodeArchiveSha256,
      '73afc234d558c24919875f51c2d1ea002a2ada4ea6f83601a383869fefa64eed',
    )
    strictEqual(arm64.serverArchiveSha256, 'arm64-server-checksum')
    strictEqual(arm64.serverArchiveName, 'server-linux-arm64.tar.gz')
  }
  throws(() => selectRemotePlatform(manifest, 'Linux:arm'), /supports Linux/)
  throws(() => selectRemotePlatform(manifest, 'Darwin:arm64'), /supports Linux/)
  throws(
    () =>
      selectRemotePlatform(
        { ...manifest, nodeArm64: undefined },
        'Linux:aarch64',
      ),
    /matching runtime/,
  )
})
