const COOKIE = 'ladder_admin';
const PERIODS = new Set(['15m', '1h', '4h', '24h', 'all']);
const ACTIONS = new Set(['suspend', 'resume', 'revoke']);
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function cookie(request) {
  const value = request.headers.get('cookie') || '';
  const match = value.match(/(?:^|;\s*)ladder_admin=([^;]+)/);
  try { return match ? decodeURIComponent(match[1]) : null; } catch { return null; }
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...NO_STORE, 'content-type': 'application/json; charset=utf-8' } });
}
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return origin && origin === new URL(request.url).origin;
}
async function ladder(request, apiFetch, path, token, method = 'GET', body) {
  try {
    const response = await apiFetch(new Request(new URL(path, request.url), { method,
      headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000), cache: 'no-store' }));
    if (!response.ok) return json({ error: 'Ladder вернул HTTP ' + response.status }, response.status);
    return json(await response.json());
  } catch { return json({ error: 'Ladder недоступен' }, 503); }
}
function redirect(location, setCookie) {
  return new Response(null, { status: 303, headers: { ...NO_STORE, location, ...(setCookie ? { 'set-cookie': setCookie } : {}) } });
}
function text(value, status = 200) {
  return new Response(value, { status, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } });
}

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trained Assist · Ключи и расход</title><link rel="stylesheet" href="/admin/style.css"></head><body><header><div class="brand"><span class="mark">T</span><div><strong>Trained Assist</strong><small>Администрирование ключей</small></div></div><form action="/admin/disconnect" method="post"><button class="link">Отключить ключ</button></form></header><main><div class="hero"><div><p class="eyebrow">LLM · НАБЛЮДЕНИЕ</p><h1>Расход по ключам</h1><p>Кто обращался к моделям и сколько токенов потратил.</p></div><button id="refresh" class="outline">↻ Обновить</button></div><section id="connect" class="panel connect" hidden><div class="connect-mark">⌁</div><h2>Подключите ключ администратора</h2><p>Ключ отправляется серверу сайта. JavaScript страницы его не получает. Он сохраняется в защищённом cookie текущей сессии.</p><form action="/admin/connect" method="post"><label for="key">Персональный ключ администратора</label><div class="connect-row"><input id="key" name="key" type="password" required autocomplete="off" placeholder="Вставьте ключ"><button class="primary">Подключить</button></div></form><p class="hint">Сайт закрыт для посторонних. Доступ к статистике дополнительно проверяется в Ladder.</p></section><section id="dashboard" hidden><nav class="periods" aria-label="Период"><button data-period="15m">15 минут</button><button data-period="1h" class="selected">1 час</button><button data-period="4h">4 часа</button><button data-period="24h">24 часа</button><button data-period="all">Всё время</button></nav><p id="error" class="error" hidden></p><p id="updated" class="muted">Загрузка данных…</p><div id="summary" class="summary"></div><section class="panel"><div class="section-head"><div><h2>Источники вызовов</h2><p>Одна строка на ключ, приложение и модель</p></div><span id="row-count" class="count"></span></div><div class="table-wrap"><table><thead><tr><th>Ключ / пользователь</th><th>Приложение</th><th>Модель</th><th>Тип</th><th>Вызовы</th><th>Усп. / ошибки</th><th>Вход / кэш / выход</th><th>Цена</th></tr></thead><tbody id="usage-rows"></tbody></table></div></section><section class="panel"><div class="section-head"><div><h2>Ключи пользователей</h2><p>Приостановка действует сразу; отзыв нельзя отменить.</p></div><span id="key-count" class="count"></span></div><div class="table-wrap"><table><thead><tr><th>Название</th><th>Пользователь</th><th>Статус</th><th>Последний вызов</th><th>Создан</th><th>Действия</th></tr></thead><tbody id="key-rows"></tbody></table></div></section><section class="panel issue"><div><h2>Создать ключ</h2><p>Для существующего аккаунта. Значение показывается один раз.</p></div><form id="issue-form"><label>Идентификатор пользователя<input name="user_id" required pattern="[A-Za-z0-9_-]{1,100}" placeholder="user_id"></label><label>Название ключа<input name="label" required maxlength="80" placeholder="OpenCode Mac"></label><button class="primary">Создать ключ</button></form></section></section></main><dialog id="new-key"><p class="eyebrow">НОВЫЙ КЛЮЧ</p><h2>Сохраните ключ сейчас</h2><p>После закрытия это значение больше не будет показано.</p><code id="key-value"></code><div class="dialog-actions"><button id="copy-key" class="primary">Скопировать</button><button id="close-key" class="outline">Готово</button></div></dialog><script src="/admin/app.js" defer></script></body></html>`;

const CSS = `@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;700;800&display=swap');:root{font-family:'DM Sans',sans-serif;background:#f5f7f4;color:#20332a}*{box-sizing:border-box}body{margin:0}button,input{font:inherit}button{cursor:pointer}button:disabled{opacity:.55}header{height:72px;border-bottom:1px solid #e2eae4;background:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 max(30px,calc((100vw - 1450px)/2))}.brand{display:flex;align-items:center;gap:11px}.brand strong{font:800 15px Manrope;display:block}.brand small{display:block;color:#819087;font-size:12px}.mark{background:#167457;color:#fff;border-radius:10px;display:grid;place-items:center;width:37px;height:37px;font:800 23px Manrope}.link{border:0;background:none;color:#5c7c6c;font-size:13px;font-weight:700}main{max-width:1510px;margin:auto;padding:38px 30px 70px}.hero{display:flex;justify-content:space-between;align-items:end;margin-bottom:27px}.eyebrow{color:#258665;font-size:11px;letter-spacing:.15em;font-weight:800;margin:0 0 9px}h1{font:800 clamp(27px,3vw,38px) Manrope;letter-spacing:-.04em;margin:0}h2{font:800 18px Manrope;letter-spacing:-.02em;margin:0 0 4px}.hero p:not(.eyebrow),.section-head p,.issue p,.connect p{color:#819087;font-size:13px;margin:5px 0 0}.primary,.outline{border-radius:9px;padding:10px 15px;font-size:13px;font-weight:700}.primary{background:#16775b;color:#fff;border:1px solid #16775b}.primary:hover{background:#0c6148}.outline{border:1px solid #c5d9cc;background:#fff;color:#2b7557}.outline:hover{background:#f0f7f1}.periods{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:23px}.periods button{background:#e9efea;color:#6b7c70;border:1px solid transparent;border-radius:9px;padding:9px 14px;font-size:13px;font-weight:700}.periods button.selected{background:#fff;color:#137156;border-color:#b5d4c0}.muted{font-size:12px;color:#91a097;margin:0 0 15px}.error{border:1px solid #ebc2bb;background:#fff2ef;border-radius:8px;padding:11px;color:#aa5043}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:15px;margin-bottom:22px}.panel,.metric{background:#fff;border:1px solid #e1e9e4;border-radius:14px;box-shadow:0 4px 15px #193f2509;margin-bottom:22px;overflow:hidden}.metric{padding:20px;margin:0}.metric-head{display:flex;justify-content:space-between;align-items:center;color:#8b9a91;font-size:12px}.metric-total{font:800 31px Manrope;letter-spacing:-.03em;margin:16px 0}.metric-total small{font:600 13px 'DM Sans';color:#91a097}.metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;color:#8a9990;font-size:12px}.metric-grid span{display:flex;justify-content:space-between}.metric-grid b{color:#344d3d}.metric-foot{border-top:1px solid #edf2ee;padding-top:12px;color:#8a9990;font-size:11px;margin-top:17px;line-height:1.6}.pill{display:inline-block;border-radius:6px;background:#edf1ee;color:#61766a;padding:5px 9px;font-size:11px;font-weight:800;white-space:nowrap}.pill.free,.pill.active{background:#e7f5eb;color:#298055}.pill.paid{background:#fff0e1;color:#ac6a2d}.pill.revoked{background:#fff0ef;color:#ad5147}.section-head{padding:21px 23px;border-bottom:1px solid #edf1ee;display:flex;justify-content:space-between;align-items:center}.count{background:#f2f6f3;color:#789083;font-size:12px;border-radius:6px;padding:6px 9px}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:960px;text-align:left}th{background:#fbfcfb;color:#92a198;text-transform:uppercase;font-size:10px;letter-spacing:.08em;padding:12px 19px;white-space:nowrap}td{border-top:1px solid #eef2ef;padding:14px 19px;font-size:12px;color:#51665a;vertical-align:middle}td strong{display:block;color:#22382a}td small{display:block;color:#9baa9f;margin-top:3px}td.model{max-width:215px;overflow-wrap:anywhere}td.empty{text-align:center;color:#94a49a;padding:28px}.action{border:0;background:#edf6ef;color:#2a7754;border-radius:7px;padding:7px 9px;font-size:11px;font-weight:700;margin-right:6px}.action.danger{background:#fff0ee;color:#b65449}.issue{display:flex;align-items:end;justify-content:space-between;gap:20px;padding:24px}.issue form{display:flex;align-items:end;gap:10px;flex-wrap:wrap}label{font-size:12px;color:#6b7c70;font-weight:700}input{display:block;margin-top:7px;border:1px solid #d7e4da;background:#fbfcfb;border-radius:8px;padding:10px 12px;outline-color:#81bda0;color:#263b2e;min-width:190px}.connect{max-width:560px;margin:46px auto;padding:34px}.connect-mark{background:#e3f5e9;color:#258763;border-radius:12px;width:48px;height:48px;display:grid;place-items:center;font-size:29px;margin-bottom:20px}.connect p{line-height:1.5;margin:10px 0 27px}.connect-row{display:flex;gap:10px;align-items:end}.connect-row input{flex:1}.connect .hint{font-size:11px;color:#9ca99f;margin:18px 0 0}dialog{border:1px solid #dbe9df;border-radius:14px;box-shadow:0 18px 60px #14352255;padding:28px;width:min(550px,calc(100% - 30px))}dialog::backdrop{background:#14282099}dialog p:not(.eyebrow){font-size:13px;color:#819087}dialog code{display:block;background:#f2f6f3;border:1px solid #dbe7dc;padding:14px;border-radius:8px;overflow-wrap:anywhere;margin:17px 0}.dialog-actions{display:flex;justify-content:end;gap:9px}@media(max-width:980px){.summary{grid-template-columns:1fr 1fr}.summary .metric:last-child{grid-column:span 2}.issue{display:block}.issue form{margin-top:20px}}@media(max-width:620px){header{padding:0 16px}main{padding:28px 16px}.summary{grid-template-columns:1fr}.summary .metric:last-child{grid-column:auto}.connect-row{display:block}.connect-row input,.connect-row button{width:100%;margin-top:10px}.issue form{display:block}.issue label{display:block;margin-bottom:10px}.issue input{width:100%}}`;

