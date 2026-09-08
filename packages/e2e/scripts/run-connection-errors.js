import { spawn } from 'node:child_process'
import { strictEqual, match } from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSshServer } from 'e2e-helpers'
import { runConnectionErrorScenarios } from './connection-error-scenarios.js'

const sshServer = await createSshServer()
if (sshServer) {
  const root = await mkdtemp(join(tmpdir(), 'lvce-ssh-errors-'))
  const remoteRoot = join(root, 'remote')
  try {
    await runConnectionErrorScenarios(
      sshServer,
      remoteRoot,
      async (target, code, detail) => {
        const child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
        import { toRemoteSshUri } from '../../extension/src/parts/SshTarget/SshTarget.ts'
        import { connect } from '../../node/src/parts/SshFileSystem/SshFileSystem.ts'
        import { dispose } from '../../node/src/parts/SshProcessRegistry/SshProcessRegistry.ts'
        try {
          await connect(toRemoteSshUri(process.argv[1]))
          process.exitCode = 1
        } catch (error) {
          console.log(JSON.stringify({code: error.code, message: error.message}))
        } finally {
          await dispose()
        }
      `,
            target,
          ],
          {
            cwd: import.meta.dirname,
            env: {
              ...sshServer.env,
              LVCE_REMOTE_SSH_REMOTE_ROOT: remoteRoot,
              LVCE_REMOTE_SSH_NODE_VERSION: 'test-node',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 45_000,
          },
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => (stdout += chunk))
        child.stderr.on('data', (chunk) => (stderr += chunk))
        const exitCode = await new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', resolve)
        })
        strictEqual(exitCode, 0, stderr)
        const error = JSON.parse(stdout)
        strictEqual(error.code, code, error.message)
        match(error.message, new RegExp(detail))
        console.log(`PASS ${code}`)
      },
    )
  } finally {
    await sshServer.dispose()
    await rm(root, { recursive: true, force: true })
  }
}
