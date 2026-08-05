import { expect, jest, test } from '@jest/globals'
import { connect, placeholder } from '../src/parts/Connect/Connect.ts'

test('cancellation leaves the workspace unchanged', async () => {
  const showInput = jest.fn(
    async (_options?: { readonly placeholder?: string }) => undefined,
  )
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => {})
  const getHosts = jest.fn(async () => [] as readonly string[])

  await connect(showInput, setUri, connectRemote, undefined, getHosts)

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
    const getHosts = jest.fn(async () => [] as readonly string[])

    await connect(showInput, setUri, connectRemote, undefined, getHosts)

    expect(connectRemote).not.toHaveBeenCalled()
    expect(setUri).not.toHaveBeenCalled()
  },
)

test('connects and switches to the remote root', async () => {
  const showInput = jest.fn(async () => '  user@example.com  ')
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => {})
  const getHosts = jest.fn(async () => [] as readonly string[])

  await connect(
    showInput,
    setUri,
    connectRemote,
    (callback) => callback(),
    getHosts,
  )

  expect(connectRemote).toHaveBeenCalledWith('remote-ssh://user@example.com/')
  expect(setUri).toHaveBeenCalledWith('remote-ssh://user@example.com/')
})

test('does not switch workspaces when SSH connection fails', async () => {
  const showInput = jest.fn(async () => 'missing.example.com')
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async () => {
    throw new Error('connection failed')
  })
  const getHosts = jest.fn(async () => [] as readonly string[])

  await expect(
    connect(showInput, setUri, connectRemote, undefined, getHosts),
  ).rejects.toThrow('connection failed')
  expect(setUri).not.toHaveBeenCalled()
})

test('shows SSH config hosts and accepts a selected host', async () => {
  const showInput = jest.fn(async () => undefined)
  const showPick = jest.fn(async (_options: unknown) => 'staging')
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => {})
  const getHosts = jest.fn(async () => ['work', 'staging'])

  await connect(
    showInput,
    setUri,
    connectRemote,
    (callback) => callback(),
    getHosts,
    showPick,
  )

  expect(showInput).not.toHaveBeenCalled()
  expect(showPick).toHaveBeenCalledWith({
    acceptInput: true,
    items: [
      { description: 'SSH config', label: 'work', value: 'work' },
      { description: 'SSH config', label: 'staging', value: 'staging' },
    ],
    placeholder,
  })
  expect(connectRemote).toHaveBeenCalledWith('remote-ssh://staging/')
  expect(setUri).toHaveBeenCalledWith('remote-ssh://staging/')
})

test('accepts a free-form target while showing SSH config hosts', async () => {
  const showInput = jest.fn(async () => undefined)
  const showPick = jest.fn(async (_options: unknown) => 'user@example.com')
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => {})
  const getHosts = jest.fn(async () => ['work'])

  await connect(
    showInput,
    setUri,
    connectRemote,
    (callback) => callback(),
    getHosts,
    showPick,
  )

  expect(connectRemote).toHaveBeenCalledWith('remote-ssh://user@example.com/')
})

test('canceling configured host selection leaves workspace unchanged', async () => {
  const showInput = jest.fn(async () => undefined)
  const showPick = jest.fn(async (_options: unknown) => undefined)
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => {})
  const getHosts = jest.fn(async () => ['work'])

  await connect(showInput, setUri, connectRemote, undefined, getHosts, showPick)

  expect(connectRemote).not.toHaveBeenCalled()
  expect(setUri).not.toHaveBeenCalled()
})
