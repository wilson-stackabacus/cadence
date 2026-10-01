// Vercel serverless function. vercel.json rewrites every /api/* request here,
// passing the original sub-path as ?__path=...
import { handleApi } from '../server/app.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const sub = url.searchParams.get('__path');
  const pathname = sub != null ? `/api/${sub}` : url.pathname;
  await handleApi(req, res, pathname);
}
