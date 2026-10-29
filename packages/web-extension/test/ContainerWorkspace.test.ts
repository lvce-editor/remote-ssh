import { expect, test } from '@jest/globals'
import * as ContainerWorkspace from '../src/parts/ContainerWorkspace/ContainerWorkspace.ts'

const id = 'a'.repeat(32)
test('container identity is distinct while paths round trip spaces, unicode and delimiters', () => {
  const uri = ContainerWorkspace.create(
    'remote-server://host/project',
    id,
    '/work space/café#?%',
  )
  expect(ContainerWorkspace.getContainer(uri)).toBe(id)
  expect(ContainerWorkspace.getPath(uri)).toBe('/work space/café#?%')
  expect(ContainerWorkspace.getPath('remote-server://host/home/project')).toBe(
    '/home/project',
  )
})
test('invalid container identities cannot become host paths', () => {
  expect(() =>
    ContainerWorkspace.getPath(
      'remote-server://invalid.lvce-container.invalid/home',
    ),
  ).toThrow('Invalid container')
})
