// One small database layer for Postgres (DATABASE_URL) and SQLite (a file, for one computer).
// SQL is written once with $1, $2 placeholders (SQLite gets plain ?). Migrations in ../migrations apply
// themselves on start, each once, in order.
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.resolve(new URL('../migrations', import.meta.url).pathname);

export async function openDb({ url = process.env.DATABASE_URL, file = process.env.SQLITE_FILE } = {}) {
  if (url && /^postgres(ql)?:/.test(url)) return openPg(url);
  return openSqlite(file ?? path.resolve('data', 'chat.db'));
}

async function openPg(url) {
  const { default: pg } = await import('pg');
  const ssl = /sslmode=(require|verify)/.test(url) || /neon\.tech|supabase|amazonaws/.test(url) ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString: url.replace(/[?&]sslmode=[^&]*/, (m) => (m.startsWith('?') ? '?' : '')).replace(/\?$/, ''), ssl, max: Number(process.env.DB_POOL || 5) });
  pool.on('error', (e) => console.error('db pool:', e.message));
  const wrap = (q) => ({
    dialect: 'pg',
    async all(sql, params = []) { return (await q.query(sql, params)).rows; },
    async get(sql, params = []) { return (await q.query(sql, params)).rows[0] ?? null; },
    async run(sql, params = []) { const r = await q.query(sql, params); return { changes: r.rowCount, rows: r.rows }; },
  });
  const db = {
    ...wrap(pool),
    kind: 'postgres',
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        const out = await fn(wrap(c));
        await c.query('commit');
        return out;
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    async notify(channel, payload) { await pool.query('select pg_notify($1, $2)', [channel, payload]); },
    // LISTEN needs a direct connection, not a pooled one (Neon and PgBouncer pool in transaction mode).
    async listen(channel, onMessage) {
      const listenUrl = process.env.DATABASE_URL_UNPOOLED || url;
      let client, closed = false;
      const connect = async () => {
        client = new pg.Client({ connectionString: listenUrl.replace(/[?&]sslmode=[^&]*/, (m) => (m.startsWith('?') ? '?' : '')).replace(/\?$/, ''), ssl });
        client.on('notification', (n) => { if (n.channel === channel) onMessage(n.payload); });
        client.on('error', () => {});
        client.on('end', () => { if (!closed) setTimeout(() => connect().catch(() => {}), 1000); });
        await client.connect();
        await client.query(`listen ${channel}`);
      };
      await connect();
      return async () => { closed = true; await client?.end().catch(() => {}); };
    },
    async close() { await pool.end(); },
  };
  return db;
}

async function openSqlite(file) {
  const { default: Database } = await import('better-sqlite3');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const s = new Database(file);
  s.pragma('journal_mode = WAL');
  s.pragma('busy_timeout = 5000');
  // $1, $2 become plain ? with the values put in the order they appear (a value used twice is passed twice).
  const cache = new Map();
  const prep = (sql) => {
    let p = cache.get(sql);
    if (!p) {
      const order = [];
      const stmt = s.prepare(sql.replace(/\$(\d+)/g, (_, n) => { order.push(Number(n) - 1); return '?'; }).replace(/\bilike\b/gi, 'like'));
      p = { stmt, order, reader: stmt.reader };
      cache.set(sql, p);
    }
    return p;
  };
  const val = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  const bind = (p, params) => p.order.map((i) => val(params[i]));
  const q = {
    dialect: 'sqlite',
    async all(sql, params = []) { const p = prep(sql); return p.reader ? p.stmt.all(...bind(p, params)) : (p.stmt.run(...bind(p, params)), []); },
    async get(sql, params = []) { const p = prep(sql); return p.reader ? p.stmt.get(...bind(p, params)) ?? null : (p.stmt.run(...bind(p, params)), null); },
    async run(sql, params = []) {
      const p = prep(sql);
      if (p.reader) { const rows = p.stmt.all(...bind(p, params)); return { changes: rows.length, rows }; }
      const r = p.stmt.run(...bind(p, params));
      return { changes: r.changes, rows: [] };
    },
  };
  let lock = Promise.resolve();
  return {
    ...q,
    kind: 'sqlite',
    exec: (sql) => s.exec(sql),
    // One writer at a time: transactions queue behind each other.
    tx(fn) {
      const run = lock.then(async () => {
        s.exec('begin immediate');
        try {
          const out = await fn(q);
          s.exec('commit');
          return out;
        } catch (e) {
          try { s.exec('rollback'); } catch {}
          throw e;
        }
      });
      lock = run.catch(() => {});
      return run;
    },
    async notify() {},
    async listen() { return async () => {}; },
    async close() { s.close(); },
  };
}

// Migrations follow the suite contract: NNNN_label.sql runs everywhere; NNNN_label.postgres.sql and
// NNNN_label.sqlite.sql run on their own database and replace a plain file of the same number.
export function migrationFiles(dialect) {
  const want = dialect === 'pg' ? 'postgres' : 'sqlite';
  const byNumber = new Map();
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    const m = /^(\d+)_([\w-]+?)(?:\.(postgres|sqlite))?\.sql$/.exec(f);
    if (!m || (m[3] && m[3] !== want)) continue;
    if (!m[3] && byNumber.get(m[1])?.dialect) continue;
    byNumber.set(m[1], { file: f, id: `${m[1]}_${m[2]}`, dialect: !!m[3] });
  }
  return [...byNumber.values()];
}

export async function migrate(db) {
  const files = migrationFiles(db.dialect);
  // Two copies starting at once must not race to create this table: take the same lock as the migrations.
  if (db.dialect === 'pg') await db.tx(async (t) => { await t.run('select pg_advisory_xact_lock(812734)'); await t.run('create table if not exists chat_migrations (id text primary key, applied_at text not null)'); });
  else await db.run('create table if not exists chat_migrations (id text primary key, applied_at text not null)');
  const applied = [];
  for (const { file, id } of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    if (db.dialect === 'pg') {
      await db.tx(async (t) => {
        // Several server copies may start at once: one applies, the others wait and then skip.
        await t.run('select pg_advisory_xact_lock(812734)');
        if (await t.get('select id from chat_migrations where id = $1', [id])) return;
        await t.run(sql);
        await t.run('insert into chat_migrations (id, applied_at) values ($1, $2)', [id, new Date().toISOString()]);
        applied.push(id);
      });
    } else {
      if (await db.get('select id from chat_migrations where id = $1', [id])) continue;
      db.exec('begin');
      try {
        db.exec(sql);
        await db.run('insert into chat_migrations (id, applied_at) values ($1, $2)', [id, new Date().toISOString()]);
        db.exec('commit');
      } catch (e) {
        db.exec('rollback');
        throw e;
      }
      applied.push(id);
    }
  }
  return applied;
}
