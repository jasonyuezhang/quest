/**
 * Claude-mem MCP integration for Quest agents.
 *
 * Provides the claude-mem MCP server config so agents can search/retrieve
 * observations from previous sessions, reducing context token usage.
 *
 * Claude-mem tools available to agents:
 *   - search(query, filters?) → compact observation index
 *   - timeline(anchorId) → chronological context around an observation
 *   - get_observations(ids) → full observation details
 *
 * Agents use these to:
 *   1. On session start: search for prior work on this feature
 *   2. On context reset: retrieve compressed summary instead of full diffs
 *   3. During implementation: find relevant patterns from past sessions
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Path to the claude-mem MCP server script */
function findMcpServerPath(): string | null {
  // Check the plugin cache for the latest version
  const pluginBase = join(homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem')

  if (!existsSync(pluginBase)) return null

  // Find the latest version directory
  const versions = readdirSync(pluginBase).filter(d => /^\d+\.\d+\.\d+$/.test(d)).sort()
  if (versions.length === 0) return null

  const latest = versions[versions.length - 1]
  const serverPath = join(pluginBase, latest, 'scripts', 'mcp-server.cjs')

  return existsSync(serverPath) ? serverPath : null
}

/**
 * Get the claude-mem MCP server config for use in agent query() options.
 * Returns null if claude-mem is not installed.
 */
export function getMemoryMcpServer(): Record<string, { command: string; args: string[] }> | null {
  const serverPath = findMcpServerPath()
  if (!serverPath) return null

  return {
    'claude-mem': {
      command: 'node',
      args: [serverPath],
    },
  }
}

/**
 * Build a memory-aware system prompt extension.
 * Instructs the agent to search claude-mem for prior work before starting.
 */
export function memoryPromptExtension(featureId: string): string {
  return `
## Memory Search (context optimization)

You have access to a memory system (claude-mem) that stores observations from previous sessions.
Before starting work, search for prior context to avoid re-reading files unnecessarily:

1. Call the search tool with query "${featureId}" to find related observations
2. If results are found, use get_observations to load only the specific details you need
3. This is more token-efficient than re-reading the entire codebase

If no memory results are found, proceed with the normal startup protocol.
Do NOT spend more than 2 turns on memory search — if nothing useful is found, move on.`
}

/**
 * Merge claude-mem MCP server config with existing MCP servers.
 */
export function withMemory(
  existingServers?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const memServer = getMemoryMcpServer()
  if (!memServer) return existingServers

  return {
    ...existingServers,
    ...memServer,
  }
}
