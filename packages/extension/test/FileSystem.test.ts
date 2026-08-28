import { expect, jest, test } from '@jest/globals'
import { createRemoteFileSystem } from '../src/parts/FileSystem/FileSystem.ts'

test('forwards all file system operations to the SSH node client', async () => {
  const invoke = jest.fn(async (method: string) => {
    if (method === 'SshFileSystem.readDirWithFileTypes') {
      return [{ name: 'home', type: 3 }]
    }
    if (method === 'SshFileSystem.readFile') {
      return 'aGVsbG8='
    }
    return undefined
  })
  const fileSystem = createRemoteFileSystem(invoke)
  const root = 'remote-ssh://example.com/'
  const file = 'remote-ssh://example.com/readme.txt'
  const renamed = 'remote-ssh://example.com/renamed.txt'

  await expect(fileSystem.readDirWithFileTypes(root)).resolves.toEqual([
    { name: 'home', type: 3 },
  ])
  const blob = await fileSystem.readFile(file)
  await expect(blob.text()).resolves.toBe('hello')
  await fileSystem.writeFile(file, 'updated')
  await fileSystem.mkdir('remote-ssh://example.com/folder')
  await fileSystem.rename(file, renamed)
  await fileSystem.remove(renamed)

  expect(invoke.mock.calls).toEqual([
    ['SshFileSystem.readDirWithFileTypes', root],
    ['SshFileSystem.readFile', file],
    ['SshFileSystem.writeFile', file, 'updated'],
    ['SshFileSystem.mkdir', 'remote-ssh://example.com/folder'],
    ['SshFileSystem.rename', file, renamed],
    ['SshFileSystem.remove', renamed],
  ])
  expect(fileSystem.pathSeparator).toBe('/')
  expect(fileSystem.isReadonly?.()).toBe(false)
})

test('preserves binary file content', async () => {
  const fileSystem = createRemoteFileSystem(async () => 'AP8BgA==')

  const blob = await fileSystem.readFile('remote-ssh://example.com/image.png')

  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
    new Uint8Array([0, 255, 1, 128]),
  )
})

test('preserves SSH client errors', async () => {
  const fileSystem = createRemoteFileSystem(async () => {
    throw new Error('Permission denied')
  })

  await expect(
    fileSystem.readFile('remote-ssh://example.com/root/secret'),
  ).rejects.toThrow('Permission denied')
})
