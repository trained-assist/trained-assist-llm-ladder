#!/usr/bin/env python3
"""Структурный разбор входных промптов лестницы `conversations`.

Работает и на сыром логе, и на обезличенном датасете из
scripts/anonymize-conversation-bench.py — структура промпта там сохранена.

Источник: лог обменов hh-skill (prod ~/agent-data/hh/conversation-history.jsonl на VM)
или обезличенный датасет из scripts/anonymize-conversation-bench.py.

Задача — не «сократить», а измерить: из чего складывается вход модели и сколько
свободного места остаётся до лимита контекста. Ничего не выкидывается — резать
историю/резюме нельзя (кандидат ответит «да» на вопрос, который уже задавали, и
переписка поедет). Выводы → размер секций + запас до лимита.

Использование:
    python3 scripts/analyze-conversation-prompts.py raw.jsonl
"""
import json
import re
import statistics
import sys

# Лимиты контекста ступеней лестницы `conversations` (config/ladders.json).
CTX_LIMITS = {
    "google/gemini-3.1-flash-lite-preview": 1_048_576,
    "google/gemini-2.5-flash": 1_048_576,
    "opencode-go/mimo-v2.6-flash": 1_000_000,
}

# Калибровка chars -> tokens по Ground Truth из D1: секция лестницы отдаёт
# usage.prompt_tokens. Подставляется measured (см. calibrate()).
SYSTEM_HDR = re.compile(r"^##\s+(.+?)\s*$", re.M)


def split_sections(text, markers):
    """Разрезать текст на секции по маркерам-строкам.

    markers — список (имя_секции, префикс_строки). Первый совпавший маркер
    открывает секцию и забирает всё до следующего маркера. Текст до первого
    маркера — секция 'preamble' (фиксированная проза промпта).
    """
    hits = []
    for name, prefix in markers:
        m = re.search(r"^" + re.escape(prefix), text, re.M)
        if m:
            hits.append((m.start(), name))
    hits.sort()
    out = {}
    if not hits:
        return {"body": text} if text.strip() else {}
    if hits[0][0] > 0:
        pre = text[: hits[0][0]]
        if pre.strip():
            out["preamble"] = pre
    for i, (pos, name) in enumerate(hits):
        end = hits[i + 1][0] if i + 1 < len(hits) else len(text)
        chunk = text[pos:end]
        # Заголовок секции не считаем содержимым — он 1 строка.
        out[name] = chunk
    return out


SYS_MARKERS = [
    ("vacancy", "## Контекст вакансии"),
    ("identity", "## Идентичность рекрутера"),
    ("style", "## Стиль общения рекрутера"),
    ("vacancy_instruction", "## Инструкция для этой вакансии"),
]

USR_MARKERS = [
    ("resume", "Резюме:\n"),
    ("resume_facts", "Факты из резюме"),
    ("context", "Контекст:\n"),
    ("ats", "ATS-оценка:"),
    ("history", "История переписки:"),
    ("test_task", "Суть задания"),
    ("funnel_action", "Действие воронки"),
    ("instruction", "Инструкция для этой вакансии:"),
    ("availability", "Доступность для звонка"),
]

ANS_MARKERS = [("letter", "Напиши следующее сообщение")]


def classify_user(part):
    """Одна секция может матчиться несколькими маркерами — оставить длиннейшую."""
    if not part:
        return part
    return part


