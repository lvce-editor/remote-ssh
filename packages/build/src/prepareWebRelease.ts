import { createHash } from 'node:crypto'
import { copyFile, readFile, writeFile } from 'node:fs/promises'

const version = process.argv[2]
if (!/^v\d+\.\d+\.\d+$/.test(version || ''))
  throw new Error('Expected a release tag')
const name = `remote-server-${version}.tar.br`
await copyFile('remote-server-extension.tar.br', name)
const digest = createHash('sha256')
  .update(await readFile(name))
  .digest('hex')
await writeFile(`${name}.sha256`, `${digest}  ${name}\n`)
