import { expect, jest, test } from '@jest/globals'
import {
  connect,
  placeholder,
  workspaceUri,
} from '../src/parts/Connect/Connect.ts'

test('cancellation leaves the workspace unchanged', async () => {
  const showInput = jest.fn(
    async (_options?: { readonly placeholder?: string }) => undefined,
  )
  const setUri = jest.fn(async (_uri: string) => {})

  await connect(showInput, setUri)

  expect(showInput).toHaveBeenCalledWith({ placeholder })
  expect(setUri).not.toHaveBeenCalled()
})

test.each(['', ' '.repeat(3), '\n\t'])(
  'blank input %p leaves the workspace unchanged',
  async (value) => {
    const showInput = jest.fn(
      async (_options?: { readonly placeholder?: string }) => value,
    )
    const setUri = jest.fn(async (_uri: string) => {})

    await connect(showInput, setUri)

    expect(setUri).not.toHaveBeenCalled()
  },
)

test('non-empty input switches to the fixed mock workspace', async () => {
  const showInput = jest.fn(
    async (_options?: { readonly placeholder?: string }) =>
      '  user@example.com  ',
  )
  const setUri = jest.fn(async (_uri: string) => {})

  await connect(showInput, setUri, (callback) => callback())

  expect(setUri).toHaveBeenCalledWith(workspaceUri)
})
