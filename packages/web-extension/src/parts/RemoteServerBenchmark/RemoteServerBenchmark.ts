import { getWorkspaceUri, openUri, showNotification } from '@lvce-editor/api'
import * as Connection from '../RemoteServerConnection/RemoteServerConnection.ts'

interface Probe {
  readonly close: () => void
  readonly invoke: (
    method: string,
    ...params: readonly unknown[]
  ) => Promise<unknown>
}

export interface Dependencies {
  readonly connect: (signal: AbortSignal) => Promise<Probe>
  readonly now: () => number
  readonly pause: (signal: AbortSignal) => Promise<void>
}

const defaults: Dependencies = {
  connect: Connection.createBenchmarkRpc,
  now: () => performance.now(),
  pause: (signal) =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, 50)
      signal.addEventListener('abort', done, { once: true })
      if (signal.aborted) done()
    }),
}

interface LatencySummary {
  readonly count: number
  readonly max: number | null
  readonly mean: number | null
  readonly meanSuccessiveDifference: number | null
  readonly median: number | null
  readonly min: number | null
  readonly p95: number | null
}

interface BenchmarkReport {
  readonly attemptedRequests: number
  readonly completedRequests: number
  readonly deadlineExceeded: boolean
  readonly durationMs: number
  readonly firstResponseMs: number | null
  readonly interrupted: boolean
  readonly measurement: string
  readonly notes: readonly string[]
  readonly roundTripMs: LatencySummary
  readonly samplesMs: readonly number[]
  readonly schemaVersion: number
  readonly stallsOver250Ms: number
  readonly transport: string
}

export const summarize = (samples: readonly number[]): LatencySummary => {
  const sorted = samples.toSorted((a, b) => a - b)
  const percentile = (p: number): number | null =>
    sorted.length > 0
      ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
      : null
  return {
    count: samples.length,
    max: sorted.at(-1) ?? null,
    mean:
      samples.length > 0
        ? samples.reduce((a, b) => a + b, 0) / samples.length
        : null,
    meanSuccessiveDifference:
      samples.length > 1
        ? samples
            .slice(1)
            .reduce(
              (sum, value, index) => sum + Math.abs(value - samples[index]),
              0,
            ) /
          (samples.length - 1)
        : null,
    median: percentile(0.5),
    min: sorted[0] ?? null,
    p95: percentile(0.95),
  }
}

export const measure = async (
  workspaceUri: string,
  dependencies: Dependencies = defaults,
  durationMs = 5000,
): Promise<BenchmarkReport> => {
  const workspace = new URL(workspaceUri)
  if (workspace.protocol !== 'remote-server:')
    throw new Error('Open a Remote Server workspace before benchmarking')
  const path = new URL('file:///')
  path.pathname = decodeURIComponent(workspace.pathname)
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), durationMs)
  const started = dependencies.now()
  let rpc: Probe | undefined
  let firstResponseMs: number | null = null
  let attemptedRequests = 0
  let completedRequests = 0
  let interrupted = false
  let deadlineExceeded = false
  const samplesMs: number[] = []
  try {
    rpc = await dependencies.connect(controller.signal)
    while (!controller.signal.aborted) {
      const before = dependencies.now()
      attemptedRequests++
      await rpc.invoke('FileSystem.stat', path.href)
      completedRequests++
      const after = dependencies.now()
      if (firstResponseMs === null) firstResponseMs = after - started
      else samplesMs.push(after - before)
      await dependencies.pause(controller.signal)
    }
  } catch {
    // No raw network errors: they may contain credential-bearing URLs.
    if (controller.signal.aborted) deadlineExceeded = true
    else interrupted = true
  } finally {
    clearTimeout(deadline)
    controller.abort()
    rpc?.close()
  }
  return {
    attemptedRequests,
    completedRequests,
    deadlineExceeded,
    durationMs: dependencies.now() - started,
    firstResponseMs,
    interrupted,
    measurement: 'sequential read-only workspace stat',
    notes: [
      'First response includes authorization, connection setup and remote service startup.',
      'Warm round trips include network, tunnel, gateway and filesystem service time; this does not isolate Cloudflare latency.',
      'One request at a time, with 50 ms between samples. No workspace files are written.',
      'An unfinished request at the five-second deadline is cancelled, not counted as a completed sample.',
      'This measures small-request latency and jitter, not bulk transfer bandwidth.',
    ],
    roundTripMs: summarize(samplesMs),
    samplesMs,
    schemaVersion: 1,
    stallsOver250Ms: samplesMs.filter((sample) => sample > 250).length,
    transport: 'authenticated-websocket',
  }
}

const state: {
  report: { readonly content: string; readonly uri: string } | undefined
  running: boolean
} = { report: undefined, running: false }
export const reportProvider = {
  id: 'remote-benchmark',
  isReadonly: (): boolean => true,
  readFile: (uri: string): string => {
    if (uri !== state.report?.uri)
      throw new Error('Benchmark report is no longer available')
    return state.report.content
  },
  stat: (uri: string): number => {
    if (uri !== state.report?.uri)
      throw new Error('Benchmark report is no longer available')
    return 1
  },
}

export const run = async (): Promise<void> => {
  if (state.running) {
    await showNotification(
      'info',
      'A remote connection benchmark is already running',
    )
    return
  }
  state.running = true
  try {
    const workspace = await getWorkspaceUri()
    Connection.assertWorkspace(workspace)
    const generation = Connection.getGeneration()
    await showNotification(
      'info',
      'Measuring remote connection for about five seconds…',
    )
    const result = await measure(workspace)
    if (generation !== Connection.getGeneration()) return
    const uri = `remote-benchmark://connection/${crypto.randomUUID()}.json`
    const { notes, samplesMs, ...summary } = result
    const ordered = Object.fromEntries([
      ...Object.entries(summary),
      ['notes', notes],
      ['samplesMs', samplesMs],
    ])
    state.report = { content: JSON.stringify(ordered, null, 2) + '\n', uri }
    await openUri(uri)
  } finally {
    state.running = false
  }
}

export const dispose = (): void => {
  state.report = undefined
}
