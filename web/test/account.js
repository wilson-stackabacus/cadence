// Export + account deletion against the dev server, using a throwaway account.
const B = process.argv[2] || 'http://localhost:8132';
let fail = 0;
const check = (ok, m) => { console.log(ok ? 'PASS' : 'FAIL', m); if (!ok) fail++; };
const post = (p, body, token) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const u = `del_${Date.now().toString(36)}`, pw = 'throwaway-password-1';
const { token } = await (await post('/api/register', { username: u, password: pw })).json();
await post('/api/sync', { since: 0, changes: [
  { kind: 'task', id: 'AAAAAAAA-0000-4000-8000-0000000000AA', updatedAt: Date.now(), data: { id: 'AAAAAAAA-0000-4000-8000-0000000000AA', title: 'Export me' } },
  { kind: 'reflection', id: 'BBBBBBBB-0000-4000-8000-0000000000BB', updatedAt: Date.now(), data: { id: 'BBBBBBBB-0000-4000-8000-0000000000BB', text: 'hello' } },
] }, token);
const ex = await fetch(B + '/api/account/export', { headers: { Authorization: `Bearer ${token}` } });
const data = await ex.json();
check(ex.status === 200 && /attachment/.test(ex.headers.get('content-disposition')), 'export downloads as a file');
check(data.account.username === u && data.tasks.length === 1 && data.reflections.length === 1, 'export contains account, tasks, reflections');
check(!JSON.stringify(data).match(/password|token_hash|refresh_token/), 'export contains no secrets');
check((await post('/api/account/delete', { password: 'wrong' }, token)).status === 401, 'delete needs the right password');
check((await post('/api/account/delete', { password: pw }, token)).status === 200, 'delete with password');
check((await fetch(B + '/api/me', { headers: { Authorization: `Bearer ${token}` } })).status === 401, 'session gone after delete');
check((await post('/api/login', { username: u, password: pw })).status === 401, 'cannot sign in to deleted account');
check((await post('/api/register', { username: u, password: pw })).status === 200, 'username is free again');
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
