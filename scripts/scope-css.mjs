// Scopes a style sheet to one root class, so an app's styles inside the suite cannot reach the shell or
// other apps. Every selector gets the root in front (a selector that already starts with the root keeps
// it); rules on html or body are dropped, since the page belongs to the suite. @media and @supports
// blocks are scoped inside; @keyframes and @font-face are left as they are. No dependencies.
export function scopeCss(css, root) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let i = 0;
  const splitSelectors = (s) => {
    const parts = []; let depth = 0; let cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean);
  };
  const scopeSel = (sel) => {
    if (/^(html|body|:root)\b/.test(sel)) return null;
    if (sel.startsWith(root)) return sel;
    return `${root} ${sel}`;
  };
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) { out += css.slice(i); break; }
    const head = css.slice(i, open).trim();
    // find the matching close brace
    let depth = 1; let j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    const body = css.slice(open + 1, j - 1);
    if (/^@(media|supports|container|layer)\b/.test(head)) out += `${head}{${scopeCss(body, root)}}`;
    else if (head.startsWith('@')) out += `${head}{${body}}`;
    else {
      const sels = splitSelectors(head).map(scopeSel).filter(Boolean);
      if (sels.length) out += `${sels.join(',')}{${body.trim()}}`;
    }
    i = j;
  }
  return out;
}
