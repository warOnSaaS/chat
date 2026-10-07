import fs from 'node:fs';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';
import { newId, nowIso } from './ids.mjs';
import { ChatError } from './chat.mjs';

// Where uploaded files live. Three choices, picked from the environment:
//   S3_BUCKET set          any S3-compatible store (AWS S3, Cloudflare R2, MinIO, Backblaze B2)
//   FILES_STORAGE=db       inside the database (small teams and the demo; 4 MB per file)
//   otherwise              a folder on disk, FILES_DIR (default ./data/files)
export class Files {
  constructor(db, env = process.env) {
    this.db = db;
    this.mode = env.S3_BUCKET ? 's3' : env.FILES_STORAGE === 'db' ? 'db' : 'disk';
    this.dir = path.resolve(env.FILES_DIR ?? path.join('data', 'files'));
    this.maxBytes = Math.min(Number(env.FILES_MAX_MB || 25), this.mode === 'db' ? 4 : 1024) * 1024 * 1024;
    if (this.mode === 's3') {
      this.bucket = env.S3_BUCKET;
      this.endpoint = (env.S3_ENDPOINT || `https://s3.${env.S3_REGION || 'us-east-1'}.amazonaws.com`).replace(/\/$/, '');
      this.s3 = new AwsClient({ accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, region: env.S3_REGION || 'auto', service: 's3' });
    }
  }

  #url(key) { return `${this.endpoint}/${this.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`; }

  async put(me, { name, type, data }) {
    if (!data?.length) throw new ChatError('The file is empty.');
    if (data.length > this.maxBytes) throw new ChatError(`Files are at most ${Math.round(this.maxBytes / 1048576)} MB here.`, 413);
    name = String(name || 'file').replace(/[\\/\0]/g, '_').slice(0, 200);
    type = /^[\w.+-]+\/[\w.+-]+$/.test(type ?? '') ? type : 'application/octet-stream';
    const id = newId('f');
    const key = `${me.team_id}/${id}`;
    if (this.mode === 'disk') {
      fs.mkdirSync(path.join(this.dir, me.team_id), { recursive: true });
      fs.writeFileSync(path.join(this.dir, me.team_id, id), data);
    } else if (this.mode === 's3') {
      const r = await this.s3.fetch(this.#url(key), { method: 'PUT', body: data, headers: { 'content-type': type } });
      if (!r.ok) throw new ChatError(`The file store said no (${r.status}).`, 502);
    }
    await this.db.run('insert into chat_files (id, team_id, uploader_id, name, type, size, storage, key, data, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [id, me.team_id, me.id, name, type, data.length, this.mode, key, this.mode === 'db' ? data : null, nowIso()]);
    return { id, name, type, size: data.length, url: `/files/${id}/${encodeURIComponent(name)}` };
  }

  // A file is readable by whoever uploaded it, and by anyone who can read a message it is attached to.
  async readable(me, id) {
    const f = await this.db.get('select id, team_id, uploader_id, name, type, size, storage, key from chat_files where id = $1', [id]);
    if (!f || f.team_id !== me.team_id) return null;
    if (f.uploader_id === me.id) return f;
    const ok = await this.db.get(`select 1 as ok from chat_attachments a join chat_messages m on m.id = a.message_id join chat_channels c on c.id = m.channel_id
      where a.file_id = $1 and m.deleted_at is null and (c.kind = 'public' or exists (select 1 from chat_members y where y.channel_id = c.id and y.member_id = $2))`, [id, me.id]);
    return ok ? f : null;
  }

  async read(f) {
    if (f.storage === 'disk') return fs.readFileSync(path.join(this.dir, f.team_id, f.id));
    if (f.storage === 's3') {
      const r = await this.s3.fetch(this.#url(f.key));
      if (!r.ok) throw new ChatError(`The file store said no (${r.status}).`, 502);
      return Buffer.from(await r.arrayBuffer());
    }
    const row = await this.db.get('select data from chat_files where id = $1', [f.id]);
    return Buffer.from(row.data);
  }
}
