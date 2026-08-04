import { expect, jest, test } from '@jest/globals'
import { connect, placeholder } from '../src/parts/Connect/Connect.ts'

test('cancellation leaves the workspace unchanged', async () => {
  const showInput = jest.fn(
    async (_options?: { readonly placeholder?: string }) => undefined,
  )
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => {})

  await connect(showInput, setUri, connectRemote)

  expect(showInput).toHaveBeenCalledWith({ placeholder })
  expect(connectRemote).not.toHaveBeenCalled()
  expect(setUri).not.toHaveBeenCalled()
})

test.each(['', ' '.repeat(3), '\n\t'])(
  'blank input %p leaves the workspace unchanged',
  async (value) => {
    const showInput = jest.fn(async () => value)
    const setUri = jest.fn(async (_uri: string) => {})
    const connectRemote = jest.fn(async (_uri: string) => {})

    await connect(showInput, setUri, connectRemote)

    expect(connectRemote).not.toHaveBeenCalled()
    expect(setUri).not.toHaveBeenCalled()
  },
)

test('connects and switches to the remote root', async () => {
  const showInput = jest.fn(async () => '  user@example.com  ')
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => {})

  await connect(showInput, setUri, connectRemote, (callback) => callback())

  expect(connectRemote).toHaveBeenCalledWith('remote-ssh://user@example.com/')
  expect(setUri).toHaveBeenCalledWith('remote-ssh://user@example.com/')
})

test('does not switch workspaces when SSH connection fails', async () => {
  const showInput = jest.fn(async () => 'missing.example.com')
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async () => {
    throw new Error('connection failed')
  })

  await expect(connect(showInput, setUri, connectRemote)).rejects.toThrow(
    'connection failed',
  )
  expect(setUri).not.toHaveBeenCalled()
})
