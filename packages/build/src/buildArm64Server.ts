import { buildServer } from './buildServer.ts'
if (process.platform !== 'linux' || process.arch !== 'arm64')
  throw new Error('ARM64 server archives must be built on Linux ARM64')
await buildServer()
