/**
 * Singleton MCP client that talks to the official MongoDB MCP Server.
 *
 * Architecture:
 *   Gemini Agent  →  this MCP Client  →  mongodb-mcp-server (stdio)  →  MongoDB Atlas
 *
 * The server is spawned the first time a tool is needed and kept alive for
 * the lifetime of the Node process. In dev mode the client survives HMR
 * reloads via globalThis caching.
 *
 * Notes:
 * - Spawning a subprocess works in `next dev` and in self-hosted Node, but
 *   NOT in Vercel's serverless functions. For the hackathon demo we run
 *   `npm start` on the demo machine, so this is fine.
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface CachedClient {
  client: Client;
  ready: Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __wherebear_mongo_mcp: CachedClient | undefined;
}

function buildClient(): CachedClient {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI must be set for MCP client');

  // Spawn the locally-installed server binary directly — `npx -y …` re-runs
  // npm's resolution machinery on every spawn (slow, RAM-heavy, and its cache
  // lock contends with the ADK toolset's spawns; see lib/agents/adk/search-agent.ts).
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), 'node_modules', 'mongodb-mcp-server', 'dist', 'esm', 'index.js')],
    env: {
      ...process.env,
      MDB_MCP_CONNECTION_STRING: uri,
      // Default the MCP server's logging to a project-local file so we
      // don't pollute the Next.js dev server output.
      MDB_MCP_LOG_PATH: '.mongodb-mcp-server',
    } as Record<string, string>,
  });

  const client = new Client({
    name: 'wherebear-agent',
    version: '1.0.0',
  });

  const ready = client.connect(transport).then(async () => {
    // eslint-disable-next-line no-console
    console.log('[mcp] connected to mongodb-mcp-server');
  });

  return { client, ready };
}

function getCached(): CachedClient {
  if (!globalThis.__wherebear_mongo_mcp) {
    globalThis.__wherebear_mongo_mcp = buildClient();
  }
  return globalThis.__wherebear_mongo_mcp;
}

export async function callMongoMcp<T = unknown>(
  toolName: string,
  args: Record<string, unknown>
): Promise<T> {
  const { client, ready } = getCached();
  await ready;
  const result = await client.callTool({ name: toolName, arguments: args });
  return result as T;
}

export async function listMongoMcpTools() {
  const { client, ready } = getCached();
  await ready;
  return client.listTools();
}

/**
 * Parse the MCP server's response, which wraps results in
 * `{ content: [{ type: "text", text: "<JSON or human-readable>" }] }`.
 */
export function extractMcpText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c?.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n');
}
