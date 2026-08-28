import { expect, jest, test } from '@jest/globals'
import { disposeRpc } from '../src/parts/Rpc/Rpc.ts'

test('disposes SSH processes before closing the node RPC', async () => {
  const calls: string[] = []
  const rpc = {
    async dispose(): Promise<void> {
      calls.push('dispose')
    },
    async invoke(method: string): Promise<void> {
      calls.push(method)
    },
  }

  await disposeRpc(rpc)

  expect(calls).toEqual(['RemoteSsh.dispose', 'dispose'])
})

test('closes the node RPC when SSH cleanup fails', async () => {
  const dispose = jest.fn(async () => {})
  const rpc = {
    dispose,
    async invoke(): Promise<void> {
      throw new Error('cleanup failed')
    },
  }

  await expect(disposeRpc(rpc)).rejects.toThrow('cleanup failed')
  expect(dispose).toHaveBeenCalledTimes(1)
})
