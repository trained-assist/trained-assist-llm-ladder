#!/usr/bin/env python3
"""Обезличивание обменов лестницы `conversations` → датасет для бенчмарка.

Зачем: src/… не пишет промпты в D1 (только токены), а живой лог обменов
`~/agent-data/hh/conversation-history.jsonl` на VM содержит реальных кандидатов.
Чтобы гонять модели на одних и тех же входах и сравнивать, нужен датасет, из
которого вычищены люди и компании, но НЕ порезан контекст.

Что заменяется (всё это идентификаторы людей/компаний):
  * имена и фамилии — во всех падежах (Владимир / Владимира / Владимиром);
  * отчества (Вагифовна, Аркадьевич);
  * имена в переписке: «Рекрутер: …», «Кандидат: …», «имя: …»;
  * агентство и компании-заказчики (HR Stalker, ТБанк, DPD, …);
  * hh-хеши резюме, телефоны, почта, телеграм-ники, ссылки на конкретные
    вакансии/магазины/документы.

Чего скрипт НЕ делает — намеренно:
  * не режет историю переписки и резюме. Кандидат отвечает «да» на вопрос,
    который уже задавали, и письмо едет; опыт/навыки могут стоять в самом
    конце резюме, и обрезанный вход задаст вопрос, который уже закрыт.
  * не подменяет инструменты и навыки (Autocad, Bitrix, 1С) — они не PII и
    делают вход реалистичным; подмена сломала бы бенчмарк.
  * не меняет структуру промпта: те же секции, маркеры и переводы строк.
    Бенчмарк должен видеть ровно ту форму входа, что ушла в модель.

Замена детерминирована (sha256 от самого имени) — прогоны воспроизводимы,
иначе результаты бенчмарка несравнимы между запусками.

Использование:
    python3 scripts/anonymize-conversation-bench.py raw.jsonl bench-dataset.jsonl \\
        [--vocab vocab.json] [--limit N]
    python3 scripts/analyze-conversation-prompts.py bench-dataset.jsonl
"""
import hashlib
import json
import re
import sys

# ── пулы синтетики ───────────────────────────────────────────────────────────
FIRST_F = ["Анна", "Мария", "Ольга", "Елена", "Татьяна", "Ирина", "Надежда",
           "Людмила", "Галина", "Вера", "Ксения", "Дарья", "Полина", "Юлия"]
FIRST_M = ["Артём", "Сергей", "Дмитрий", "Андрей", "Алексей", "Николай", "Пётр",
           "Максим", "Евгений", "Роман", "Виктор", "Тимур", "Илья", "Марк"]
LAST_F = ["Ковалёва", "Мельникова", "Зайцева", "Богданова", "Орлова", "Соколова",
          "Данилова", "Кузьмина", "Новикова", "Романова", "Фёдорова", "Беляева"]
LAST_M = ["Ковалёв", "Мельников", "Зайцев", "Богданов", "Орлов", "Соколов",
          "Данилов", "Кузьмин", "Новиков", "Романов", "Фёдоров", "Беляев"]
GENERIC_COMPANY = [
    "ООО «ТехноЛайн»", "ООО «Ретэйл Мастер»", "ООО «Северный Путь»",
    "ООО «Агат Маркетинг»", "ООО «Прогресс Софт»", "ООО «Вектор Трейд»",
    "ООО «Спектр Медиа»", "ООО «Оптима Логистик»", "ООО «Гранит Сервис»",
    "ООО «Заря Инжиниринг»", "ООО «Вектор Групп»", "ООО «Пласт Форма»",
]

MALE_HINTS = ("ов", "ев", "ин", "ын", "ий", "ый", "ой", "ум", "ем", "ом",
              "андре", "алексе", "дмитр", "серге", "максим", "артём", "пётр",
              "роман", "юрий")

