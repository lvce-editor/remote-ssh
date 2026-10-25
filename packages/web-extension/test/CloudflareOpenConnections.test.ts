import { afterEach, expect, jest, test } from '@jest/globals'

const execute = jest.fn<(...args: readonly unknown[]) => Promise<unknown>>()
import { openConnections } from '../../shared/src/parts/Cloudflare/Cloudflare.ts'
afterEach(() => {
  jest.resetAllMocks()
})

test('desktop and web share the configured backend connections page', async () => {
  execute
    .mockResolvedValueOnce('https://custom-backend.test/base')
    .mockResolvedValue(undefined)
  await openConnections(execute)
  expect(execute.mock.calls).toEqual([
    ['Authentication.getBackendUrl'],
    ['Open.openUrl', 'https://custom-backend.test/cloudflare', false],
  ])
})

test.each([
  new URL('https://public.test').href.replace('https:', 'http:'),
  'https://user:secret@backend.test',
])('rejects unsafe connections pages: %s', async (backend) => {
  execute.mockResolvedValue(backend)
  await expect(openConnections(execute)).rejects.toThrow()
  expect(execute).toHaveBeenCalledTimes(1)
})

test('allows a configured loopback development backend', async () => {
  execute.mockResolvedValue('http://localhost:3000')
  await openConnections(execute)
  expect(execute).toHaveBeenLastCalledWith(
    'Open.openUrl',
    'http://localhost:3000/cloudflare',
    false,
  )
})
