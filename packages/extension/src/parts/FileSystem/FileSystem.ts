import type { FileSystemDirent, FileSystemProvider } from '@lvce-editor/api'

const directoryType = 3
const fileType = 7
const protocol = 'remote-ssh:'
const root = '/test-folder'

interface DirectoryNode {
  readonly type: 'directory'
}

interface FileNode {
  content: string
  readonly type: 'file'
}

type Node = DirectoryNode | FileNode

const createInitialNodes = (): Map<string, Node> => {
  return new Map([
    [root, { type: 'directory' }],
    [
      `${root}/README.md`,
      { content: '# Mock Remote SSH Workspace\n', type: 'file' },
    ],
    [`${root}/src`, { type: 'directory' }],
    [
      `${root}/src/main.js`,
      { content: "console.log('Hello from Remote SSH')\n", type: 'file' },
    ],
  ])
}

const normalizePath = (path: string): string => {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1)
  }
  return path
}

const parseUri = (uri: string): string => {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new Error(`Invalid Remote SSH URI: ${uri}`)
  }
  if (parsed.protocol !== protocol) {
    throw new Error(`Expected remote-ssh URI, received ${uri}`)
  }
  const path = normalizePath(decodeURIComponent(parsed.pathname))
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error(`Path is outside ${root}: ${uri}`)
  }
  return path
}

const getParentPath = (path: string): string => {
  return path.slice(0, path.lastIndexOf('/'))
}

const getName = (path: string): string => {
  return path.slice(path.lastIndexOf('/') + 1)
}

export interface MemoryFileSystem extends FileSystemProvider {
  readonly mkdir: (uri: string) => void
  readonly readDirWithFileTypes: (uri: string) => readonly FileSystemDirent[]
  readonly remove: (uri: string) => void
  readonly rename: (oldUri: string, newUri: string) => void
  readonly writeFile: (uri: string, content: string) => void
}

export const createMemoryFileSystem = (): MemoryFileSystem => {
  const nodes = createInitialNodes()

  const getNode = (path: string): Node => {
    const node = nodes.get(path)
    if (!node) {
      throw new Error(`Path not found: ${path}`)
    }
    return node
  }

  const requireParent = (path: string): void => {
    const parentPath = getParentPath(path)
    const parent = nodes.get(parentPath)
    if (!parent) {
      throw new Error(`Parent not found: ${parentPath}`)
    }
    if (parent.type !== 'directory') {
      throw new Error(`Parent is not a directory: ${parentPath}`)
    }
  }

  const readFile = (uri: string): string => {
    const path = parseUri(uri)
    const node = getNode(path)
    if (node.type !== 'file') {
      throw new Error(`Path is not a file: ${path}`)
    }
    return node.content
  }

  const readDirWithFileTypes = (uri: string): readonly FileSystemDirent[] => {
    const path = parseUri(uri)
    const node = getNode(path)
    if (node.type !== 'directory') {
      throw new Error(`Path is not a directory: ${path}`)
    }
    const prefix = `${path}/`
    const entries: FileSystemDirent[] = []
    for (const [childPath, child] of nodes) {
      if (!childPath.startsWith(prefix)) {
        continue
      }
      const relativePath = childPath.slice(prefix.length)
      if (relativePath.includes('/')) {
        continue
      }
      entries.push({
        name: getName(childPath),
        type: child.type === 'directory' ? directoryType : fileType,
      })
    }
    return entries.toSorted((a, b) => a.name.localeCompare(b.name))
  }

  const writeFile = (uri: string, content: string): void => {
    const path = parseUri(uri)
    requireParent(path)
    const existing = nodes.get(path)
    if (existing?.type === 'directory') {
      throw new Error(`Path is a directory: ${path}`)
    }
    nodes.set(path, { content, type: 'file' })
  }

  const mkdir = (uri: string): void => {
    const path = parseUri(uri)
    if (nodes.has(path)) {
      throw new Error(`Path already exists: ${path}`)
    }
    requireParent(path)
    nodes.set(path, { type: 'directory' })
  }

  const remove = (uri: string): void => {
    const path = parseUri(uri)
    getNode(path)
    if (path === root) {
      throw new Error(`Cannot remove workspace root: ${root}`)
    }
    for (const childPath of nodes.keys()) {
      if (childPath === path || childPath.startsWith(`${path}/`)) {
        nodes.delete(childPath)
      }
    }
  }

  const rename = (oldUri: string, newUri: string): void => {
    const oldPath = parseUri(oldUri)
    const newPath = parseUri(newUri)
    getNode(oldPath)
    if (oldPath === root) {
      throw new Error(`Cannot rename workspace root: ${root}`)
    }
    if (nodes.has(newPath)) {
      throw new Error(`Path already exists: ${newPath}`)
    }
    if (newPath.startsWith(`${oldPath}/`)) {
      throw new Error(`Cannot move a path into itself: ${oldPath}`)
    }
    requireParent(newPath)
    const movedNodes = [...nodes].filter(
      ([path]) => path === oldPath || path.startsWith(`${oldPath}/`),
    )
    for (const [path] of movedNodes) {
      nodes.delete(path)
    }
    for (const [path, node] of movedNodes) {
      nodes.set(`${newPath}${path.slice(oldPath.length)}`, node)
    }
  }

  return {
    id: 'remote-ssh',
    isReadonly: () => false,
    mkdir,
    pathSeparator: '/',
    readDirWithFileTypes,
    readFile,
    remove,
    rename,
    writeFile,
  }
}

export const fileSystem = createMemoryFileSystem()
