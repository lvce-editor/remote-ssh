import { strictEqual } from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import {
  compareVersions,
  discoveryScript,
  isCompatible,
} from '../src/parts/ServerCompatibility/ServerCompatibility.ts'

void test('bounds background compatibility by server, coordinated backend and known version syntax', () => {
  const current = 'v0.24.0-editor-0.125.17'
  strictEqual(isCompatible('v0.23.0-editor-0.125.16', current), true)
  strictEqual(isCompatible('v0.23.0-editor-0.125.17', current), true)
  for (const value of [
    'v0.22.0-editor-0.125.16',
    'v0.23.0-editor-0.125.15',
    'v0.25.0-editor-0.125.16',
    'v0.23.0-editor-0.125.18',
    'dev',
    'v0.23.0',
    'v0.23.0-editor-0.125.16-beta.1',
    'v00.23.0-editor-0.125.16',
  ]) {
    strictEqual(isCompatible(value, current), false, value)
  }
  strictEqual(compareVersions('0.23.10', '0.23.9'), 1)
})

void test('discovery requires matching installation and backend metadata and selects the newest compatible installation', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "lvce-discovery '"))
  context.after(() => rm(root, { force: true, recursive: true }))
  for (const [version, backend] of [
    ['v0.23.0-editor-0.125.16', '0.125.16'],
    ['v0.23.1-editor-0.125.16', '0.125.16'],
    ['v0.23.2-editor-0.125.16', '0.124.0'],
    ['v0.22.0-editor-0.125.16', '0.125.16'],
  ]) {
    const directory = path.join(root, 'servers', version)
    const backendDirectory = path.join(
      directory,
      'lvce-server/node_modules/@lvce-editor/server',
    )
    await mkdir(backendDirectory, { recursive: true })
    await writeFile(path.join(directory, 'lvce-remote-ssh-server.mjs'), '')
    await writeFile(
      path.join(directory, 'remote-ssh-installation.json'),
      JSON.stringify({ serverVersion: version }),
    )
    await writeFile(
      path.join(backendDirectory, 'package.json'),
      JSON.stringify({ version: backend }),
    )
  }
  const { stdout } = await promisify(execFile)(process.execPath, [
    '-e',
    discoveryScript,
    root,
    'v0.24.0-editor-0.125.17',
  ])
  strictEqual(stdout, 'v0.23.1-editor-0.125.16')
})
