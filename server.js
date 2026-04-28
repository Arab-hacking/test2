const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function isAllowedProtocol(input) {
  return input === 'http:' || input === 'https:';
}

function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  if (h === '::1') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
  return false;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    if (total > 1_000_000) {
      throw new Error('Payload too large');
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function formatHeaders(headers) {
  const cleaned = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) cleaned[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return cleaned;
}

async function serveStatic(res, requestPath) {
  const pathname = requestPath === '/' ? '/index.html' : requestPath;
  const normalized = path.normalize(pathname).replace(/^\.\.(\/|\\|$)/, '');
  const filePath = path.join(ROOT, normalized);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

async function handleProxy(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { url, method = 'GET', headers = {}, body = '' } = payload;
  if (!url || typeof url !== 'string') {
    sendJson(res, 400, { error: 'Field "url" is required' });
    return;
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    sendJson(res, 400, { error: 'Invalid URL' });
    return;
  }

  if (!isAllowedProtocol(target.protocol)) {
    sendJson(res, 400, { error: 'Only HTTP/HTTPS URLs are allowed' });
    return;
  }

  if (isPrivateHostname(target.hostname)) {
    sendJson(res, 403, { error: 'Private or local hosts are blocked' });
    return;
  }

  const safeHeaders = { ...headers };
  delete safeHeaders.host;
  delete safeHeaders['content-length'];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(target, {
      method: String(method).toUpperCase(),
      headers: safeHeaders,
      body: method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD' ? undefined : body,
      signal: controller.signal,
    });

    const responseText = await response.text();
    clearTimeout(timer);

    sendJson(res, 200, {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: formatHeaders(Object.fromEntries(response.headers.entries())),
      body: responseText,
      requestedAt: new Date().toISOString(),
      target: target.toString(),
    });
  } catch (error) {
    clearTimeout(timer);
    sendJson(res, 502, {
      error: error.name === 'AbortError' ? 'Request timeout (12s)' : 'Request failed',
      details: error.message,
    });
  }
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'api-lab',
      now: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
    });
    return;
  }

  if (pathname === '/api/echo' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      sendJson(res, 200, {
        method: req.method,
        headers: formatHeaders(req.headers),
        rawBody: raw,
        parsedBody: (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })(),
        receivedAt: new Date().toISOString(),
      });
    } catch (error) {
      sendJson(res, 413, { error: error.message });
    }
    return;
  }

  if (pathname === '/api/proxy' && req.method === 'POST') {
    await handleProxy(req, res);
    return;
  }

  sendJson(res, 404, { error: 'API route not found' });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

  if (reqUrl.pathname.startsWith('/api/')) {
    await handleApi(req, res, reqUrl.pathname);
    return;
  }

  await serveStatic(res, reqUrl.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`API Lab server started: http://localhost:${PORT}`);
});
