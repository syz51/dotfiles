import type { Register } from 'claude-code'

// The Artifact tool's description is about 15k tokens. Deferring it keeps
// that text out of every session's prompt; a session that needs the tool
// loads it for itself with ToolSearch `select:Artifact`.
export const register: Register = (on) => {
  on('tool.describe', { tool: 'Artifact' }, async ($, e, next) => ({
    ...(await next(e)),
    isDeferred: true,
  }))
}
