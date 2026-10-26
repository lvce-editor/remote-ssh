import { executeCommand } from '@lvce-editor/api'
import { createAccountClient } from './RemoteAccountClient.ts'

const getBackendUrl = (): Promise<string> =>
  executeCommand('Authentication.getBackendUrl') as Promise<string>

export const openConnections = async (
  execute: typeof executeCommand = executeCommand,
): Promise<void> => {
  const url = new URL(
    '/cloudflare',
    (await execute('Authentication.getBackendUrl')) as string,
  )
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  ) {
    throw new Error(
      'Cloudflare connections require an HTTPS authentication backend',
    )
  }
  if (url.username || url.password)
    throw new Error('Authentication backend URL must not contain credentials')
  await execute('Open.openUrl', url.href, false)
}

export const client = createAccountClient({
  backendUrl: getBackendUrl,
  fetch: globalThis.fetch.bind(globalThis),
  getAccountChangeState: () =>
    executeCommand('Authentication.getAccountChangeState') as Promise<{
      changing: boolean
      generation: number
    }>,
  getAccounts: () =>
    executeCommand('Authentication.getAccounts') as Promise<
      readonly { active: boolean; id: string; signedIn: boolean }[]
    >,
  getToken: (refresh = false) =>
    executeCommand('Authentication.getAccessToken', refresh) as Promise<string>,
})
