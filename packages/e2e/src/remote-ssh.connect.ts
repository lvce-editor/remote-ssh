import type { Test } from '@lvce-editor/test-with-playwright'

export const name = 'remote-ssh.connect'

export const test: Test = async ({ QuickPick }) => {
  await QuickPick.open()
  await QuickPick.setValue('>SSH: Connect')
  await QuickPick.selectItem('SSH: Connect', { waitUntil: 'quickPick' })
}
