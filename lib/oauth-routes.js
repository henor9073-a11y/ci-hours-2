import express from 'express';
import {
  registerClient, getClient, createAuthCode, consumeAuthCode,
  verifyPkce, issueToken
} from './oauth.js';

const PASSWORD = process.env.ACCESS_PASSWORD;

function baseUrlOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function mountOAuth(app) {
  // ---- 授权服务器元数据（RFC 8414）----
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const base = baseUrlOf(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['none']
    });
  });

  // ---- 受保护资源元数据（RFC 9728）：告诉客户端 /mcp 归哪个授权服务器管 ----
  const resourceMeta = (req, res) => {
    const base = baseUrlOf(req);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base]
    });
  };
  app.get('/.well-known/oauth-protected-resource', resourceMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);

  // ---- 动态客户端注册（RFC 7591）----
  app.post('/oauth/register', (req, res) => {
    res.status(201).json(registerClient(req.body || {}));
  });

  // ---- 授权页：GET 渲染一个简单的密码确认页 ----
  app.get('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope, response_type } = req.query;

    if (response_type !== 'code') return res.status(400).send('只支持 response_type=code');
    const client = getClient(client_id);
    if (!client) return res.status(400).send('未注册的 client_id，先走一遍 /oauth/register');
    if (!redirect_uri) return res.status(400).send('缺少 redirect_uri');

    res.set('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>辞的时间 · 授权</title>
<style>
body{background:#241E28;color:#E6E1EA;font-family:-apple-system,"Noto Sans SC",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
form{background:#2E2733;padding:2.2rem;border-radius:8px;width:300px;box-sizing:border-box}
h1{font-size:1.05rem;margin:0 0 .6rem;font-weight:500}
p{font-size:.8rem;color:#918799;margin:0 0 1.4rem}
input{width:100%;padding:.65rem;margin-bottom:1rem;border-radius:4px;border:1px solid #3D3544;background:#241E28;color:#E6E1EA;box-sizing:border-box;font-size:1rem}
button{width:100%;padding:.7rem;border-radius:4px;border:none;background:#8FB3A3;color:#241E28;font-weight:bold;cursor:pointer;font-size:.95rem}
.err{color:#C98A8A;font-size:.8rem;margin:-.8rem 0 1rem}
</style></head>
<body>
<form method="POST" action="/oauth/authorize">
  <h1>${escapeHtml(client.client_name || 'MCP 客户端')} 想要连接"辞的时间"</h1>
  <p>输入访问密码确认是你本人在操作</p>
  <input type="password" name="password" placeholder="访问密码" autofocus required>
  <input type="hidden" name="client_id" value="${escapeHtml(client_id || '')}">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri || '')}">
  <input type="hidden" name="state" value="${escapeHtml(state || '')}">
  <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge || '')}">
  <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method || 'S256')}">
  <input type="hidden" name="scope" value="${escapeHtml(scope || '')}">
  <button type="submit">确认授权</button>
</form>
</body></html>`);
  });

  // ---- 授权页：POST 校验密码，签发授权码，跳回客户端的 redirect_uri ----
  app.post('/oauth/authorize', express.urlencoded({ extended: true }), (req, res) => {
    const { password, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.body || {};

    if (PASSWORD && password !== PASSWORD) {
      return res.status(401).send('密码不对，返回上一页重试');
    }
    const client = getClient(client_id);
    if (!client) return res.status(400).send('未注册的 client_id');
    if (!redirect_uri) return res.status(400).send('缺少 redirect_uri');

    const code = createAuthCode({ client_id, redirect_uri, code_challenge, code_challenge_method, scope });

    let url;
    try { url = new URL(redirect_uri); }
    catch { return res.status(400).send('redirect_uri 不是合法的地址'); }
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  // ---- 换取 access token ----
  app.post('/oauth/token', express.urlencoded({ extended: true }), (req, res) => {
    const body = req.body || {};
    if (body.grant_type !== 'authorization_code') {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }
    const entry = consumeAuthCode(body.code);
    if (!entry) return res.status(400).json({ error: 'invalid_grant', error_description: '授权码无效或已过期' });
    if (entry.redirect_uri !== body.redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri 与发起时不一致' });
    }
    if (!verifyPkce(body.code_verifier, entry.code_challenge, entry.code_challenge_method)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE 校验失败' });
    }
    const { access_token, expires_in } = issueToken(entry.client_id);
    res.json({ access_token, token_type: 'Bearer', expires_in, scope: entry.scope || '' });
  });
}
