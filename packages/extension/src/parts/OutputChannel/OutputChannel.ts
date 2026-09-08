import { createOutputChannel, executeCommand } from '@lvce-editor/api'

const output = createOutputChannel('remote-ssh')

export const log = async (message: string): Promise<void> => {
  try {
    await output.appendLine(`[${new Date().toISOString()}] ${message}`)
    // Extension output storage does not emit file change events.
    await executeCommand('Output.refresh')
  } catch {
    // Logging must not prevent connecting or reporting the original SSH error.
  }
}
