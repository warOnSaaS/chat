// Agents are channel members. @mention one (or message it directly) and it answers in the thread.
// A real agent talks to any OpenAI-compatible model: OpenAI, a company gateway, Ollama, LM Studio,
// llama.cpp or vLLM, set by CHAT_MODEL_URL, CHAT_MODEL_KEY and CHAT_MODEL (or per agent). It can look
// things up with the read-only chat tools, as the agent, so it sees only the channels it belongs to.
// An example agent (the demo's) answers with fixed text and says so.

const READ_TOOLS = ['chat.search_messages', 'chat.read_messages', 'chat.list_channels', 'chat.list_people'];
const parse = (s, d = {}) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export class Agents {
  constructor({ chat, env = process.env, tools }) {
    this.chat = chat;
    this.env = env;
    this.tools = tools; // { list(), run(me, name, input) } from lib/tools.mjs
    this.pending = new Set();
    chat.onPosted((ctx) => this.onPosted(ctx));
  }

  modelReady(agent = {}) {
    return !!(agent.base_url || this.env.CHAT_MODEL_URL || this.env.OPENAI_API_KEY || this.env.CHAT_MODEL_KEY);
  }

  async onPosted({ me, channel, message, root, mentioned }) {
    if (me.kind === 'agent') return; // agents never wake each other, so two agents cannot loop
    const ids = new Set(mentioned.filter((p) => p.kind === 'agent').map((p) => p.id));
    if (channel.kind === 'dm' || channel.kind === 'group_dm') {
      const inDm = await this.chat.db.all(`select m.member_id from chat_members m join chat_people p on p.id = m.member_id where m.channel_id = $1 and p.kind = 'agent'`, [channel.id]);
      if (channel.kind === 'dm') for (const a of inDm) ids.add(a.member_id);
    }
    for (const id of ids) {
      const job = this.answer(id, channel, message, root).catch((e) => console.error('agent:', e.message)).finally(() => this.pending.delete(job));
      this.pending.add(job);
      // On Vercel the function would freeze after the response; waitUntil keeps it alive until the answer is posted.
      if (this.env.VERCEL) import('@vercel/functions').then((v) => v.waitUntil(job)).catch(() => {});
    }
  }

  async idle() { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  async answer(agentId, channel, message, root) {
    const row = await this.chat.personRow(agentId);
    if (!row || row.deactivated_at || !(await this.chat.member(channel.id, agentId))) return;
    const agent = parse(row.agent);
    const thread = root?.id ?? message.id;
    await this.chat.bus.publish({ team: row.team_id, channel: channel.id, type: 'chat.agent.started', audience: channel.kind === 'public' ? 'team' : (await this.chat.db.all('select member_id from chat_members where channel_id = $1', [channel.id])).map((r) => r.member_id), data: { agent: { id: row.id, handle: row.handle, name: row.name }, thread }, ephemeral: true });
    const t = await this.chat.read(row, { thread, limit: 60 });
    let text;
    if (agent.example || !this.modelReady(agent)) text = exampleAnswer(row, agent, t.messages, message, this.modelReady(agent));
    else {
      try { text = await this.modelAnswer(row, agent, channel, t.messages); } catch (e) { text = `I could not reach my model just now (${String(e.message).slice(0, 160)}). Try again in a minute.`; }
    }
    await this.chat.post(row, { thread, body: text || 'I have nothing to add.', via: 'agent' });
  }

  async modelAnswer(row, agent, channel, messages) {
    const base = (agent.base_url || this.env.CHAT_MODEL_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const key = (agent.key_env && this.env[agent.key_env]) || this.env.CHAT_MODEL_KEY || this.env.OPENAI_API_KEY || '';
    const model = agent.model || this.env.CHAT_MODEL || 'gpt-4o-mini';
    const where = channel.kind === 'public' || channel.kind === 'private' ? `#${channel.name}` : 'a direct message';
    const convo = [
      { role: 'system', content: `${agent.prompt || `You are ${row.name}, a helpful teammate in a team chat.`}\nYou are @${row.handle}, answering in a thread in ${where}. Be brief and plain: a few short lines, markdown allowed. Use the tools to look things up in the chat when the thread does not have the answer. Never invent facts.` },
      ...messages.filter((m) => !m.deleted).map((m) => ({ role: m.author.id === row.id ? 'assistant' : 'user', content: m.author.id === row.id ? m.body : `${m.author.name} (@${m.author.handle}): ${m.body}` })),
    ];
    const defs = this.tools.list().filter((t) => READ_TOOLS.includes(t.name)).map((t) => ({ type: 'function', function: { name: t.name.replace('.', '_'), description: t.description, parameters: t.inputJson } }));
    let useTools = true;
    for (let step = 0; step < 5; step++) {
      const body = { model, messages: convo, ...(useTools ? { tools: defs } : {}) };
      const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Some models (and some local servers) refuse tools: answer from the thread alone.
        if (useTools && /tool|function/i.test(JSON.stringify(j))) { useTools = false; continue; }
        throw new Error(j.error?.message || `model said ${r.status}`);
      }
      const msg = j.choices?.[0]?.message;
      if (!msg) throw new Error('empty answer from the model');
      if (!msg.tool_calls?.length) return msg.content?.trim();
      convo.push(msg);
      for (const call of msg.tool_calls) {
        const name = call.function.name.replace('_', '.');
        let out;
        try { out = READ_TOOLS.includes(name) ? await this.tools.run(row, name, parse(call.function.arguments), { via: 'agent' }) : { error: 'not allowed' }; } catch (e) { out = { error: e.message }; }
        convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out).slice(0, 12000) });
      }
    }
    return 'I looked around but ran out of steps. Ask me something narrower?';
  }
}

