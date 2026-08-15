import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

const directoryType = 3
const fileType = 7

const requireMutable = (filePath: string): void => {
  if (path.normalize(filePath) === path.parse(filePath).root) {
    throw new Error('Cannot modify the remote root folder')
  }
}

const connect = async (filePath: string): Promise<void> => {
  const stats = await stat(filePath)
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${filePath}`)
  }
}

const readDirWithFileTypes = async (
  filePath: string,
): Promise<readonly { readonly name: string; readonly type: number }[]> => {
  const entries = await readdir(filePath, { withFileTypes: true })
  return entries
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? directoryType : fileType,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

const readFileBase64 = async (filePath: string): Promise<string> => {
  return (await readFile(filePath)).toString('base64')
}

const writeFileBase64 = async (
  filePath: string,
  content: string | undefined,
): Promise<void> => {
  requireMutable(filePath)
  if (typeof content !== 'string') {
    throw new TypeError('Missing file content')
  }
  await writeFile(filePath, Buffer.from(content, 'base64'))
}

const makeDirectory = async (filePath: string): Promise<void> => {
  requireMutable(filePath)
  await mkdir(filePath)
}

const remove = async (filePath: string): Promise<void> => {
  requireMutable(filePath)
  const stats = await lstat(filePath)
  await rm(filePath, {
    force: false,
    recursive: stats.isDirectory() && !stats.isSymbolicLink(),
  })
}

const renameEntry = async (oldPath: string, newPath: string): Promise<void> => {
  requireMutable(oldPath)
  requireMutable(newPath)
  await lstat(oldPath)
  try {
    await lstat(newPath)
    const error = new Error(`File exists: ${newPath}`) as NodeJS.ErrnoException
    error.code = 'EEXIST'
    error.errno = 17
    throw error
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  await rename(oldPath, newPath)
}

export interface RemoteFileSystemRequest {
  readonly content?: string
  readonly newPath?: string
  readonly operation: string
  readonly path: string
}

export const execute = async (
  request: RemoteFileSystemRequest,
): Promise<unknown> => {
  switch (request.operation) {
    case 'connect':
      return connect(request.path)
    case 'readDirWithFileTypes':
      return readDirWithFileTypes(request.path)
    case 'readFile':
      return readFileBase64(request.path)
    case 'writeFile':
      return writeFileBase64(request.path, request.content)
    case 'mkdir':
      return makeDirectory(request.path)
    case 'remove':
      return remove(request.path)
    case 'rename':
      if (!request.newPath) {
        throw new TypeError('Missing rename target')
      }
      return renameEntry(request.path, request.newPath)
    default:
      throw new Error(`Unknown Remote SSH operation: ${request.operation}`)
  }
}
