import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { execute } from '../src/parts/FileSystem/FileSystem.ts'

void test('performs the remote filesystem contract', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lvce-server-fs-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const sourceDirectory = path.join(directory, 'src')
  const sourceFile = path.join(sourceDirectory, 'main.js')
  const targetDirectory = path.join(directory, 'lib')

  await execute({ operation: 'connect', path: directory })
  await execute({ operation: 'mkdir', path: sourceDirectory })
  await execute({
    content: Buffer.from('hello').toString('base64'),
    operation: 'writeFile',
    path: sourceFile,
  })
  strictEqual(await readFile(sourceFile, 'utf8'), 'hello')
  deepStrictEqual(
    await execute({ operation: 'readDirWithFileTypes', path: directory }),
    [{ name: 'src', type: 3 }],
  )
  strictEqual(
    Buffer.from(
      (await execute({ operation: 'readFile', path: sourceFile })) as string,
      'base64',
    ).toString('utf8'),
    'hello',
  )
  await execute({
    newPath: targetDirectory,
    operation: 'rename',
    path: sourceDirectory,
  })
  await execute({ operation: 'remove', path: targetDirectory })
  await rejects(readFile(path.join(targetDirectory, 'main.js')), /ENOENT/)
})

void test('rejects root mutations and existing rename targets', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lvce-server-fs-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const one = path.join(directory, 'one')
  const two = path.join(directory, 'two')
  await writeFile(one, '')
  await writeFile(two, '')

  await rejects(
    execute({ newPath: two, operation: 'rename', path: one }),
    /File exists/,
  )
  await rejects(execute({ operation: 'remove', path: '/' }), /remote root/)
})
