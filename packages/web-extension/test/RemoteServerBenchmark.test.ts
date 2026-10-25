import { expect, jest, test } from '@jest/globals'
import {
  measure,
  summarize,
} from '../src/parts/RemoteServerBenchmark/RemoteServerBenchmark.ts'

test('reports latency percentiles and successive jitter without credentials', () => {
  expect(summarize([10, 30, 20])).toEqual({
    count: 3,
    max: 30,
    mean: 20,
    meanSuccessiveDifference: 15,
    median: 20,
    min: 10,
    p95: 30,
  })
  expect(summarize([])).toEqual({
    count: 0,
    max: null,
    mean: null,
    meanSuccessiveDifference: null,
    median: null,
    min: null,
    p95: null,
  })
})

test('separates first response from warm samples and closes its connection', async () => {
  let clock = 0
  let signal: AbortSignal
  const close = jest.fn()
  const invoke = jest.fn(
    async (_method: string, ..._params: readonly unknown[]) => {
      clock += 10
      if (clock > 30) throw new Error('secret-bearing URL')
      return 3
    },
  )
  const result = await measure('remote-server://remote.example/home/test', {
    connect: async (value) => {
      signal = value
      clock += 5
      return { close, invoke }
    },
    now: () => clock,
    pause: async () => {},
  })
  expect(invoke).toHaveBeenCalledWith('FileSystem.stat', 'file:///home/test')
  expect(result.firstResponseMs).toBe(15)
  expect(result.samplesMs).toEqual([10])
  expect(result.interrupted).toBe(true)
  expect(close).toHaveBeenCalledTimes(1)
  expect(signal!.aborted).toBe(true)
  expect(JSON.stringify(result)).not.toContain('secret')
})

test('cancels a stalled request at the deadline and does not report a fabricated latency', async () => {
  const close = jest.fn()
  const result = await measure(
    'remote-server://remote.example/home/test',
    {
      connect: async (signal) => ({
        close,
        invoke: (): Promise<unknown> =>
          new Promise((_, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new Error('cancelled')),
              { once: true },
            ),
          ),
      }),
      now: () => performance.now(),
      pause: async () => {},
    },
    20,
  )
  expect(result.deadlineExceeded).toBe(true)
  expect(result.firstResponseMs).toBeNull()
  expect(result.samplesMs).toEqual([])
  expect(close).toHaveBeenCalledTimes(1)
})

test('rejects local workspaces without opening a connection', async () => {
  await expect(measure('file:///home/test')).rejects.toThrow(
    'Remote Server workspace',
  )
})
