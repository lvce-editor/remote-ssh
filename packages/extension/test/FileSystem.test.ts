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
    if (method === 'SshFileSystem.stat') {
      return 3
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
  await expect(fileSystem.stat(file)).resolves.toBe(3)

  expect(invoke.mock.calls).toEqual([
    ['SshFileSystem.readDirWithFileTypes', root],
    ['SshFileSystem.readFile', file],
    ['SshFileSystem.writeFile', file, 'updated'],
    ['SshFileSystem.mkdir', 'remote-ssh://example.com/folder'],
    ['SshFileSystem.rename', file, renamed],
    ['SshFileSystem.remove', renamed],
    ['SshFileSystem.stat', file],
  ])
  expect(fileSystem.isReadonly?.()).toBe(false)
})

test('preserves binary file content', async () => {
  const fileSystem = createRemoteFileSystem(async () => 'AP8BgA==')

  const blob = await fileSystem.readFile('remote-ssh://example.com/image.png')

  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
    new Uint8Array([0, 255, 1, 128]),
  )
  expect(blob.type).toBe('image/png')
})

test('labels remote SVG blobs with the SVG MIME type', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
  const encodedSvg = btoa(svg)
  const fileSystem = createRemoteFileSystem(async () => encodedSvg)

  const blob = await fileSystem.readFile('remote-ssh://example.com/image.svg')

  expect(blob.type).toBe('image/svg+xml')
  await expect(blob.text()).resolves.toBe(svg)
})

test('preserves SSH client errors', async () => {
  const fileSystem = createRemoteFileSystem(async () => {
    throw new Error('Permission denied')
  })

  await expect(
    fileSystem.readFile('remote-ssh://example.com/root/secret'),
  ).rejects.toThrow('Permission denied')
})

test('preserves SSH stat errors', async () => {
  const error = new Error('Permission denied')
  const fileSystem = createRemoteFileSystem(async () => {
    throw error
  })

  await expect(
    fileSystem.stat('remote-ssh://example.com/root/secret'),
  ).rejects.toBe(error)
})

test('logs verbose file and folder reads with elapsed time', async () => {
  const messages: string[] = []
  let time = 10
  const fileSystem = createRemoteFileSystem(
    async (method) => {
      if (method === 'SshFileSystem.readDirWithFileTypes') {
        return []
      }
      return 'aGVsbG8='
    },
    {
      getLogLevel: async () => 'verbose',
      log: async (message) => {
        messages.push(message)
      },
      now: () => {
        time += 2.5
        return time
      },
    },
  )

  await fileSystem.readFile('remote-ssh://user@example.com/readme.txt')
  await fileSystem.readDirWithFileTypes('remote-ssh://user@example.com/project')

  expect(messages).toEqual([
    'Read file /readme.txt completed in 2.5 ms',
    'Read folder /project completed in 2.5 ms',
  ])
})

test('keeps file read results and errors when verbose logging fails', async () => {
  const fileSystem = createRemoteFileSystem(async () => 'aGVsbG8=', {
    getLogLevel: async () => 'verbose',
    log: async () => {
      throw new Error('Output unavailable')
    },
    now: () => 0,
  })
  const blob = await fileSystem.readFile('remote-ssh://example.com/readme.txt')
  await expect(blob.text()).resolves.toBe('hello')

  const originalError = new Error('Permission denied')
  const failingFileSystem = createRemoteFileSystem(
    async () => {
      throw originalError
    },
    {
      getLogLevel: async () => 'verbose',
      log: async () => {
        throw new Error('Output unavailable')
      },
      now: () => 0,
    },
  )
  await expect(
    failingFileSystem.readFile('remote-ssh://example.com/secret'),
  ).rejects.toBe(originalError)
})

test('does not log reads in default mode', async () => {
  const log = jest.fn(async () => {})
  const fileSystem = createRemoteFileSystem(async () => 'aGVsbG8=', {
    getLogLevel: async () => 'default',
    log,
    now: () => 0,
  })

  await fileSystem.readFile('remote-ssh://example.com/readme.txt')

  expect(log).not.toHaveBeenCalled()
})

test('measures overlapping reads independently', async () => {
  const first = Promise.withResolvers<string>()
  const second = Promise.withResolvers<string>()
  const messages: string[] = []
  const times = [0, 1, 12, 20]
  let readCount = 0
  const fileSystem = createRemoteFileSystem(
    async () => {
      readCount += 1
      if (readCount === 1) {
        return first.promise
      }
      return second.promise
    },
    {
      getLogLevel: async () => 'verbose',
      log: async (message) => {
        messages.push(message)
      },
      now: () => times.shift() ?? 20,
    },
  )

  const firstRead = fileSystem.readFile('remote-ssh://example.com/first.txt')
  const secondRead = fileSystem.readFile('remote-ssh://example.com/second.txt')
  first.resolve('aGVsbG8=')
  await firstRead
  second.resolve('aGVsbG8=')
  await secondRead

  expect(messages).toEqual([
    'Read file /first.txt completed in 12.0 ms',
    'Read file /second.txt completed in 19.0 ms',
  ])
})
