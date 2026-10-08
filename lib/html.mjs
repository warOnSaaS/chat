export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The page every screen lives in. Screens are drawn by public/app/chat.mjs, which gets all of its data from
// the tools (/api/tools/*). The theme follows the person's preference (auto, light or dark).
// account: on the hosted copy, { url, signedIn }: the account's prompt.js asks a signed-out visitor to sign in at the
// moment they press an action (anything with data-tool), and signs them in silently when the browser already is.
export function appShell({ title = 'Chat', theme = 'auto', demo = false, version = '', account = null }) {
  const v = version ? `?v=${esc(version)}` : '';
  const viewer = !!account && !account.signedIn;
  const prompt = account ? `<script src="${esc(account.url)}/prompt.js" defer data-signed-in="${account.signedIn ? 'true' : 'false'}" data-app="Chat" data-signin="/auth/waronsaas"></script>` : '';
  return `<!doctype html><html lang="en" data-scheme="ops" data-mode="${esc(theme)}" data-shape="soft" data-type="grotesk" data-surface="bordered"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<title>${esc(title)}</title><meta name="robots" content="noindex"><meta name="theme-color" content="#0b0b0b">
<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/icon-192.png">
<link rel="preload" href="/ui/fonts/geist.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/ui/src/ui.css${v}"><link rel="stylesheet" href="/ui/src/tokens.css${v}"><link rel="stylesheet" href="/app/chat.css${v}">
${prompt}</head><body class="chat${demo ? ' is-demo' : ''}${viewer ? ' is-viewer' : ''}"><div id="app" aria-busy="true"></div>
<script>window.CHAT=${JSON.stringify({ demo, version, account: !!account, viewer }).replace(/</g, '\\u003c')}</script>
<script type="module" src="/app/page.mjs${v}"></script></body></html>`;
}