# ── паттерны PII ─────────────────────────────────────────────────────────────
URL_RE = re.compile(r"https?://[^\s)\]\">«]+")
VAC_URL_RE = re.compile(r"https?://[^\s)\]\">«]*hh\.ru/resume/[^\s)\]\">«]*")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]{2,}")
PHONE_RE = re.compile(r"(?:\+7|8)[\s\-()]{0,3}\d{3}[\s\-()]{0,3}\d{3}[\s\-]{0,2}\d{2}[\s\-]{0,2}\d{2}")
TG_RE = re.compile(r"(?<![\w@])@[A-Za-z_][A-Za-z0-9_]{3,}")
HEX_RE = re.compile(r"\b[0-9a-f]{32,64}\b")
PATRONYMIC_RE = re.compile(r"\b[А-ЯЁ][а-яё]{3,}(?:вна|евна|ична|инична|ович|евич)\b")
# Имя/фамилия в переписке: «Рекрутер: …», «Кандидат: …»
NAMED_RE = re.compile(
    r"(?P<pre>(?:Рекрутер|Кандидат|Пользователь|Отправитель|Получатель|Соискатель)"
    r"\s*[:—-]\s*)(?P<first>[А-ЯЁ][а-яё]+)(?:\s+(?P<last>[А-ЯЁ][а-яё-]+))?"
)
# Компании: «компании X», «агентства X», «рекрутер X»
COMPANY_RE = re.compile(
    r"(?P<pre>\b(?:компани[ияию]|агентств[аоуе]|рекрутер[аеу]?|заказчик[аеу]?)\s+)"
    r"(?P<name>[А-ЯЁA-Z][А-Яа-яЁёA-Za-z][\wА-Яа-яЁёA-Za-z-]*(?:\s+[А-ЯЁA-Z][\w-]+){0,2})"
)
COMPANY_STOP = {
    "x", "нашей", "этой", "нашего", "моей", "вашей", "своей", "компания",
    "агентство", "рекрутер", "заказчик", "компании", "агентства", "клиент",
    "вакансия", "вакансии", "кандидат", "резюме", "история", "задача",
    "инструкция", "тестовое", "действие", "доступность", "контекст", "опыт",
    "факты", "процесс", "профиль", "письмо", "сообщение", "переписка",
    "встреча", "звонок", "собеседование", "зарплата", "график", "локация",
}
# Бренды из текста вакансий/резюме — заменяем явно.
COMPANY_SEED = [
    "ТБанк", "Детский Мир", "Озон", "Ozon", "СМ Клиник", "Lemon Media",
    "MarketGuru", "HR Stalker", "DPD", "Wildberries",
]


def h(s):
    return int(hashlib.sha256(s.encode("utf-8")).hexdigest(), 16)


def looks_male(first):
    f = (first or "").lower()
    return any(f.endswith(x) or x in f for x in MALE_HINTS)


def fake_person(seed_first, seed_last=None):
    male = looks_male(seed_first)
    firsts = FIRST_M if male else FIRST_F
    first = firsts[h("fn" + seed_first) % len(firsts)]
    if seed_last:
        lasts = LAST_M if male else LAST_F
        return first + " " + lasts[h("ln" + seed_last) % len(lasts)]
    return first


def discover(text):
    """Собрать реальные имена/компании, которые встречаются в данных."""
    people, companies = set(), set()
    for m in NAMED_RE.finditer(text):
        people.add(m.group("first"))
        if m.group("last"):
            people.add(m.group("last"))
    # Отчество → основа (Вагифовна → Вагиф), суффикс добавим при замене.
    for m in PATRONYMIC_RE.finditer(text):
        people.add(re.sub(r"(вна|евна|ична|инична|ович|евич)$", "", m.group(0)))
    for m in COMPANY_RE.finditer(text):
        nm = m.group("name").strip()
        if len(nm) > 2 and nm.lower() not in COMPANY_STOP:
            companies.add(nm)
    for seed in COMPANY_SEED:
        if seed in text:
            companies.add(seed)
    # Остаточные связки ЗАГЛАВНЫХ слов — имена собственные в русском тексте.
    for m in re.finditer(r"\b[А-ЯЁ][а-яё]{2,}(?:\s+[А-ЯЁ][а-яё-]{2,}){0,1}\b", text):
        token = m.group(0)
        if token.split()[0] not in COMPANY_STOP and len(token) > 4:
            companies.add(token)
    return people, companies


def build_maps(people, companies):
    """Слово → фейк. Фамилии и имена разводим по отдельным пулам."""
    pmap, cmap = {}, {}
    for name in sorted(people):
        male = looks_male(name)
        pool_f = FIRST_M if male else FIRST_F
        pool_l = LAST_M if male else LAST_F
        if name.endswith(("ов", "ев", "ин", "ын", "ий", "ый", "ой", "ая", "яя")):
            pmap[name] = pool_l[h("l" + name) % len(pool_l)]
        else:
            pmap[name] = pool_f[h("f" + name) % len(pool_f)]
    for name in sorted(companies):
        cmap[name] = GENERIC_COMPANY[h("c" + name) % len(GENERIC_COMPANY)]
    return pmap, cmap


