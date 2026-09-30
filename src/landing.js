// Server-rendered page for /u/{uid} (issue #53 makes it reachable; issue #54 owns the
// marketing copy). Kept as a plain function of (uid, providers) so #54 can replace the
// markup without touching the routing that already depends on this path.
//
// Functional and unstyled on purpose: the buttons below are the flow that #54's landing
// will point at, so they must work before the design lands.

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function landingHtml(uid, providers, { baseUrl = '', status = null, error = null } = {}) {
  const rows = Object.entries(providers).map(([id, p]) => `
    <li>
      <form method="post" action="${baseUrl}/u/${esc(uid)}/connect">
        <input type="hidden" name="provider" value="${esc(id)}">
        <button type="submit">${esc(p.label)}</button>
        <span class="where">${esc(p.where)}</span>
      </form>
    </li>`).join('');

  const notice = error
    ? `<p class="error">${esc(error)}</p>`
    : status ? `<p class="status">${esc(status)}</p>` : '';

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>LLM-ladder — подключить ключ</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem;max-width:44rem}
h1{font-size:1.4rem;margin:0 0 .4rem}
p.sub{opacity:.75;margin-top:0}
ul{list-style:none;padding:0;display:grid;gap:.6rem}
li form{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}
button{font:inherit;padding:.5rem .9rem;border-radius:.5rem;border:1px solid #8884;background:transparent;cursor:pointer}
button:hover{border-color:currentColor}
.where{opacity:.65;font-size:.9rem}
.uid{opacity:.5;font-size:.8rem;word-break:break-all}
.error{color:#c33}
.status{color:#2a7}
</style></head><body>
<h1>LLM-ladder — подключить свой ключ</h1>
<p class="sub">Ключ уходит сразу в хранилище через ZeroCreds и не попадает в модель.</p>
${notice}
<ul>${rows}</ul>
<p class="uid">uid: ${esc(uid)}</p>
</body></html>`;
}
