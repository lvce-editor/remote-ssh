export class RemoteSshError extends Error {
  readonly code: string

  constructor(message: string, code: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'RemoteSshError'
    this.code = code
  }
}
