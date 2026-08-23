import {
  deepStrictEqual,
  match,
  rejects,
  strictEqual,
} from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  _getSocketPath,
  close,
  listen,
  prepare,
  requestOpen,
  resolveOpenRequest,
} from '../src/parts/RemoteCli/RemoteCli.ts'

const isWindows = process.platform === 'win32'

void test('resolves relative folders and files from the terminal cwd', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lvce-remote-cli-path-'))
  context.after(() => rm(root, { force: true, recursive: true }))
  const filePath = path.join(root, 'file.txt')
  await writeFile(filePath, 'content')

  deepStrictEqual(await resolveOpenRequest([], root), {
    kind: 'folder',
    path: root,
    type: 'open',
  })
  deepStrictEqual(await resolveOpenRequest(['file.txt'], root), {
    kind: 'file',
    path: filePath,
    type: 'open',
  })
})

void test('rejects unsupported options and multiple paths', async () => {
  await rejects(resolveOpenRequest(['--reuse-window']), /Unsupported/)
  await rejects(resolveOpenRequest(['/home', '/tmp']), /one path/)
})

void test(
  'relays validated requests to the connected editor',
  { skip: isWindows },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lvce-remote-cli-server-'))
    const requests: unknown[] = []
    const server = await listen(root, 'test', (request) => {
      requests.push(request)
      return true
    })
    context.after(async () => {
      await close(server, root, 'test')
      await rm(root, { force: true, recursive: true })
    })

    await requestOpen(_getSocketPath(root, 'test'), {
      kind: 'folder',
      path: '/home',
      type: 'open',
    })

    deepStrictEqual(requests, [{ kind: 'folder', path: '/home', type: 'open' }])
  },
)

void test(
  'reports when no local editor is connected',
  { skip: isWindows },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lvce-remote-cli-empty-'))
    const server = await listen(root, 'test', () => false)
    context.after(async () => {
      await close(server, root, 'test')
      await rm(root, { force: true, recursive: true })
    })

    await rejects(
      requestOpen(_getSocketPath(root, 'test'), {
        kind: 'folder',
        path: '/home',
        type: 'open',
      }),
      /No local LVCE Editor window/,
    )
  },
)

void test('writes a private launcher for the bundled runtime', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lvce-remote-cli-bin-'))
  context.after(() => rm(root, { force: true, recursive: true }))

  const binDirectory = await prepare(
    root,
    "/runtime/with ' quote/node",
    '/server/lvce.mjs',
  )
  const launcher = await readFile(path.join(binDirectory, 'lvce'), 'utf8')

  match(launcher, /^#!\/bin\/sh\n/)
  match(launcher, /'\/runtime\/with '\\'' quote\/node'/)
  strictEqual(launcher.includes(' cli "$@"'), true)
})
