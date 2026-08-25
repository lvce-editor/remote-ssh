import { strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { getDevServerPort } from '../src/getDevServerPort.ts'

void test('uses port 3000 by default', () => {
  strictEqual(getDevServerPort({}), '3000')
})

void test('preserves an explicit development server port', () => {
  strictEqual(getDevServerPort({ PORT: '4123' }), '4123')
})
