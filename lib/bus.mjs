import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { nowIso } from './ids.mjs';

// Live updates. Every change is written to chat_events (so a client that was away, or one that polls,
// can catch up from a cursor) and sent to this server's open sockets. With Postgres, it is also sent
// with NOTIFY, so every other copy of the server hears it through LISTEN and tells its own sockets.
// Typing and "agent is thinking" are ephemeral: sent live, never stored.
const CHANNEL = 'chat_events';

export class Bus extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.id = crypto.randomBytes(6).toString('hex');
    this.setMaxListeners(0);
  }

  async start() {
    this.stopListening = await this.db.listen(CHANNEL, (payload) => this.#heard(payload));
  }

  async stop() {
    await this.stopListening?.();
  }

  async #heard(payload) {
    let e;
    try { e = JSON.parse(payload); } catch { return; }
    if (e.origin === this.id) return;
    if (e.ref) {
      const row = await this.db.get('select * from chat_events where id = $1', [e.id]);
      if (!row) return;
      e = rowToEvent(row);
    }
    delete e.origin;
    this.emit('event', e);
  }

  // audience: 'team' (everyone on the team can see it) or a list of person ids.
  async publish({ team, channel = null, type, audience = 'team', data = {}, ephemeral = false }) {
    const at = nowIso();
    let id = null;
    if (!ephemeral) {
      const r = await this.db.run('insert into chat_events (team_id, channel_id, type, audience, data, created_at) values ($1, $2, $3, $4, $5, $6) returning id',
        [team, channel, type, JSON.stringify(audience), JSON.stringify(data), at]);
      id = Number(r.rows[0].id);
    }
    const e = { id, team, channel, type, audience, data, at };
    this.emit('event', e);
    let payload = JSON.stringify({ ...e, origin: this.id });
    // NOTIFY carries at most 8000 bytes: a big event goes as a reference the other copies read back.
    if (payload.length > 7000) payload = id === null ? null : JSON.stringify({ id, team, ref: true, origin: this.id });
    if (payload) await this.db.notify(CHANNEL, payload).catch((err) => console.error('notify:', err.message));
    return e;
  }
}

export const rowToEvent = (r) => ({ id: Number(r.id), team: r.team_id, channel: r.channel_id, type: r.type, audience: JSON.parse(r.audience ?? '"team"'), data: JSON.parse(r.data), at: r.created_at });
export const canSee = (e, personId) => e.audience === 'team' || (Array.isArray(e.audience) && e.audience.includes(personId));
