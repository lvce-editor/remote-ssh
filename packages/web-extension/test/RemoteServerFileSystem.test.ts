import { beforeEach, expect, jest, test } from '@jest/globals'
import * as RemoteServerFileSystem from '../src/parts/RemoteServerFileSystem/RemoteServerFileSystem.ts'

const invoke =
  jest.fn<(method: string, ...params: readonly unknown[]) => Promise<unknown>>()

const fileSystem = RemoteServerFileSystem.createRemoteServerFileSystem(invoke)

beforeEach(() => {
  invoke.mockReset()
})

test('maps remote server URIs onto backend file URIs', async () => {
  invoke.mockResolvedValueOnce('aGVsbG8=')

  await expect(
    fileSystem.readFile(
      'remote-server://remote.example.com/home/test/readme.txt',
    ),
  ).resolves.toBe('hello')
  expect(invoke).toHaveBeenCalledWith(
    'FileSystem.readFile',
    'file:///home/test/readme.txt',
    'base64',
  )

  await fileSystem.writeFile(
    'remote-server://remote.example.com/home/test/new.txt',
    'hello',
  )
  expect(invoke).toHaveBeenLastCalledWith(
    'FileSystem.writeFile',
    'file:///home/test/new.txt',
    'aGVsbG8=',
    'base64',
  )
})

test('forwards stat requests and preserves backend errors', async () => {
  invoke.mockResolvedValueOnce(3)

  await expect(
    fileSystem.stat('remote-server://remote.example.com/home/test/link'),
  ).resolves.toBe(3)
  expect(invoke).toHaveBeenCalledWith(
    'FileSystem.stat',
    'file:///home/test/link',
  )

  const error = new Error('Permission denied')
  invoke.mockRejectedValueOnce(error)
  await expect(
    fileSystem.stat('remote-server://remote.example.com/home/test/secret'),
  ).rejects.toBe(error)
})

test('sorts directory entries and normalizes symbolic links', async () => {
  invoke.mockResolvedValueOnce([
    { name: 'z-link', type: 9 },
    { name: 'a-file', type: 1 },
  ])

  await expect(
    fileSystem.readDirWithFileTypes(
      'remote-server://remote.example.com/home/test',
    ),
  ).resolves.toEqual([
    { name: 'a-file', type: 1 },
    { name: 'z-link', type: 7 },
  ])
})

test('rejects root mutations and cross-server renames', async () => {
  await expect(
    fileSystem.remove('remote-server://remote.example.com/'),
  ).rejects.toThrow(/root/)
  await expect(
    fileSystem.rename(
      'remote-server://one.example.com/home/old',
      'remote-server://two.example.com/home/new',
    ),
  ).rejects.toThrow(/across remote servers/)
  expect(invoke).not.toHaveBeenCalled()
})
