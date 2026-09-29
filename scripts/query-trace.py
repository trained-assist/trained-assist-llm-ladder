#!/usr/bin/env python3
"""Read-only query over the D1 trace log (ladder_calls) via the Cloudflare D1 REST API.

Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, PRESET, VALUE, HOURS, LIMIT, SQL.
Presets: recent | trace | user | chat | session | summary | sql (free read-only SELECT).
"""
import json, os, re, sys, time, urllib.request, urllib.error

DB_NAME = 'trained-assist-llm-ladder-trace'
COLS = {'trace': 'trace_id', 'user': 'user_id', 'chat': 'chat_id', 'session': 'session_id'}
ROW = ("datetime(ts/1000,'unixepoch') AS utc, trace_id, run_id, user_id, chat_id, session_id, "
       "ladder, ok, model, ms, tokens_in, tokens_out")


def build(preset, value, hours, limit, sql):
    since = int((time.time() - hours * 3600) * 1000)
    if preset == 'sql':
        return guard(sql), []
    if preset == 'recent':
        return f'SELECT {ROW} FROM ladder_calls WHERE ts >= ?1 ORDER BY ts DESC LIMIT {limit}', [since]
    if preset in COLS:
        if not value:
            raise ValueError(f'preset {preset} needs value')
        return (f'SELECT {ROW} FROM ladder_calls WHERE {COLS[preset]} = ?1 AND ts >= ?2 '
                f'ORDER BY ts DESC LIMIT {limit}'), [value, since]
    if preset == 'summary':
        # "Жирные" сессии: вызовы и токены на (user, chat, trace, session) за окно.
        return ('SELECT user_id, chat_id, trace_id, session_id, COUNT(*) AS calls, SUM(1-ok) AS failed, '
                'SUM(COALESCE(tokens_in,0)) AS tokens_in, SUM(COALESCE(tokens_out,0)) AS tokens_out, '
                "datetime(MIN(ts)/1000,'unixepoch') AS first_utc, datetime(MAX(ts)/1000,'unixepoch') AS last_utc "
                'FROM ladder_calls WHERE ts >= ?1 GROUP BY user_id, chat_id, trace_id, session_id '
                f'ORDER BY calls DESC LIMIT {limit}'), [since]
    raise ValueError(f'unknown preset {preset}')


def guard(sql):
    s = (sql or '').strip().rstrip(';').strip()
    if not re.match(r'(?is)^(select|with)\b', s) or ';' in s:
        raise ValueError('only a single read-only SELECT/WITH statement is allowed')
    if re.search(r'(?i)\b(insert|update|delete|drop|alter|create|replace|attach|pragma|vacuum)\b', s):
        raise ValueError('write/DDL keywords are not allowed')
    return s


def api(path, payload=None):
    base = f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}"
    req = urllib.request.Request(base + path, method='POST' if payload is not None else 'GET',
                                 data=json.dumps(payload).encode() if payload is not None else None,
                                 headers={'Authorization': f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}",
                                          'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f'HTTP {e.code}: {e.read().decode()[:2000]}')


def main():
    preset = (os.environ.get('PRESET') or 'recent').strip()
    hours = float(os.environ.get('HOURS') or 24)
    limit = max(1, min(int(os.environ.get('LIMIT') or 50), 1000))
    sql, params = build(preset, (os.environ.get('VALUE') or '').strip(), hours, limit, os.environ.get('SQL'))
    dbs = api(f'/d1/database?name={DB_NAME}')['result']
    db = next((d for d in dbs if d.get('name') == DB_NAME), None)
    if not db:
        sys.exit(f'D1 database {DB_NAME} not found')
    print(f'-- {preset} hours={hours} limit={limit}\n-- {sql}\n-- params={params}')
    res = api(f"/d1/database/{db['uuid']}/query", {'sql': sql, 'params': params})
    rows = (res.get('result') or [{}])[0].get('results') or []
    print(f'rows: {len(rows)}')
    if not rows:
        return
    cols = list(rows[0].keys())
    print('\t'.join(cols))
    for r in rows:
        print('\t'.join('' if r.get(c) is None else str(r.get(c)) for c in cols))


if __name__ == '__main__':
    try:
        main()
    except ValueError as e:
        sys.exit(f'error: {e}')
