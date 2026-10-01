// Simulates how Vercel invokes api/index.js: the vercel.json rewrite turns /api/<path>
// into /api/index?__path=<path>, and JSON bodies arrive pre-parsed on req.body.
import { createServer } from 'node:http';
import handler from '../api/index.js';

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const sub = url.pathname.replace(/^\/api\//, '');
  url.pathname = '/api/index';
  url.searchParams.set('__path', sub);
  req.url = url.pathname + url.search;
  if (req.method === 'POST') {
    const chunks = []; for await (const c of req) chunks.push(c);
    req.body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  }
  await handler(req, res);
}).listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`)).json();
  const u = `shim_${Date.now().toString(36)}`;
  const reg = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'shim-password-1' }) });
  const { token } = await reg.json();
  const sync = await fetch(`${base}/api/sync?since=0`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ since: 0, changes: [] }) });
  console.log('health', JSON.stringify(health), '| register', reg.status, '| sync', sync.status, JSON.stringify(await sync.json()));
  server.close();
});
