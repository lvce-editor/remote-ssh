import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

export const root: string = path.join(currentDirectory, '..', '..', '..')