const APP = String.raw`const $ = (id) => document.getElementById(id);
const format = (n) => new Intl.NumberFormat('ru-RU').format(Number(n) || 0);
const date = (n) => n ? new Date(n).toLocaleString('ru-RU') : '—';
const money = (n) => n == null ? '—' : '$' + Number(n).toFixed(n < .01 ? 5 : 2);
const make = (tag, className, value) => { const e = document.createElement(tag); if (className) e.className = className; e.textContent = value == null ? '' : String(value); return e; };
const cell = (tr, value, cls) => { const e = make('td', cls, value); tr.append(e); return e; };
let period = '1h';
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
async function request(path, options) { const r = await fetch(path, { cache: 'no-store', ...options }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
async function load() {
  error(''); $('refresh').disabled = true;
  try {
    const [usage, listing] = await Promise.all([request('/admin/api/usage?period=' + period), request('/admin/api/keys')]);
    $('connect').hidden = true; $('dashboard').hidden = false;
    render(usage.rows || [], listing.keys || []);
    $('updated').textContent = 'Обновлено ' + new Date().toLocaleString('ru-RU') + ' · Время вызовов UTC';
  } catch (e) {
    if (String(e).includes('401')) { $('connect').hidden = false; $('dashboard').hidden = true; }
    else { $('connect').hidden = true; $('dashboard').hidden = false; error('Не удалось загрузить данные: ' + e.message); }
  } finally { $('refresh').disabled = false; }
}
function render(rows, keys) {
  const buckets = { free: [], paid: [], unknown: [] };
  for (const r of rows) (buckets[r.tier] || buckets.unknown).push(r);
  $('summary').replaceChildren();
  for (const [tier, title] of [['free','Бесплатные'],['paid','Платные'],['unknown','Не определено']]) {
    const items = buckets[tier]; const sum = (field) => items.reduce((n,r) => n + (Number(r[field]) || 0), 0);
    const section = make('section','metric'); const head = make('div','metric-head');
    head.append(make('span','pill ' + tier,title),make('span','',format(sum('calls')) + ' вызовов')); section.append(head);
    const total = make('div','metric-total',format(sum('tokens_in') + sum('tokens_out')) + ' '); total.append(make('small','','токенов')); section.append(total);
    const grid = make('div','metric-grid'); for (const [name,field] of [['Успешно','successful'],['Ошибки','failed'],['В ожидании','pending'],['Без usage','no_usage']]) { const line = make('span'); line.append(make('span','',name),make('b','',format(sum(field)))); grid.append(line); } section.append(grid);
    let foot = 'Вход ' + format(sum('tokens_in')) + ' · Кэш ' + format(sum('tokens_cached')) + ' · Выход ' + format(sum('tokens_out'));
    if (tier === 'paid') { const known = items.reduce((n,r) => n + (r.cost_usd == null ? 0 : Number(r.cost_usd)),0); const missing = items.reduce((n,r) => n + (r.cost_usd == null ? Number(r.calls) : 0),0); foot += ' · Известная цена ' + money(known) + (missing ? ' · ' + format(missing) + ' без цены' : ''); }
    section.append(make('div','metric-foot',foot)); $('summary').append(section);
  }
  $('row-count').textContent = format(rows.length) + ' строк'; $('usage-rows').replaceChildren();
  for (const r of rows) { const tr = document.createElement('tr'); const key = cell(tr,''); key.append(make('strong','',r.key_label || 'Общий ключ'),make('small','',(r.user_id || 'Без пользователя') + (r.key_id ? ' · ' + r.key_id : ''))); cell(tr,r.app || 'Без метки'); cell(tr,r.model || 'Неизвестна','model'); const tier = cell(tr,''); tier.append(make('span','pill ' + r.tier,r.tier === 'free' ? 'Бесплатно' : r.tier === 'paid' ? 'Платно' : '—')); cell(tr,format(r.calls)); cell(tr,format(r.successful) + ' / ' + format(r.failed)); const usageCell = cell(tr,format(r.tokens_in) + ' / ' + format(r.tokens_cached) + ' / ' + format(r.tokens_out)); if (r.no_usage) usageCell.append(make('small','',r.no_usage + ' без usage')); cell(tr,money(r.cost_usd)); $('usage-rows').append(tr); }
  if (!rows.length) { const tr = document.createElement('tr'); const td = cell(tr,'За этот период вызовов нет','empty'); td.colSpan = 8; $('usage-rows').append(tr); }
  $('key-count').textContent = format(keys.length) + ' ключей'; $('key-rows').replaceChildren();
  for (const k of keys) { const tr = document.createElement('tr'); const name = cell(tr,''); name.append(make('strong','',k.label),make('small','',k.key_id)); const user = cell(tr,k.user_id); user.append(make('small','',k.email)); const status = cell(tr,''); status.append(make('span','pill ' + k.status,k.revoked_at ? 'Отозван' : k.status === 'active' ? 'Активен' : 'Пауза')); cell(tr,date(k.last_used_at)); cell(tr,date(k.created_at)); const actions = cell(tr,''); if (!k.revoked_at) { for (const [action,label] of [[k.status === 'active' ? 'suspend' : 'resume',k.status === 'active' ? 'Приостановить' : 'Включить'],['revoke','Отозвать']]) { const b = make('button','action' + (action === 'revoke' ? ' danger' : ''),label); b.addEventListener('click',async () => { if (action === 'revoke' && !confirm('Отозвать ключ «' + k.label + '» навсегда?')) return; try { await request('/admin/api/keys/' + k.key_id + '/' + action,{method:'POST'}); await load(); } catch(e) { error('Не удалось изменить статус ключа: ' + e.message); } }); actions.append(b); } } $('key-rows').append(tr); }
  if (!keys.length) { const tr = document.createElement('tr'); const td = cell(tr,'Ключей пока нет','empty'); td.colSpan = 6; $('key-rows').append(tr); }
}
for (const b of document.querySelectorAll('[data-period]')) b.addEventListener('click',() => { period = b.dataset.period; for (const x of document.querySelectorAll('[data-period]')) x.classList.toggle('selected',x===b); load(); });
$('refresh').addEventListener('click',load);
$('issue-form').addEventListener('submit',async e => { e.preventDefault(); const form = new FormData(e.currentTarget); try { const issued = await request('/admin/api/issue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_id:form.get('user_id'),label:form.get('label')})}); $('key-value').textContent = issued.token; $('new-key').showModal(); e.currentTarget.reset(); await load(); } catch(err) { error('Не удалось создать ключ: ' + err.message); } });
$('copy-key').addEventListener('click',() => navigator.clipboard.writeText($('key-value').textContent));
$('close-key').addEventListener('click',() => { $('new-key').close(); $('key-value').textContent = ''; });
load();`;

