import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || './data';
const OAUTH_FILE = path.join(DATA_DIR, 'oauth.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function readStore() {
  const s = readJSON(OAUTH_FILE, null);
  if (!s) return { clients: {}, codes: {}, tokens: {} };
  s.clients = s.clients || {};
  s.codes = s.codes || {};
  s.tokens = s.tokens || {};
  return s;
}
function writeStore(s) { writeJSON(OAUTH_FILE, s); }

function randomId(prefix = '', bytes = 24) {
  return prefix + crypto.randomBytes(bytes).toString('base64url');
}

const CODE_TTL_MS = 10 * 60 * 1000;          // 授权码 10 分钟内必须换成 token
const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;  // access token 90 天有效，单用户场景不做刷新令牌，过期了重新走一遍授权就行

// ---- 动态客户端注册（RFC 7591）----
export function registerClient(body) {
  const s = readStore();
  const client_id = randomId('client_');
  const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  s.clients[client_id] = {
    client_id,
    client_name: body.client_name || 'MCP client',
    redirect_uris,
    createdAt: new Date().toISOString()
  };
  writeStore(s);
  return {
    client_id,
    client_name: s.clients[client_id].client_name,
    redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code']
  };
}

export function getClient(client_id) {
  return readStore().clients[client_id] || null;
}

// ---- 授权码 ----
export function createAuthCode({ client_id, redirect_uri, code_challenge, code_challenge_method, scope }) {
  const s = readStore();
  const code = randomId('code_');
  s.codes[code] = {
    client_id, redirect_uri,
    code_challenge: code_challenge || null,
    code_challenge_method: code_challenge_method || 'S256',
    scope: scope || '',
    expiresAt: Date.now() + CODE_TTL_MS
  };
  writeStore(s);
  return code;
}

export function consumeAuthCode(code) {
  const s = readStore();
  const entry = s.codes[code];
  if (!entry) return null;
  delete s.codes[code];
  writeStore(s);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

// ---- PKCE 校验 ----
export function verifyPkce(code_verifier, code_challenge, method) {
  if (!code_challenge) return true; // 客户端没用 PKCE 就不强制，兼容性优先
  if (!code_verifier) return false;
  if (method === 'plain') return code_verifier === code_challenge;
  const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
  return hash === code_challenge;
}

// ---- 访问令牌 ----
export function issueToken(client_id) {
  const s = readStore();
  const access_token = randomId('at_');
  s.tokens[access_token] = { client_id, expiresAt: Date.now() + TOKEN_TTL_MS };
  writeStore(s);
  return { access_token, expires_in: Math.floor(TOKEN_TTL_MS / 1000) };
}

export function checkToken(token) {
  const s = readStore();
  const entry = s.tokens[token];
  if (!entry) return false;
  return entry.expiresAt >= Date.now();
}
