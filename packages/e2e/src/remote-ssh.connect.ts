import type { Test } from '@lvce-editor/test-with-playwright'

export const name = 'remote-ssh.connect'

export const test: Test = async ({
  Command,
  Dialog,
  Editor,
  expect,
  Explorer,
  KeyBoard,
  Locator,
  Main,
  QuickPick,
}) => {
  await QuickPick.open()
  await QuickPick.setValue('>SSH: Connect')
  await QuickPick.selectItem('SSH: Connect', { waitUntil: 'quickPick' })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const quickPick = Locator('.QuickPick')
  const quickInput = quickPick.locator('input')
  await expect(quickInput).toBeVisible()
  await expect(quickInput).toHaveAttribute(
    'placeholder',
    'Enter SSH host (for example user@example.com)',
  )
  await QuickPick.handleInput('user@example.com')
  await expect(quickInput).toHaveValue('user@example.com')

  await KeyBoard.press('Enter')
  let workspaceUri = ''
  for (let attempt = 0; attempt < 20; attempt++) {
    workspaceUri = String(await Command.execute('Workspace.getUri'))
    if (workspaceUri === 'remote-ssh:///test-folder') {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (workspaceUri !== 'remote-ssh:///test-folder') {
    throw new Error(`Unexpected workspace URI: ${workspaceUri}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await expect(quickPick).toBeHidden()
  await Explorer.refresh()

  const explorer = Locator('.Explorer')
  const readme = explorer.locator('text=README.md')
  const sourceFolder = explorer.locator('text=src')
  await expect(readme).toBeVisible()
  await expect(sourceFolder).toBeVisible()

  await Main.openUri('remote-ssh:///test-folder/README.md')
  await Editor.shouldHaveText('# Mock Remote SSH Workspace\n')
  await Editor.setText('# Updated Remote Workspace\n')
  await Main.save()
  await Main.closeActiveEditor()
  await Main.openUri('remote-ssh:///test-folder/README.md')
  await Editor.shouldHaveText('# Updated Remote Workspace\n')

  await Explorer.newFile()
  const editInput = explorer.locator('input')
  await expect(editInput).toBeVisible()
  await Explorer.updateEditingValue('notes.txt')
  await Explorer.acceptEdit()

  const notes = explorer.locator('text=notes.txt')
  await expect(notes).toBeVisible()
  await Explorer.renameDirent()
  await Explorer.updateEditingValue('renamed-notes.txt')
  await Explorer.acceptEdit()

  const renamedNotes = explorer.locator('text=renamed-notes.txt')
  await expect(renamedNotes).toBeVisible()
  await Dialog.mockConfirm(() => true)
  await Explorer.removeDirent()
  await new Promise((resolve) => setTimeout(resolve, 50))
  await expect(renamedNotes).toBeHidden()
}