// The example agent: fixed answers, built from the thread so it still feels useful. It says what it is.
export function exampleAnswer(row, agent, messages, asked, modelReady) {
  const q = String(asked.body ?? '').toLowerCase();
  // The question itself is not part of what it sums up.
  const real = messages.filter((m) => m.author.id !== row.id && !m.deleted && m.id !== asked.id);
  const cut = (s, n = 90) => { const t = String(s).replace(/[*_`>#]+/g, '').replace(/\s+/g, ' ').replace(/@\w+/g, '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const note = modelReady ? '' : '\n\n(Example agent: fixed answers, no AI model connected.)';
  if (/summar|recap|tl;?dr/.test(q)) {
    if (!real.length) return `There is nothing to sum up yet: this thread is just your message.${note}`;
    const people = [...new Set(real.map((m) => m.author.name.split(' ')[0]))];
    const first = real[0], last = real[real.length - 1];
    return `**${real.length} messages** from ${people.join(', ')}.\n- Started by ${first.author.name.split(' ')[0]}: "${cut(first.body)}"\n- Latest from ${last.author.name.split(' ')[0]}: "${cut(last.body)}"${note}`;
  }
  if (/todo|to do|task|action/.test(q)) {
    const items = real.filter((m) => /\b(need to|todo|will|can you|please|by (mon|tue|wed|thu|fri|tomorrow))/i.test(m.body)).slice(-5);
    return items.length ? `Things that sound like to-dos here:\n${items.map((m) => `- ${m.author.name.split(' ')[0]}: ${cut(m.body, 80)}`).join('\n')}${note}` : `I don't see any to-dos in this thread.${note}`;
  }
  return `Hi, I'm ${row.name}, ${agent.description || 'an example agent'}. Mention me with **summarise** for a recap of this thread, or **to-dos** for the action items.${modelReady ? '' : ' To give me a real model, set CHAT_MODEL_URL and CHAT_MODEL_KEY (any OpenAI-compatible server, including Ollama).'}${note}`;
}
