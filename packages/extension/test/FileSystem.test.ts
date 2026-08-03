import { expect, test } from '@jest/globals'
import { createMemoryFileSystem } from '../src/parts/FileSystem/FileSystem.ts'

const uri = (path: string): string => `remote-ssh://${path}`

test('contains the initial mock tree', () => {
  const fileSystem = createMemoryFileSystem()

  expect(fileSystem.readDirWithFileTypes(uri('/test-folder'))).toEqual([
    { name: 'README.md', type: 7 },
    { name: 'src', type: 3 },
  ])
  expect(fileSystem.readDirWithFileTypes(uri('/test-folder/src'))).toEqual([
    { name: 'main.js', type: 7 },
  ])
  expect(fileSystem.readFile(uri('/test-folder/README.md'))).toBe(
    '# Mock Remote SSH Workspace\n',
  )
  expect(fileSystem.readFile(uri('/test-folder/src/main.js'))).toContain(
    'Hello from Remote SSH',
  )
})

test('writes, replaces, and creates files', () => {
  const fileSystem = createMemoryFileSystem()

  fileSystem.writeFile(uri('/test-folder/README.md'), 'updated')
  fileSystem.writeFile(uri('/test-folder/new.txt'), 'new')

  expect(fileSystem.readFile(uri('/test-folder/README.md'))).toBe('updated')
  expect(fileSystem.readFile(uri('/test-folder/new.txt'))).toBe('new')
})

test('new file system instances reset the session tree', () => {
  const firstFileSystem = createMemoryFileSystem()
  firstFileSystem.writeFile(uri('/test-folder/README.md'), 'changed')

  const restartedFileSystem = createMemoryFileSystem()

  expect(restartedFileSystem.readFile(uri('/test-folder/README.md'))).toBe(
    '# Mock Remote SSH Workspace\n',
  )
})

test('creates directories when the parent exists', () => {
  const fileSystem = createMemoryFileSystem()

  fileSystem.mkdir(uri('/test-folder/nested'))

  expect(fileSystem.readDirWithFileTypes(uri('/test-folder'))).toContainEqual({
    name: 'nested',
    type: 3,
  })
})

test('renames complete directory subtrees', () => {
  const fileSystem = createMemoryFileSystem()

  fileSystem.rename(uri('/test-folder/src'), uri('/test-folder/lib'))

  expect(fileSystem.readFile(uri('/test-folder/lib/main.js'))).toContain(
    'Hello from Remote SSH',
  )
  expect(() => fileSystem.readFile(uri('/test-folder/src/main.js'))).toThrow(
    'Path not found',
  )
})

test('removes directories recursively', () => {
  const fileSystem = createMemoryFileSystem()

  fileSystem.remove(uri('/test-folder/src'))

  expect(() => fileSystem.readFile(uri('/test-folder/src/main.js'))).toThrow(
    'Path not found',
  )
  expect(fileSystem.readDirWithFileTypes(uri('/test-folder'))).toEqual([
    { name: 'README.md', type: 7 },
  ])
})

test('rejects missing parents and sources', () => {
  const fileSystem = createMemoryFileSystem()

  expect(() =>
    fileSystem.writeFile(uri('/test-folder/missing/file.txt'), ''),
  ).toThrow('Parent not found')
  expect(() => fileSystem.mkdir(uri('/test-folder/missing/folder'))).toThrow(
    'Parent not found',
  )
  expect(() =>
    fileSystem.rename(uri('/test-folder/missing'), uri('/test-folder/other')),
  ).toThrow('Path not found')
  expect(() => fileSystem.remove(uri('/test-folder/missing'))).toThrow(
    'Path not found',
  )
})

test('rejects duplicate rename and mkdir targets', () => {
  const fileSystem = createMemoryFileSystem()

  expect(() =>
    fileSystem.rename(uri('/test-folder/src'), uri('/test-folder/README.md')),
  ).toThrow('Path already exists')
  expect(() => fileSystem.mkdir(uri('/test-folder/src'))).toThrow(
    'Path already exists',
  )
})

test('rejects file parents', () => {
  const fileSystem = createMemoryFileSystem()

  expect(() =>
    fileSystem.writeFile(uri('/test-folder/README.md/child.txt'), ''),
  ).toThrow('Parent is not a directory')
  expect(() => fileSystem.mkdir(uri('/test-folder/README.md/child'))).toThrow(
    'Parent is not a directory',
  )
})

test('rejects cross-scheme operations', () => {
  const fileSystem = createMemoryFileSystem()

  expect(() => fileSystem.readFile('file:///test-folder/README.md')).toThrow(
    'Expected remote-ssh URI',
  )
  expect(() =>
    fileSystem.rename(
      uri('/test-folder/README.md'),
      'file:///test-folder/other.md',
    ),
  ).toThrow('Expected remote-ssh URI')
})

test('protects the workspace root', () => {
  const fileSystem = createMemoryFileSystem()

  expect(() => fileSystem.remove(uri('/test-folder'))).toThrow(
    'Cannot remove workspace root',
  )
  expect(() =>
    fileSystem.rename(uri('/test-folder'), uri('/test-folder/other')),
  ).toThrow('Cannot rename workspace root')
})

test('rejects directories moved into themselves', () => {
  const fileSystem = createMemoryFileSystem()

  expect(() =>
    fileSystem.rename(uri('/test-folder/src'), uri('/test-folder/src/nested')),
  ).toThrow('Cannot move a path into itself')
})
