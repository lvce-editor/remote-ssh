import type { Test } from '@lvce-editor/test-with-playwright'

export const name = 'remote-ssh.connect'

export const test: Test = async ({ expect, Locator, QuickPick }) => {
  await QuickPick.open()
  await QuickPick.setValue('>SSH: Connect')
  await QuickPick.selectItem('SSH: Connect', { waitUntil: 'quickPick' })

  const quickPick = Locator('.QuickPick')
  const quickInput = quickPick.locator('input')
  await expect(quickInput).toBeVisible()
  await expect(quickInput).toHaveAttribute(
    'placeholder',
    'Enter SSH host (for example user@example.com or ssh -p 2222 user@example.com)',
  )
}
