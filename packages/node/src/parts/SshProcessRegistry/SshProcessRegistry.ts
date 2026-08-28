import type { ChildProcess } from 'node:child_process'

const gracefulShutdownTimeout = 1000

const children = new Set<ChildProcess>()

const state = {
  disposed: false,
}

const hasExited = (child: ChildProcess): boolean => {
  return child.exitCode !== null || child.signalCode !== null
}

const waitForClose = (child: ChildProcess, timeout: number): Promise<void> => {
  if (hasExited(child)) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const handleClose = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      child.off('close', handleClose)
      resolve()
    }, timeout)
    child.once('close', handleClose)
  })
}

const terminate = async (child: ChildProcess): Promise<void> => {
  if (hasExited(child)) {
    return
  }
  child.kill('SIGTERM')
  await waitForClose(child, gracefulShutdownTimeout)
  if (hasExited(child)) {
    return
  }
  child.kill('SIGKILL')
  await waitForClose(child, gracefulShutdownTimeout)
}

export const register = <T extends ChildProcess>(child: T): T => {
  child.once('close', () => {
    children.delete(child)
  })
  if (state.disposed) {
    child.kill('SIGTERM')
  } else {
    children.add(child)
  }
  return child
}

export const dispose = async (): Promise<void> => {
  state.disposed = true
  await Promise.all(Array.from(children, terminate))
  children.clear()
}

export const disposeSync = (): void => {
  state.disposed = true
  for (const child of children) {
    if (!hasExited(child)) {
      child.kill('SIGTERM')
    }
  }
  children.clear()
}

export const _reset = (): void => {
  children.clear()
  state.disposed = false
}

process.once('exit', disposeSync)
