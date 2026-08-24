import type { Transport } from 'sshclient-wasm'
import {
  createTcpSocket,
  type TcpSocketFactory,
  type TcpSocketLike,
} from './DirectSocketTypes.ts'

export class DirectSocketTransport implements Transport {
  private closed = true
  private readonly createSocket: TcpSocketFactory
  private readonly host: string
  private readonly port: number
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  private socket: TcpSocketLike | undefined
  private writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  readonly id: string
  onClose: (() => void) | undefined
  onData: ((data: Uint8Array) => void) | undefined
  onError: ((error: Error) => void) | undefined

  constructor(
    id: string,
    host: string,
    port: number,
    createSocket: TcpSocketFactory = createTcpSocket,
  ) {
    this.id = id
    this.host = host
    this.port = port
    this.createSocket = createSocket
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.closed && this.reader) {
        const { done, value } = await this.reader.read()
        if (done) {
          break
        }
        if (value.byteLength > 0) {
          this.onData?.(value)
        }
      }
    } catch (error) {
      if (!this.closed) {
        this.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    } finally {
      if (!this.closed) {
        await this.disconnect()
      }
    }
  }

  async connect(): Promise<void> {
    if (!this.closed) {
      return
    }
    const socket = this.createSocket(this.host, this.port)
    this.socket = socket
    const { readable, writable } = await socket.opened
    this.closed = false
    this.reader = readable.getReader()
    this.writer = writable.getWriter()
    void this.readLoop()
  }

  async disconnect(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    const { reader, socket, writer } = this
    this.reader = undefined
    this.writer = undefined
    this.socket = undefined
    await Promise.allSettled([
      reader?.cancel(),
      writer?.close(),
      socket?.close(),
    ])
    this.onClose?.()
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.closed || !this.writer) {
      throw new Error('Direct Socket transport is not connected')
    }
    await this.writer.write(new Uint8Array(data))
  }
}
