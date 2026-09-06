export class RemoteServerError extends Error {
  readonly code: string

  constructor(message: string, code: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'RemoteServerError'
    this.code = code
  }
}
