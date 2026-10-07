import MarkdownIt from 'markdown-it';

// Messages are markdown. Raw HTML is off, so a message can never inject markup; links open in a new tab.
// @handles that belong to someone on the team become mention chips.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
const defaultLink = md.renderer.rules.link_open ?? ((t, i, o, e, self) => self.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer nofollow');
  return defaultLink(tokens, idx, opts, env, self);
};
md.disable(['image', 'heading', 'lheading', 'hr', 'table']);

const MENTION = /(^|[^\w@])@([a-z0-9][a-z0-9._-]{0,39})/gi;
const SPECIAL = new Set(['channel', 'here', 'everyone']);

md.core.ruler.push('mentions', (state) => {
  const handles = state.env?.handles;
  if (!handles) return;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const out = [];
    let inLink = 0;
    for (const t of block.children) {
      if (t.type === 'link_open') inLink++;
      if (t.type === 'link_close') inLink--;
      if (t.type !== 'text' || inLink) { out.push(t); continue; }
      let last = 0;
      const text = t.content;
      for (const m of text.matchAll(MENTION)) {
        const h = m[2].toLowerCase().replace(/[._-]+$/, '');
        if (!handles.has(h) && !SPECIAL.has(h)) continue;
        const start = m.index + m[1].length;
        if (start > last) { const x = new state.Token('text', '', 0); x.content = text.slice(last, start); out.push(x); }
        const chip = new state.Token('html_inline', '', 0);
        chip.content = `<span class="mention" data-handle="${h}">@${h}</span>`;
        out.push(chip);
        last = start + 1 + h.length;
      }
      if (last === 0) { out.push(t); continue; }
      if (last < text.length) { const x = new state.Token('text', '', 0); x.content = text.slice(last); out.push(x); }
    }
    block.children = out;
  }
});

export const renderMarkdown = (body, handles = new Set()) => md.render(String(body ?? ''), { handles });

// Which handles a message mentions (lowercase), including channel, here and everyone.
export function mentionedHandles(body) {
  const plain = String(body ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  return [...new Set([...plain.matchAll(MENTION)].map((m) => m[2].toLowerCase().replace(/[._-]+$/, '')))];
}
export const isEveryone = (h) => SPECIAL.has(h);
