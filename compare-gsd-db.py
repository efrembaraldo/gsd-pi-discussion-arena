#!/usr/bin/env python3
"""
Confronto tra due database GSD-Pi (gsd.db).

Uso:
    python3 compare-gsd-db.py /path/to/dbA/gsd.db /path/to/dbB/gsd.db

Non modifica nessuno dei due file (apertura in sola lettura).
"""

import sqlite3
import sys
from pathlib import Path


def open_readonly(path: str) -> sqlite3.Connection:
    uri = f"file:{Path(path).resolve()}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def safe_query(con: sqlite3.Connection, sql: str, default=None):
    try:
        cur = con.cursor()
        cur.execute(sql)
        return cur.fetchall()
    except sqlite3.Error as e:
        return f"ERRORE: {e}" if default is None else default


def section(title: str):
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}")


def compare_scalar(label: str, a, b):
    marker = "  <-- DIVERSO" if a != b else ""
    print(f"{label:40s} A={a!r:30s} B={b!r:30s}{marker}")


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)

    path_a, path_b = sys.argv[1], sys.argv[2]
    con_a = open_readonly(path_a)
    con_b = open_readonly(path_b)

    section("FILE")
    print(f"A: {path_a}")
    print(f"B: {path_b}")

    section("SCHEMA / VERSIONE")
    uv_a = safe_query(con_a, "PRAGMA user_version")[0][0]
    uv_b = safe_query(con_b, "PRAGMA user_version")[0][0]
    compare_scalar("user_version", uv_a, uv_b)

    ic_a = safe_query(con_a, "PRAGMA integrity_check")
    ic_b = safe_query(con_b, "PRAGMA integrity_check")
    print(f"integrity_check A: {ic_a}")
    print(f"integrity_check B: {ic_b}")

    section("ULTIMO EVENTO REGISTRATO (workflow_domain_events)")
    last_a = safe_query(con_a, "SELECT MAX(created_at) FROM workflow_domain_events")
    last_b = safe_query(con_b, "SELECT MAX(created_at) FROM workflow_domain_events")
    compare_scalar("ultimo evento", last_a, last_b)

    cnt_a = safe_query(con_a, "SELECT COUNT(*) FROM workflow_domain_events")
    cnt_b = safe_query(con_b, "SELECT COUNT(*) FROM workflow_domain_events")
    compare_scalar("totale eventi", cnt_a, cnt_b)

    section("MILESTONES")
    ms_a = dict(safe_query(con_a, "SELECT id, status FROM milestones ORDER BY sequence", default=[]))
    ms_b = dict(safe_query(con_b, "SELECT id, status FROM milestones ORDER BY sequence", default=[]))
    all_ids = sorted(set(ms_a) | set(ms_b), key=lambda x: (len(x), x))
    for mid in all_ids:
        sa = ms_a.get(mid, "-- ASSENTE --")
        sb = ms_b.get(mid, "-- ASSENTE --")
        marker = "  <-- DIVERSO" if sa != sb else ""
        print(f"{mid:10s} A={sa!s:20s} B={sb!s:20s}{marker}")

    section("CONTEGGIO SLICE PER MILESTONE")
    for mid in all_ids:
        ca = safe_query(con_a, f"SELECT COUNT(*) FROM slices WHERE milestone_id='{mid}'", default=[(None,)])[0][0]
        cb = safe_query(con_b, f"SELECT COUNT(*) FROM slices WHERE milestone_id='{mid}'", default=[(None,)])[0][0]
        marker = "  <-- DIVERSO" if ca != cb else ""
        print(f"{mid:10s} slice A={ca!s:6s} slice B={cb!s:6s}{marker}")

    section("CONTEGGIO TASK PER MILESTONE")
    for mid in all_ids:
        ca = safe_query(con_a, f"SELECT COUNT(*) FROM tasks WHERE milestone_id='{mid}'", default=[(None,)])[0][0]
        cb = safe_query(con_b, f"SELECT COUNT(*) FROM tasks WHERE milestone_id='{mid}'", default=[(None,)])[0][0]
        marker = "  <-- DIVERSO" if ca != cb else ""
        print(f"{mid:10s} task A={ca!s:6s} task B={cb!s:6s}{marker}")

    section("TABELLE PRESENTI SOLO IN UNO DEI DUE")
    tables_a = set(r[0] for r in safe_query(con_a, "SELECT name FROM sqlite_master WHERE type='table'", default=[]))
    tables_b = set(r[0] for r in safe_query(con_b, "SELECT name FROM sqlite_master WHERE type='table'", default=[]))
    only_a = tables_a - tables_b
    only_b = tables_b - tables_a
    if only_a:
        print(f"Solo in A: {sorted(only_a)}")
    if only_b:
        print(f"Solo in B: {sorted(only_b)}")
    if not only_a and not only_b:
        print("Stesso set di tabelle in entrambi.")

    section("RIGHE TOTALI PER OGNI TABELLA COMUNE")
    common_tables = sorted(tables_a & tables_b)
    diffs = []
    for t in common_tables:
        ca = safe_query(con_a, f"SELECT COUNT(*) FROM {t}", default=[(None,)])[0][0]
        cb = safe_query(con_b, f"SELECT COUNT(*) FROM {t}", default=[(None,)])[0][0]
        marker = ""
        if ca != cb:
            marker = "  <-- DIVERSO"
            diffs.append(t)
        print(f"{t:45s} A={ca!s:8s} B={cb!s:8s}{marker}")

    section("VERDETTO ORIENTATIVO")
    if last_a and last_b and isinstance(last_a, list) and isinstance(last_b, list):
        ts_a = last_a[0][0]
        ts_b = last_b[0][0]
        if ts_a and ts_b:
            if ts_a > ts_b:
                print(f"A sembra PIU' AVANZATO (ultimo evento {ts_a} > {ts_b})")
            elif ts_b > ts_a:
                print(f"B sembra PIU' AVANZATO (ultimo evento {ts_b} > {ts_a})")
            else:
                print("Stesso timestamp di ultimo evento — confronta le tabelle sopra per capire eventuali divergenze di contenuto.")
    print(f"\nTabelle con conteggio righe diverso: {diffs if diffs else 'nessuna'}")
    print("\nNota: 'piu' avanzato' per timestamp non significa automaticamente 'da preferire in ogni campo' —")
    print("verifica sempre le sezioni sopra (milestones/slice/task) per capire ESATTAMENTE cosa manca in quale dei due.")

    con_a.close()
    con_b.close()


if __name__ == "__main__":
    main()
