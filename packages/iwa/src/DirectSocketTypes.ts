export interface TcpSocketOpenInfo {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
}

export interface TcpSocketLike {
  close(): Promise<void>
  readonly opened: Promise<TcpSocketOpenInfo>
}

export type TcpSocketFactory = (host: string, port: number) => TcpSocketLike

interface TcpSocketConstructor {
  new (
    host: string,
    port: number,
    options?: { readonly noDelay?: boolean },
  ): TcpSocketLike
}

declare global {
  var TCPSocket: TcpSocketConstructor | undefined
}

export const createTcpSocket: TcpSocketFactory = (host, port) => {
  if (!globalThis.TCPSocket) {
    throw new Error(
      'Direct Sockets are unavailable. Install and open the Isolated Web App in Chrome.',
    )
  }
  return new globalThis.TCPSocket(host, port, { noDelay: true })
}
