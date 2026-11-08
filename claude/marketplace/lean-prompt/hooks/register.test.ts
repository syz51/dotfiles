import { expect, test } from 'bun:test'
import { register } from './register.ts'

type Hook = ($: unknown, e: Record<string, unknown>, next: (e: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<unknown>

function hooks() {
  const added: { event: string; matcher: unknown; hook: Hook }[] = []
  const on = (event: string, matcher: unknown, hook: Hook) => added.push({ event, matcher, hook })
  register(on as never, {} as never)
  return added
}

test('it hooks only the Artifact tool description', () => {
  expect(hooks().map(({ event, matcher }) => ({ event, matcher }))).toEqual([
    { event: 'tool.describe', matcher: { tool: 'Artifact' } },
  ])
})

test('Artifact keeps its description and waits behind ToolSearch', async () => {
  const [{ hook }] = hooks()
  const e = { tool: 'Artifact', description: 'long text' }
  const result = await hook({}, e, async (input) => ({ description: input.description }))
  expect(result).toEqual({ description: 'long text', isDeferred: true })
})
