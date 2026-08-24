export interface EnvironmentStatus {
  readonly available: boolean
  readonly message: string
}

export const getEnvironmentStatus = (
  global: Pick<typeof globalThis, 'TCPSocket'> = globalThis,
): EnvironmentStatus => {
  if (typeof global.TCPSocket !== 'function') {
    return {
      available: false,
      message:
        'Direct Sockets are not available in a normal web page. Install this build as a Chrome Isolated Web App.',
    }
  }
  return {
    available: true,
    message: 'Direct Sockets are available. SSH traffic stays on this device.',
  }
}
