import { strictEqual } from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  _reset,
  dispose,
  register,
} from '../src/parts/SshProcessRegistry/SshProcessRegistry.ts'

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false
    }
    throw error
  }
}

const waitForExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!isRunning(pid)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Process ${pid} did not exit`)
}

void test('terminates registered SSH processes when disposed', async () => {
  _reset()
  const child = register(
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    }),
  )
  await once(child, 'spawn')

  await dispose()

  strictEqual(child.signalCode, 'SIGTERM')
})

void test('terminates registered SSH processes when the node helper exits', async () => {
  const fixture = fileURLToPath(
    new URL('fixtures/exitWithSshChild.ts', import.meta.url),
  )
  const parent = spawn(process.execPath, [fixture], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const chunks: Buffer[] = []
  parent.stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })
  const [code] = await once(parent, 'close')
  strictEqual(code, 0)
  const pid = Number(Buffer.concat(chunks).toString('utf8').trim())
  strictEqual(Number.isSafeInteger(pid), true)

  await waitForExit(pid)

  strictEqual(isRunning(pid), false)
})
