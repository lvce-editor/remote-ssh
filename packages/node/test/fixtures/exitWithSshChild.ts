import { spawn } from 'node:child_process'
import { register } from '../../src/parts/SshProcessRegistry/SshProcessRegistry.ts'

const child = register(
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  }),
)

child.once('spawn', () => {
  process.stdout.write(`${child.pid}\n`, () => process.exit(0))
})
