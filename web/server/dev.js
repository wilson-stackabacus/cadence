// Local development server: serves public/ and routes /api/* to the same handler Vercel uses.
//   npm run dev   ->  http://localhost:8132
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './app.js';
import { usingTurso } from './db.js';

const PORT = Number(process.env.PORT || 8132);
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname);
  let rel = normalize(decodeURIComponent(url.pathname));
  if (rel === '/') rel = '/index.html';
  const file = join(PUBLIC, rel);
  try {
    if (!file.startsWith(PUBLIC) || !(await stat(file)).isFile()) throw new Error();
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(PORT, () => console.log(`Cadence web (dev) on http://localhost:${PORT} — database: ${usingTurso ? 'Turso' : 'local file web/data/cadence.db'}`));