export const adminUi = {
  async fetch(request, apiFetch) {
    const url = new URL(request.url);
    const path = url.pathname.slice('/admin'.length) || '/';
    const callLadder = (target, token, method, body) => ladder(request, apiFetch, target, token, method, body);
    if (request.method === 'GET' && path === '/') return new Response(PAGE, { headers: { ...NO_STORE, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
    if (request.method === 'GET' && path === '/style.css') return new Response(CSS, { headers: { ...NO_STORE, 'content-type': 'text/css; charset=utf-8' } });
    if (request.method === 'GET' && path === '/app.js') return new Response(APP, { headers: { ...NO_STORE, 'content-type': 'text/javascript; charset=utf-8' } });
    if (request.method === 'POST' && path === '/connect') {
      if (!sameOrigin(request)) return text('Неверный источник', 403);
      const body = await request.formData().catch(() => null);
      const token = String(body?.get('key') || '').trim();
      if (!token || token.length > 256) return redirect('/admin?error=invalid');
      const check = await callLadder('/v1/admin/keys', token);
      if (check.status !== 200) return redirect('/admin?error=access');
      return redirect('/admin', COOKIE + '=' + encodeURIComponent(token) + '; Path=/admin; HttpOnly; Secure; SameSite=Strict');
    }
    if (request.method === 'POST' && path === '/disconnect') {
      if (!sameOrigin(request)) return text('Неверный источник', 403);
      return redirect('/admin', COOKIE + '=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    }
    if (path.startsWith('/api/')) {
      const token = cookie(request);
      if (!token) return json({ error: 'Подключите ключ администратора' }, 401);
      if (request.method !== 'GET' && !sameOrigin(request)) return json({ error: 'Неверный источник' }, 403);
      if (request.method === 'GET' && path === '/api/usage') {
        const period = url.searchParams.get('period') || '1h';
        return PERIODS.has(period) ? callLadder('/v1/admin/key-usage?period=' + period, token) : json({ error: 'Неверный период' }, 400);
      }
      if (request.method === 'GET' && path === '/api/keys') return callLadder('/v1/admin/keys', token);
      const status = /^\/api\/keys\/([0-9a-f]{16})\/(suspend|resume|revoke)$/.exec(path);
      if (request.method === 'POST' && status && ACTIONS.has(status[2])) return callLadder('/v1/admin/keys/' + status[1] + '/' + status[2], token, 'POST');
      if (request.method === 'POST' && path === '/api/issue') {
        const body = await request.json().catch(() => null);
        const userId = String(body?.user_id || '');
        const label = String(body?.label || '').trim();
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(userId) || !label || label.length > 80) return json({ error: 'Неверные данные ключа' }, 400);
        return callLadder('/v1/admin/users/' + userId + '/keys', token, 'POST', { label });
      }
    }
    return text('Не найдено', 404);
  },
};
