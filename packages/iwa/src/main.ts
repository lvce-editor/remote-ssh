import { getEnvironmentStatus } from './Environment.ts'
import * as SshSession from './SshSession.ts'

const getElement = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector(`#${id}`)
  if (!element) {
    throw new Error(`Missing element: ${id}`)
  }
  return element as T
}

const form = getElement<HTMLFormElement>('connection-form')
const hostInput = getElement<HTMLInputElement>('host')
const portInput = getElement<HTMLInputElement>('port')
const userInput = getElement<HTMLInputElement>('user')
const passwordInput = getElement<HTMLInputElement>('password')
const privateKeyInput = getElement<HTMLTextAreaElement>('private-key')
const privateKeyFileInput = getElement<HTMLInputElement>('private-key-file')
const connectButton = getElement<HTMLButtonElement>('connect')
const disconnectButton = getElement<HTMLButtonElement>('disconnect')
const commandForm = getElement<HTMLFormElement>('command-form')
const commandInput = getElement<HTMLInputElement>('command')
const sendButton = getElement<HTMLButtonElement>('send')
const terminal = getElement<HTMLOutputElement>('terminal')
const status = getElement<HTMLOutputElement>('status')
const capability = getElement<HTMLElement>('capability')

const state: { session: SshSession.SshSession | undefined } = {
  session: undefined,
}

const setConnectionState = (value: string): void => {
  status.value = value
  status.textContent = value
  const connected = value === 'connected'
  connectButton.disabled = value === 'connecting' || connected
  disconnectButton.disabled = !connected
  commandInput.disabled = !connected
  sendButton.disabled = !connected
}

const appendOutput = (value: string): void => {
  terminal.textContent += value
  terminal.scrollTop = terminal.scrollHeight
}

const environment = getEnvironmentStatus()
capability.textContent = environment.message
capability.dataset.available = String(environment.available)
connectButton.disabled = !environment.available

form.addEventListener('submit', (event): void => {
  event.preventDefault()
  void (async (): Promise<void> => {
    setConnectionState('connecting')
    terminal.textContent = ''
    try {
      const keyFile = privateKeyFileInput.files?.[0]
      const privateKey =
        privateKeyInput.value || (keyFile ? await keyFile.text() : undefined)
      state.session = await SshSession.connect(
        {
          host: hostInput.value.trim(),
          password: passwordInput.value || undefined,
          port: Number(portInput.value),
          privateKey,
          user: userInput.value.trim(),
        },
        appendOutput,
        setConnectionState,
      )
      setConnectionState('connected')
      commandInput.focus()
    } catch (error) {
      setConnectionState('error')
      appendOutput(
        `\n${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  })()
})

disconnectButton.addEventListener('click', (): void => {
  void (async (): Promise<void> => {
    await state.session?.disconnect()
    state.session = undefined
    setConnectionState('disconnected')
  })()
})

commandForm.addEventListener('submit', (event): void => {
  event.preventDefault()
  if (!state.session || !commandInput.value) {
    return
  }
  const { value } = commandInput
  commandInput.value = ''
  void state.session.send(`${value}\n`)
})
