import { json } from './auth.mjs';

// File streams, the one kind of traffic that is not a tool call: upload to POST /files/chat?name=...,
// download from GET /files/chat/<id>/<name>. Used by the standalone server and by the suite's routes().
export async function uploadStream(app, me, req, res, url) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > app.files.maxBytes) return json(res, 413, { error: { code: 'too_large', message: `Files are at most ${Math.round(app.files.maxBytes / 1048576)} MB here.` } });
    chunks.push(c);
  }
  const file = await app.files.put(me, { name: url.searchParams.get('name') ?? 'file', type: req.headers['content-type'], data: Buffer.concat(chunks) });
  json(res, 200, { result: file });
}

export async function downloadStream(app, me, res, p) {
  const id = p.split('/')[3];
  const f = await app.files.readable(me, id);
  if (!f) return json(res, 404, { error: { code: 'not_found', message: 'No such file.' } });
  const data = await app.files.read(f);
  const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(f.type);
  res.writeHead(200, {
    'content-type': f.type, 'content-length': data.length, 'cache-control': 'private, max-age=3600',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  }).end(data);
}
