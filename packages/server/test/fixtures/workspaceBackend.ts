import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { WebSocketServer } from 'ws'

const portArgument = process.argv.find((value) => value.startsWith('--port='))
if (!portArgument) {
  throw new Error('Missing --port')
}
const port = Number.parseInt(portArgument.slice('--port='.length), 10)
const server = createServer()
const webSocketServer = new WebSocketServer({ noServer: true })
webSocketServer.on('connection', (webSocket) => {
  webSocket.on('message', (data) => {
    const request = JSON.parse(data.toString()) as {
      readonly id: number
      readonly method: string
      readonly params: readonly unknown[]
    }
    if (request.method !== 'RemoteCli.open') {
      webSocket.send(
        JSON.stringify({
          error: { message: `Unknown command: ${request.method}` },
          id: request.id,
        }),
      )
      return
    }
    const requestPath = process.env.LVCE_REMOTE_SSH_TEST_OPEN_REQUEST_PATH
    const writeRequest = requestPath
      ? writeFile(requestPath, JSON.stringify(request.params[0]))
      : Promise.resolve()
    void writeRequest.then(() => {
      webSocket.send(JSON.stringify({ id: request.id, result: true }))
    })
  })
})
server.on('upgrade', (request, socket, head) => {
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit('connection', webSocket, request)
  })
})
server.listen(port, '127.0.0.1')
process.once('SIGTERM', () => server.close())
