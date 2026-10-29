#!/usr/bin/env node

// Memory-only MCP surface for parallel Claude windows.
//
// The main Claude window keeps the full Muwu MCP. Parallel windows use this
// proxy so they can recall shared memory and inspect recalled photos without
// receiving or sending cabin chat, calls, notifications, or other main-window
// interactions.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const UPSTREAM = String(process.env.MUWEN_URL || 'https://ci-hours-2.onrender.com').replace(/\/$/, '') + '/mcp'
const TOKEN = String(process.env.MUWEN_TOKEN || '')
const SESSION_ID = String(process.env.MUWU_SESSION_ID || '')

const ALLOWED = new Set([
  'get_summary',
  'get_active_memories',
  'get_profile',
  'search_grains',
  'get_grain',
  'list_families',
  'get_grain_with_counterevidence',
  'get_tidy_report',
  'get_memory',
  'get_recall_logs',
  'recall',
  'auto_recall',
  'get_photo',
  'photo_recall',
])

let requestId = 0
let cachedTools = null

async function upstream(method, params = {}) {
  if (!TOKEN) throw new Error('并行召回入口缺少木纹令牌')
  const response = await fetch(UPSTREAM, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-access-token': TOKEN,
      'x-muwu-session-id': SESSION_ID,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    signal: AbortSignal.timeout(25_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`木纹召回服务暂时不可用（${response.status}）`)
  if (payload?.error) throw new Error(String(payload.error.message || '木纹召回请求失败'))
  return payload?.result || {}
}

async function allowedTools() {
  if (cachedTools) return cachedTools
  const result = await upstream('tools/list')
  cachedTools = (Array.isArray(result.tools) ? result.tools : []).filter(tool => ALLOWED.has(tool?.name))
  return cachedTools
}

const server = new Server(
  { name: 'muwen-parallel-recall', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await allowedTools() }))

server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = String(request.params?.name || '')
  if (!ALLOWED.has(name)) {
    return {
      isError: true,
      content: [{ type: 'text', text: `并行窗口只开放记忆召回；不能使用 ${name || '这个工具'}。` }],
    }
  }
  try {
    return await upstream('tools/call', {
      name,
      arguments: request.params?.arguments || {},
    })
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: String(error?.message || error) }],
    }
  }
})

await server.connect(new StdioServerTransport())
