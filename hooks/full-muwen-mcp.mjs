#!/usr/bin/env node

// Session-aware full Muwen MCP proxy for Claude windows.
//
// The old shared HTTP configuration could authenticate the machine but could
// not identify which live Claude session invoked a call tool. This stdio
// bridge inherits MUWU_SESSION_ID from each window and forwards it as a
// trusted routing header. It intentionally does not filter tools; main-window
// access policy remains enforced by the backend.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  if (process.env.MUWEN_URL && process.env.MUWEN_TOKEN) {
    return { url: process.env.MUWEN_URL, token: process.env.MUWEN_TOKEN }
  }
  try {
    const value = JSON.parse(fs.readFileSync(path.join(HERE, '.muwu.json'), 'utf8').replace(/^﻿/, ''))
    if (value.url && value.token) return value
  } catch {}
  return null
}

const CONFIG = loadConfig()
const SESSION_ID = String(process.env.MUWU_SESSION_ID || '').trim()
let requestId = 0
let cachedTools = null

async function upstream(method, params = {}) {
  if (!CONFIG?.token || !CONFIG?.url) throw new Error('木纹连接缺少配置')
  const response = await fetch(String(CONFIG.url).replace(/\/$/, '') + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-access-token': String(CONFIG.token),
      'x-muwu-session-id': SESSION_ID,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    signal: AbortSignal.timeout(25_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`木纹服务暂时不可用（${response.status}）`)
  if (payload?.error) throw new Error(String(payload.error.message || '木纹请求失败'))
  return payload?.result || {}
}

async function tools() {
  if (cachedTools) return cachedTools
  const result = await upstream('tools/list')
  cachedTools = Array.isArray(result.tools) ? result.tools : []
  return cachedTools
}

const server = new Server(
  { name: 'muwen-session-proxy', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await tools() }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    return await upstream('tools/call', {
      name: String(request.params?.name || ''),
      arguments: request.params?.arguments || {},
    })
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] }
  }
})

await server.connect(new StdioServerTransport())