def analyse(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def collect(rows):
    """Разложить каждый обмен по секциям, посчитать символы."""
    per_exchange = []
    for r in rows:
        msgs = r.get("messages") or []
        system = next((m["content"] for m in msgs if m["role"] == "system"), "")
        user = next((m["content"] for m in msgs if m["role"] == "user"), "")
        answer = r.get("answer") or ""
        rec = {
            "model": r.get("model"),
            "ts": r.get("ts"),
            "system_chars": len(system),
            "user_chars": len(user),
            "answer_chars": len(answer),
            "input_chars": len(system) + len(user),
            "sections": {},
        }
        for name, chunk in split_sections(system, SYS_MARKERS).items():
            rec["sections"]["system." + name] = len(chunk)
        for name, chunk in split_sections(user, USR_MARKERS).items():
            rec["sections"]["user." + name] = len(chunk)
        # Хвост письма-инструкции, который не попал ни под один маркер.
        covered = sum(
            len(v)
            for k, v in split_sections(user, USR_MARKERS).items()
        )
        rec["sections"]["user.unmarked"] = max(0, rec["user_chars"] - covered)
        per_exchange.append(rec)
    return per_exchange


def pct_table(per_exchange, char_to_token):
    """Агрегаты по секциям: mean / median / p90 токенов и доля."""
    keys = set()
    for rec in per_exchange:
        keys |= set(rec["sections"].keys())
    rows = []
    total_mean = statistics.fmean(
        rec["input_chars"] * char_to_token for rec in per_exchange
    )
    for k in keys:
        vals = [rec["sections"].get(k, 0) * char_to_token for rec in per_exchange]
        mean = statistics.fmean(vals)
        rows.append(
            {
                "section": k,
                "mean_tok": mean,
                "median_tok": statistics.median(vals),
                "p90_tok": sorted(vals)[int(len(vals) * 0.9)],
                "share": mean / total_mean * 100 if total_mean else 0,
                "present_pct": sum(1 for v in vals if v > 0) / len(vals) * 100,
            }
        )
    rows.sort(key=lambda r: -r["mean_tok"])
    return rows, total_mean


def calibrate(per_exchange, measured_mean_tokens):
    """Подобрать chars->tokens так, чтобы средний вход совпал с D1."""
    mean_chars = statistics.fmean(rec["input_chars"] for rec in per_exchange)
    return measured_mean_tokens / mean_chars if mean_chars else 0.0


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "raw.jsonl"
    measured_mean = float(sys.argv[2]) if len(sys.argv) > 2 else 3278.0
    rows = analyse(path)
    per_exchange = collect(rows)

    print(f"Обменов: {len(per_exchange)}")
    print(f"Калибровка chars->tokens по D1 ({measured_mean:.0f} токенов/вызов):")
    c2t = calibrate(per_exchange, measured_mean)
    print(f"  средний вход: {statistics.fmean(r['input_chars'] for r in per_exchange):.0f} символов")
    print(f"  коэффициент: {c2t:.4f} токенов/символ\n")

    rows_out, total = pct_table(per_exchange, c2t)
    print(f"{'секция':<34}{'mean':>9}{'median':>9}{'p90':>9}{'доля':>8}{'есть в':>9}")
    print("-" * 78)
    for r in rows_out:
        print(
            f"{r['section']:<34}{r['mean_tok']:>9.0f}{r['median_tok']:>9.0f}"
            f"{r['p90_tok']:>9.0f}{r['share']:>7.1f}%{r['present_pct']:>8.0f}%"
        )
    print("-" * 78)
    print(f"{'ВХОД (system+user)':<34}{total:>9.0f}")

    print("\nЗапас до лимита контекста:")
    inputs = [r["input_chars"] * c2t for r in per_exchange]
    for model, limit in CTX_LIMITS.items():
        used = sorted(inputs)
        p50 = used[len(used) // 2]
        p99 = used[int(len(used) * 0.99)]
        mx = used[-1]
        print(
            f"  {model:<42} лимит {limit:>9,}  "
            f"p50 {p50/limit*100:6.2f}%  p99 {p99/limit*100:6.2f}%  max {mx/limit*100:6.2f}%"
        )

    answers = sorted(r["answer_chars"] * c2t for r in per_exchange)
    print(
        f"\nОтвет: mean {statistics.fmean(answers):.0f} · "
        f"median {statistics.median(answers):.0f} · p90 {answers[int(len(answers)*0.9)]:.0f} токенов"
    )
    print(f"Доля ответа во входе: {statistics.fmean(answers)/total*100:.1f}%")


if __name__ == "__main__":
    main()