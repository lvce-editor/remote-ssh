import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { marker, source } from '../src/parts/RemoteHelper/RemoteHelper.ts'

interface Response {
  readonly error?: string
  readonly ok: boolean
  readonly result?: unknown
}

const invoke = (
  request: Readonly<Record<string, unknown>>,
): Promise<Response> => {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-c', source], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8')))
        return
      }
      const line = Buffer.concat(stdout).toString('utf8').trim()
      resolve(JSON.parse(line.slice(marker.length)) as Response)
    })
    child.stdin.end(JSON.stringify(request))
  })
}

const invokeSuccess = async (
  request: Readonly<Record<string, unknown>>,
): Promise<unknown> => {
  const response = await invoke(request)
  if (!response.ok) {
    throw new Error(response.error)
  }
  return response.result
}

void test(
  'performs real filesystem operations through the remote helper',
  { skip: process.platform === 'win32' },
  async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lvce-remote-ssh-'))
    context.after(() => rm(directory, { force: true, recursive: true }))
    const sourceDirectory = path.join(directory, 'src')
    const sourceFile = path.join(sourceDirectory, 'main.js')
    const renamedDirectory = path.join(directory, 'lib')
    const renamedFile = path.join(renamedDirectory, 'main.js')

    await invokeSuccess({ operation: 'connect', path: directory })
    await invokeSuccess({ operation: 'mkdir', path: sourceDirectory })
    await invokeSuccess({
      content: Buffer.from('hello').toString('base64'),
      operation: 'writeFile',
      path: sourceFile,
    })
    strictEqual(await readFile(sourceFile, 'utf8'), 'hello')
    deepStrictEqual(
      await invokeSuccess({
        operation: 'readDirWithFileTypes',
        path: directory,
      }),
      [{ name: 'src', type: 3 }],
    )
    strictEqual(
      Buffer.from(
        (await invokeSuccess({
          operation: 'readFile',
          path: sourceFile,
        })) as string,
        'base64',
      ).toString('utf8'),
      'hello',
    )
    await invokeSuccess({
      newPath: renamedDirectory,
      operation: 'rename',
      path: sourceDirectory,
    })
    strictEqual(await readFile(renamedFile, 'utf8'), 'hello')
    await invokeSuccess({ operation: 'remove', path: renamedDirectory })
    await rejects(readFile(renamedFile), /ENOENT/)
  },
)

void test(
  'reports missing parents, sources, and duplicate targets',
  { skip: process.platform === 'win32' },
  async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lvce-remote-ssh-'))
    context.after(() => rm(directory, { force: true, recursive: true }))
    const existing = path.join(directory, 'existing')
    await writeFile(existing, '')

    const missingParent = await invoke({
      content: '',
      operation: 'writeFile',
      path: path.join(directory, 'missing', 'file'),
    })
    strictEqual(missingParent.ok, false)
    const missingSource = await invoke({
      newPath: path.join(directory, 'renamed'),
      operation: 'rename',
      path: path.join(directory, 'missing'),
    })
    strictEqual(missingSource.ok, false)
    const duplicateTarget = await invoke({
      newPath: existing,
      operation: 'rename',
      path: directory,
    })
    strictEqual(duplicateTarget.ok, false)
  },
)
