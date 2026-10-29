import type * as BackendRouter from '../BackendRouter/BackendRouter.ts'
import type {
  Connection,
  OpenRequest,
  WorkspaceBackend,
} from '../SshTransport/SshTransport.ts'

export interface Transport extends Connection {
  readonly disposeBackendRpcs: () => void
}

// One owner per SSH host. Retired transports remain owned until disconnect:
// already-open sockets, CLI clients and forwarded ports can still depend on them.
export class ConnectionSession implements Connection {
  private active: Transport
  private readonly closed = new Set<Transport>()
  private readonly pending = new Set<Promise<unknown>>()
  private switching: Promise<void> | undefined
  private readonly requests: OpenRequest[] = []
  private readonly waiters: Array<{
    reject: (error: Error) => void
    resolve: (request: OpenRequest) => void
  }> = []
  private readonly router: Awaited<ReturnType<typeof BackendRouter.create>>
  private readonly original: Transport
  private readonly signal: AbortSignal
  private readonly onClose: () => void

  constructor(
    original: Transport,
    router: Awaited<ReturnType<typeof BackendRouter.create>>,
    signal: AbortSignal,
    onClose: () => void,
  ) {
    this.original = original
    this.active = original
    this.router = router
    this.signal = signal
    this.onClose = onClose
    signal.addEventListener(
      'abort',
      () => {
        this.rejectWaiters()
      },
      { once: true },
    )
    this.watch(original)
  }

  private rejectWaiters(): void {
    for (const waiter of this.waiters) {
      waiter.reject(new Error('Remote SSH workspace connection is closed'))
    }
    this.waiters.length = 0
    this.requests.length = 0
  }

  private watch(connection: Transport): void {
    void (async (): Promise<void> => {
      while (!this.signal.aborted && !this.closed.has(connection)) {
        const request = await connection.waitForOpenRequest()
        if (this.signal.aborted) return
        const waiter = this.waiters.shift()
        if (waiter) waiter.resolve(request)
        else this.requests.push(request)
      }
    })().catch(() => {
      this.connectionClosed(connection)
    })
  }

  connectionClosed(connection: Transport): void {
    if (this.closed.has(connection)) return
    this.closed.add(connection)
    if (this.active !== connection || this.signal.aborted) return
    if (connection !== this.original && !this.closed.has(this.original)) {
      this.active = this.original
      void this.original
        .getWorkspaceBackend()
        .then((backend) => {
          if (this.active === this.original && !this.signal.aborted)
            this.router.setBackend(backend)
        })
        .catch(() => this.connectionClosed(this.original))
    } else {
      this.rejectWaiters()
      this.onClose()
    }
  }

  async switchTo(connection: Transport): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.switching = promise
    try {
      // Freeze new node requests and drain every old request, without retrying
      // writes whose result may be unknown. Existing backend sockets stay pinned.
      await Promise.allSettled(this.pending)
      const backend = await connection.getWorkspaceBackend()
      this.signal.throwIfAborted()
      if (this.closed.has(connection))
        throw new Error('Updated SSH connection closed')
      this.router.setBackend(backend)
      const previous = this.active
      this.active = connection
      previous.disposeBackendRpcs()
      this.watch(connection)
    } finally {
      this.switching = undefined
      resolve()
    }
  }

  async invokeBackend(
    type: string,
    method: string,
    params: readonly unknown[],
  ): Promise<unknown> {
    if (this.switching) await this.switching
    this.signal.throwIfAborted()
    const request = this.active.invokeBackend(type, method, params)
    this.pending.add(request)
    try {
      return await request
    } finally {
      this.pending.delete(request)
    }
  }

  async getWorkspaceBackend(): Promise<WorkspaceBackend> {
    this.signal.throwIfAborted()
    return this.router.backend
  }

  forwardPort(
    workspacePath: string,
    remotePort: number,
  ): ReturnType<Connection['forwardPort']> {
    return this.original.forwardPort(workspacePath, remotePort)
  }

  getForwardedPorts(
    workspacePath: string,
  ): ReturnType<Connection['getForwardedPorts']> {
    return this.original.getForwardedPorts(workspacePath)
  }

  stopForwardPort(
    workspacePath: string,
    remotePort: number,
  ): ReturnType<Connection['stopForwardPort']> {
    return this.original.stopForwardPort(workspacePath, remotePort)
  }

  async waitForOpenRequest(): Promise<OpenRequest> {
    this.signal.throwIfAborted()
    const request = this.requests.shift()
    if (request) return request
    return new Promise((resolve, reject) => {
      this.waiters.push({ reject, resolve })
    })
  }

  async dispose(): Promise<void> {
    const transports = new Set([this.original, this.active, ...this.closed])
    for (const transport of transports) {
      await transport.dispose?.()
    }
  }
}
