import { createServer } from 'node:net'

const portArgument = process.argv.find((value) => value.startsWith('--port='))
if (!portArgument) {
  throw new Error('Missing --port')
}
const port = Number.parseInt(portArgument.slice('--port='.length), 10)
const server = createServer((socket) => socket.end())
server.listen(port, '127.0.0.1')
process.once('SIGTERM', () => server.close())
