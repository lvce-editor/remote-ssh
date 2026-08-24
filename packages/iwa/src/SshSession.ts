// cspell:ignore sshclient
import { SSHClient, type SSHSession as WasmSshSession } from 'sshclient-wasm'
import { DirectSocketTransport } from './DirectSocketTransport.ts'

export interface ConnectOptions {
  readonly host: string
  readonly password?: string
  readonly port: number
  readonly privateKey?: string
  readonly user: string
}

export interface SshSession {
  readonly disconnect: () => Promise<void>
  readonly send: (value: string) => Promise<void>
}

const encoder = new TextEncoder()

export const connect = async (
  options: ConnectOptions,
  onOutput: (value: string) => void,
  onStateChange: (value: string) => void,
): Promise<SshSession> => {
  await SSHClient.initialize({
    autoDetect: false,
    cacheBusting: false,
    wasmExecPath: '/wasm_exec.js',
    wasmPath: '/sshclient.wasm',
  })
  const transport = new DirectSocketTransport(
    `direct-ssh-${crypto.randomUUID()}`,
    options.host,
    options.port,
  )
  const decoder = new TextDecoder()
  let session: WasmSshSession | undefined
  try {
    session = await SSHClient.connect(options, transport, {
      onPacketReceive(data, metadata) {
        if (metadata.type === 'data') {
          onOutput(decoder.decode(data, { stream: true }))
        }
      },
      onStateChange,
    })
  } catch (error) {
    await transport.disconnect()
    throw error
  }
  return {
    disconnect: () => session.disconnect(),
    send: (value) => session.send(encoder.encode(value)),
  }
}