def build_pattern(pmap, cmap):
    """Один объединённый regex на все сущности + таблица замен.

    На каждую сущность×7 падежей отдельный re.sub даёт ~10^6 компиляций
    регулярок на 669 обменах (минуты wall-clock). Здесь паттерн строится
    один раз, подстановка идёт за один проход.
    """
    table = {}
    # Компании — длинные первыми, иначе «Lemon Media» распадётся на «Lemon».
    for real in sorted(cmap, key=len, reverse=True):
        table[real] = cmap[real]
    for real in sorted(pmap, key=len, reverse=True):
        fake = pmap[real]
        table[real] = fake
        for suf in ("вна", "евна", "ична", "инична", "ович", "евич"):
            table[real + suf] = fake + suf
        # Падежные формы имени: у гласных/шипящих окончание другое.
        table[real + "а"] = fake + ("а" if fake[-1] in "жшчщ" else "а")
        table[real + "у"] = fake + ("у" if fake[-1] not in "жшшщ" else "е")
        table[real + "ом"] = fake + ("ом" if fake[-1] not in "жшшщ" else "ем")
        table[real + "е"] = fake + "е"
        table[real + "ы"] = fake + ("ы" if fake[-1] in "жшшщ" else "и")
        table[real + "ов"] = fake + ("ов" if fake[-1] not in "жшшщ" else "ев")
    keys = sorted(table, key=len, reverse=True)
    pattern = re.compile(
        r"(?<![\w-])(?:" + "|".join(re.escape(k) for k in keys) + r")(?![\w-])"
    )
    return pattern, table


def anonymize(text, pattern, table):
    """Обезличить один текст. Структура (маркеры, переводы строк) не меняется."""
    if not text:
        return text
    out = VAC_URL_RE.sub("https://hh.ru/resume/<скрыто>", text)

    def url_repl(m):
        u = m.group(0)
        if "hh.ru/resume" in u:
            return "https://hh.ru/resume/<скрыто>"
        if "recruiter-assistant.ru" in u:
            return "https://recruiter-assistant.ru/p/<скрыто>"
        if "t.me" in u:
            return "https://t.me/<скрыто>"
        if "google" in u:
            return "https://docs.google.com/<скрыто>"
        host = re.sub(r"^https?://(www\.)?", "", u).split("/")[0]
        return f"https://{host}/<скрыто>"

    out = URL_RE.sub(url_repl, out)
    out = EMAIL_RE.sub("<почта-скрыта>", out)
    out = PHONE_RE.sub("<телефон-скрыт>", out)
    out = TG_RE.sub("@<ник-скрыт>", out)
    out = HEX_RE.sub("<хэш-скрыт>", out)
    # Одна подстановка по объединённой таблице вместо тысячи отдельных regex.
    out = pattern.sub(lambda m: table.get(m.group(0), m.group(0)), out)

    def named_repl(m):
        return m.group("pre") + fake_person(m.group("first"), m.group("last"))

    return NAMED_RE.sub(named_repl, out)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    rows = [json.loads(l) for l in open(src, encoding="utf-8") if l.strip()]
    if "--limit" in sys.argv:
        rows = rows[-int(sys.argv[sys.argv.index("--limit") + 1]):]

    text = "\n".join(m["content"] for r in rows for m in r["messages"])
    people, companies = discover(text)
    pmap, cmap = build_maps(people, companies)
    pattern, table = build_pattern(pmap, cmap)

    if "--vocab" in sys.argv:
        path = sys.argv[sys.argv.index("--vocab") + 1]
        json.dump({"people": sorted(people), "companies": sorted(companies),
                   "people_map": pmap, "companies_map": cmap},
                  open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    n = 0
    with open(dst, "w", encoding="utf-8") as fh:
        for r in rows:
            msgs = [{"role": m["role"], "content": anonymize(m["content"], pattern, table)}
                    for m in r.get("messages", [])]
            fh.write(json.dumps({
                "ts": r.get("ts"),
                "ladder": r.get("ladder"),
                "model": r.get("model"),
                "temperature": r.get("temperature"),
                "messages": msgs,
                "answer": anonymize(r.get("answer") or "", pattern, table),
                "orig_chars": {
                    "system": len(next((m["content"] for m in msgs if m["role"] == "system"), "")),
                    "user": len(next((m["content"] for m in msgs if m["role"] == "user"), "")),
                    "answer": len(r.get("answer") or ""),
                },
            }, ensure_ascii=False) + "\n")
            n += 1
    print(f"обменов: {n} → {dst}")
    print(f"сущностей в словаре: {len(people)} имён/фамилий, {len(companies)} компаний")


if __name__ == "__main__":
    main()