const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { apiHandler } = require('./api-handler.cjs');
require('./views.cjs').warm();
const { securityHeaders } = require('./security-headers.cjs');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 4173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };

http.createServer((req, res) => {
  for (const [name, value] of Object.entries(securityHeaders())) res.setHeader(name, value);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    // JSON answers are brotli-compressed when accepted, as Vercel does for function responses.
    if (/\bbr\b/.test(req.headers['accept-encoding'] || '')) {
      const writeHead = res.writeHead.bind(res), end = res.end.bind(res);
      let status = 200, headers = {};
      res.writeHead = (st, h) => { status = st; headers = h || {}; return res; };
      res.end = (body) => {
        if (body && /json/.test(headers['content-type'] || '')) { writeHead(status, { ...headers, 'content-encoding': 'br', vary: 'accept-encoding' }); return end(zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })); }
        writeHead(status, headers); return end(body);
      };
    }
    return apiHandler(req, res);
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'public, max-age=86400' }).end();
    return;
  }

  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const file = path.resolve(ROOT, `.${pathname}`);
  const target = pathname === '/' ? path.join(ROOT, 'index.html') : file;
  // Inside the project only, and never a hidden file or folder (.git, .claude, .env…).
  if ((target !== path.join(ROOT, 'index.html') && !target.startsWith(`${ROOT}${path.sep}`)) || path.relative(ROOT, target).split(path.sep).some((part) => part.startsWith('.'))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(target, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const type = TYPES[path.extname(target)] || 'application/octet-stream';
    // Text is brotli-compressed when the browser accepts it, as Vercel does, so local timings resemble production.
    const br = /\bbr\b/.test(req.headers['accept-encoding'] || '') && /^(text\/|application\/(javascript|json)|image\/svg)/.test(type);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...(br ? { 'content-encoding': 'br', vary: 'accept-encoding' } : {}) });
    (br ? fs.createReadStream(target).pipe(zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })) : fs.createReadStream(target)).pipe(res);
  });
// This machine only by default; HOST=0.0.0.0 to test from a phone on the same network.
}).listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`tacitview at http://localhost:${PORT}`));
