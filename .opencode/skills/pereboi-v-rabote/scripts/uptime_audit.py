#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пункт 4.2 «Перебои в работе сайта» (технический SEO-аудит, методология «Текарт»).

Запускает бесплатную проверку доступности сайта на ping-admin.com/free_test/ только из точек РФ,
дожидается результата, разбирает его и формирует отчёт:
  - «Перебои в работе сайта.docx» — подводка, ссылка на результат проверки, вывод (проблем нет /
    проблемы и как исправить).

Запуск:
  python3 uptime_audit.py --url https://www.roysol.ru/ --out-dir /путь [--timeout 240]
"""
import argparse
import os
import re
import sys
import time
from datetime import datetime

try:
    import requests
except ImportError:
    sys.exit("Нужен requests: pip3 install --break-system-packages requests")
try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Нужен beautifulsoup4: pip3 install --break-system-packages requests beautifulsoup4")
try:
    from docx import Document
    from docx.shared import Pt, RGBColor
except ImportError:
    sys.exit("Нужен python-docx: pip3 install --break-system-packages python-docx")

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept-Language": "ru-RU,ru;q=0.9"}
BASE = "https://ping-admin.com"
FREE = BASE + "/free_test/"
SUBMIT = BASE + "/index.sema"


def run_free_test(url, timeout=240):
    """Запускает тест (только РФ), возвращает (result_url, points, html, csv_url)."""
    sess = requests.Session()
    r = sess.get(FREE, headers={**UA, "Referer": FREE}, timeout=60)
    r.encoding = "windows-1251"
    soup = BeautifulSoup(r.text, "html.parser")
    inp = soup.find("input", attrs={"name": "a", "value": "do_free_test"})
    if not inp:
        raise RuntimeError("Не найдена форма бесплатной проверки")
    form = inp.find_parent("form")
    ru = [el.get("name") for el in form.find_all("input") if (el.get("name") or "").startswith("ru")]
    if not ru:
        raise RuntimeError("Не найдены точки РФ (ru*)")

    data = {"a": "do_free_test", "sa": "begin_test_new", "tip": "https", "url": url,
            "free_test_but1": "Начать проверку"}
    for n in ru:
        data[n] = "1"  # только точки РФ

    r2 = sess.post(SUBMIT, data=data, headers={**UA, "Referer": FREE, "Origin": BASE}, timeout=120)
    r2.encoding = "windows-1251"
    links = re.findall(r"/free_test/result/[0-9a-z]+\.html", r2.text)
    if not links:
        raise RuntimeError("Сервис не вернул ссылку на результат (возможно, запрос отклонён)")
    result_url = BASE + links[0]

    # поллинг до появления данных
    start = time.time()
    html = ""
    points = []
    while time.time() - start < timeout:
        rr = sess.get(result_url, headers={**UA, "Referer": FREE}, timeout=60)
        rr.encoding = "windows-1251"
        html = rr.text
        points = parse_points(html)
        if points:
            break
        time.sleep(10)
    csv = re.findall(r"/free_test/result/[0-9a-z]+\.csv", html)
    return result_url, points, html, (BASE + csv[0] if csv else "")


def parse_points(html):
    """Разбирает таблицу результатов: список точек с временем."""
    s = BeautifulSoup(html, "html.parser")
    for tb in s.find_all("table"):
        head = tb.find("tr")
        if not head or "Точка мониторинга" not in head.get_text(" ", strip=True):
            continue
        out = []
        for tr in tb.find_all("tr")[1:]:
            tds = tr.find_all("td", recursive=False)
            if len(tds) < 3:
                continue
            name = tds[0].get_text(" ", strip=True).split(" При поддержке")[0].strip()
            if not name:
                continue
            ip = tds[1].get_text(" ", strip=True)
            tm_raw = tds[2].get_text(" ", strip=True)
            m = re.match(r"([\d.,]+)", tm_raw.replace("\xa0", " "))
            total = float(m.group(1).replace(",", ".")) if m else None
            ok = total is not None
            out.append({"point": name, "ip": ip, "total": total, "ok": ok})
        if out:
            return out
    return []


def run_checkhost(url, timeout=120):
    """Фолбэк: проверка доступности с узлов РФ через check-host.net. Возвращает (report_url, points)."""
    H = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    try:
        nodes = requests.get("https://check-host.net/check-http",
                             params={"host": url, "max_nodes": "50"}, headers=H, timeout=30).json().get("nodes", {})
    except Exception:
        return "", []
    ru = [k for k, v in nodes.items() if str(v[0]).lower() == "ru"]
    if not ru:
        return "", []
    params = [("host", url)] + [("node", n) for n in ru]
    try:
        rid = requests.get("https://check-host.net/check-http", params=params, headers=H, timeout=30).json().get("request_id")
    except Exception:
        return "", []
    if not rid:
        return "", []
    rr = {}
    start = time.time()
    while time.time() - start < timeout:
        time.sleep(6)
        try:
            rr = requests.get(f"https://check-host.net/check-result/{rid}", headers=H, timeout=30).json()
        except Exception:
            continue
        if rr and all(v is not None for v in rr.values()):
            break
    points = []
    for node, res in rr.items():
        if not res:
            points.append({"point": node, "ip": "", "total": None, "ok": False})
            continue
        v = res[0] if isinstance(res, list) and res else None
        if not v:
            points.append({"point": node, "ip": "", "total": None, "ok": False})
            continue
        code = str(v[0]); status = str(v[2]) if len(v) > 2 else ""
        t = v[1] if len(v) > 1 else None
        ok = (code == "1" and status == "OK")
        points.append({"point": node.replace(".node.check-host.net", ""), "ip": (v[4] if len(v) > 4 and v[4] else ""),
                       "total": round(float(t), 2) if isinstance(t, (int, float)) and ok else None, "ok": ok,
                       "status": status})
    return "https://check-host.net/check-report/" + rid, points


def set_font(run, size, color=None):
    run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = color


def build_docx(path, base, summary):
    doc = Document()
    doc.styles["Normal"].font.size = Pt(10)
    doc.styles["Normal"].font.name = "Calibri"
    doc.add_paragraph()
    t = doc.add_paragraph(); r = t.add_run(f"Технический аудит сайта {base}")
    set_font(r, 24, RGBColor(0x33, 0x33, 0x33))
    d = doc.add_paragraph(); rr = d.add_run(summary["month"]); set_font(rr, 9, RGBColor(0x94, 0x29, 0x72))
    doc.add_paragraph()
    toc = doc.add_paragraph(); tr = toc.add_run("Содержание"); set_font(tr, 20, RGBColor(0x33, 0x33, 0x33))
    doc.add_paragraph()
    doc.add_paragraph(); doc.add_paragraph()

    doc.add_heading("Анализ технических факторов со стороны сервера", level=1)
    doc.add_heading("4.2. Перебои в работе сайта", level=2)
    doc.add_paragraph(
        "Доступность сайта — базовое условие его работы: если сайт периодически недоступен или отвечает "
        "с перебоями, пользователи уходят, растёт отказ, а поисковые системы могут понижать сайт в выдаче "
        "и перестают считать его надёжным. Стабильность проверяют с нескольких точек — если из части регионов "
        "сайт не открывается, значит есть проблемы с сервером, хостингом, DNS или сетью. Ниже — результат "
        "проверки доступности сайта из точек мониторинга по России (сервис Ping-Admin)."
    )
    doc.add_paragraph("Ссылка на итоговый тест: " + summary["result_url"])
    if summary.get("source_note"):
        doc.add_paragraph(summary["source_note"])
    p = doc.add_paragraph(); p.add_run("Результаты проверки из точек РФ:").bold = True
    doc.add_paragraph(f"Всего точек: {summary['total']}; успешно ответили: {summary['ok']}; "
                      f"с проблемами/недоступны: {summary['failed']}.", style="List Bullet")
    if summary.get("avg") is not None:
        doc.add_paragraph(f"Среднее время полной загрузки: {summary['avg']} с.", style="List Bullet")

    if summary["failed"] == 0:
        p = doc.add_paragraph(); r = p.add_run("Вывод: "); r.bold = True
        p.add_run("проблем не обнаружено — сайт доступен из всех проверенных точек России, перебоев в работе "
                  "не выявлено. Исправления не требуются.")
    else:
        p = doc.add_paragraph(); r = p.add_run("Вывод: "); r.bold = True
        p.add_run("обнаружены перебои в доступности сайта — часть точек не получила ответ. Подробности ниже.")
        p = doc.add_paragraph(); p.add_run("В ходе проверки выявлены следующие проблемы:").bold = True
        for b in summary["problems"]:
            doc.add_paragraph(b, style="List Bullet")
        p = doc.add_paragraph(); r = p.add_run("Рекомендация: "); r.bold = True
        p.add_run("что сделать, чтобы устранить перебои:")
        for b in summary["recommendations"]:
            doc.add_paragraph(b, style="List Bullet")

    if summary["problem_points"]:
        doc.add_paragraph()
        cap = doc.add_paragraph(); cap.add_run("Таблица 1. Точки с проблемами").bold = True
        t = doc.add_table(rows=1, cols=3); t.style = "Table Grid"
        for i, h in enumerate(["Точка мониторинга", "IP сайса", "Время, с"]):
            c = t.rows[0].cells[i]; c.text = h
            for par in c.paragraphs:
                for run in par.runs:
                    run.bold = True
        for e in summary["problem_points"]:
            cells = t.add_row().cells
            cells[0].text = e["point"]; cells[1].text = e["ip"]; cells[2].text = str(e["total"])
    doc.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--timeout", type=int, default=240)
    args = ap.parse_args()

    base = args.url if args.url.endswith("/") else args.url + "/"
    host = re.sub(r"^https?://", "", base).rstrip("/")
    os.makedirs(args.out_dir, exist_ok=True)

    print("[1/3] Запуск проверки на ping-admin.com (только РФ)")
    result_url = ""
    points = []
    csv_url = ""
    source_note = ""
    try:
        result_url, points, html, csv_url = run_free_test(host, args.timeout)
        print(f"      результат ping-admin: {result_url}; точек: {len(points)}")
    except Exception as e:
        print("      ping-admin недоступен:", e)
    if not points:
        note = ("Сервис Ping-Admin (бесплатная проверка) вернул результат без данных по точкам мониторинга; "
                "проверка выполнена с российских узлов через сервис Check-Host.")
        print("[1b/3] Фолбэк: проверка с узлов РФ через check-host.net")
        ch_url, points = run_checkhost(base, args.timeout)
        if points:
            if result_url:
                source_note = f"{note} Ссылка Ping-Admin: {result_url}"
            result_url = ch_url or result_url
            print(f"      результат check-host: {ch_url}; точек: {len(points)}")
        elif not result_url:
            raise RuntimeError("Не удалось получить результаты ни от Ping-Admin, ни от Check-Host")

    print("[2/3] Анализ результатов")
    total = len(points)
    ok = sum(1 for p in points if p["ok"])
    failed = total - ok
    times = [p["total"] for p in points if p["total"] is not None]
    avg = round(sum(times) / len(times), 2) if times else None
    slow = [p for p in points if p["total"] is not None and p["total"] > 5]
    problem_points = [p for p in points if not p["ok"]] + slow[:20]
    problem_points = problem_points[:30]

    problems = []
    if failed:
        problems.append(f"Из {total} точек РФ {failed} не получили ответ от сайта — это перебои в доступности "
                        f"(сайт недоступен из части регионов).")
    if slow:
        problems.append(f"{len(slow)} точек открывали страницу дольше 5 секунд — медленный отклик сервера "
                        f"воспринимается как перебой и снижает поведенческие факторы.")
    if failed == 0 and not slow:
        problems.append("Перебоев и критично медленных ответов не выявлено.")

    recommendations = [
        "Проверить доступность из проблемных регионов прицельно и сообщить хостинг-провайдеру: "
        "причины — сетевые маршруты, перегрузка сервера, ограничения по IP/региону.",
        "Настроить постоянный мониторинг доступности (Ping-Admin, UptimeRobot и т.п.) с уведомлениями об "
        "отказах, чтобы фиксировать время и частоту перебоев.",
        "Проверить ресурсы сервера (CPU, память, дисковые операции) и логи ошибок — перебои часто вызваны "
        "перегрузкой или падением процессов.",
        "Включить кэширование и CDN — они повышают устойчивость к нагрузке и ускоряют отклик из регионов.",
        "Следить за DNS и сертификатом (SSL): проблемы с DNS или истёкший сертификат делают сайт недоступным "
        "для части пользователей.",
        "Проверить работу сайта под нагрузкой и при пиковых обращениях; при необходимости увеличить ресурсы "
        "или перейти к более надёжному хостингу.",
    ]

    month_ru = {"January": "Январь", "February": "Февраль", "March": "Март", "April": "Апрель",
                "May": "Май", "June": "Июнь", "July": "Июль", "August": "Август", "September": "Сентябрь",
                "October": "Октябрь", "November": "Ноябрь", "December": "Декабрь"}.get(
        datetime.now().strftime("%B"), datetime.now().strftime("%B"))
    summary = {"host": host, "month": f"{month_ru} {datetime.now().year}", "result_url": result_url,
               "csv_url": csv_url, "total": total, "ok": ok, "failed": failed, "avg": avg,
               "problems": problems, "recommendations": recommendations, "problem_points": problem_points,
               "source_note": source_note}

    print("[3/3] Сохранение отчёта")
    build_docx(os.path.join(args.out_dir, "Перебои в работе сайта.docx"), base, summary)
    print("Готово:")
    print("  -", os.path.join(args.out_dir, "Перебои в работе сайта.docx"))
    print(f"  вывод: {'проблем не обнаружено' if failed == 0 else f'проблемы у {failed} точек'}")


if __name__ == "__main__":
    main()
