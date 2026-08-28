import { createNodeRpc } from '@lvce-editor/api'

const rpcId = 'builtin.remote-ssh.node'

const state: {
  rpcPromise: ReturnType<typeof createNodeRpc> | undefined
} = {
  rpcPromise: undefined,
}

const getRpc = (): ReturnType<typeof createNodeRpc> => {
  if (!state.rpcPromise) {
    state.rpcPromise = createNodeRpc({ id: rpcId })
  }
  return state.rpcPromise
}

interface DisposableRpc {
  readonly dispose: () => Promise<void>
  readonly invoke: (method: string) => Promise<unknown>
}

export const disposeRpc = async (rpc: DisposableRpc): Promise<void> => {
  try {
    await rpc.invoke('RemoteSsh.dispose')
  } finally {
    await rpc.dispose()
  }
}

export const invoke = async (
  method: string,
  ...params: readonly unknown[]
): Promise<unknown> => {
  const rpc = await getRpc()
  return rpc.invoke(method, ...params)
}

export const dispose = async (): Promise<void> => {
  if (!state.rpcPromise) {
    return
  }
  const rpc = await state.rpcPromise
  state.rpcPromise = undefined
  await disposeRpc(rpc)
}
