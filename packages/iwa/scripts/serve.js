import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(
  currentDirectory,
  '..',
  '..',
  '..',
  '.tmp',
  'remote-ssh-iwa',
)
const contentTypes = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
}

export const createIwaServer = () => {
  return createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname
    const requestedPath = pathname === '/' ? '/index.html' : pathname
    const filePath = path.join(root, requestedPath)
    if (!filePath.startsWith(root + path.sep)) {
      response.writeHead(404).end()
      return
    }
    try {
      await stat(filePath)
      response.setHeader(
        'content-type',
        contentTypes[path.extname(filePath)] || 'application/octet-stream',
      )
      createReadStream(filePath).pipe(response)
    } catch {
      response.writeHead(404).end()
    }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createIwaServer()
  server.listen(5193, '127.0.0.1', () => {
    console.log('Remote SSH IWA dev server: http://127.0.0.1:5193')
  })
}
