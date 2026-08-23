#!/usr/bin/env python3
"""
compose-wedge-unblock.py — Compone (senza MAI eseguire) le due query SQL per
sbloccare manualmente un wedge liveness-backstop non coperto da recheckWedge
(tipicamente guard_id='finalize-retry', ma funziona per qualunque guard_id
tu decida di sbloccare così).

Replica esattamente la logica di acknowledgeLivenessWedgeRecord() in
db/writers/liveness-backstop.ts:
  1. UPDATE liveness_wedge_records SET acknowledged_at = ...
  2. DELETE FROM liveness_block_signatures WHERE (scope,guard,unit_type,unit_id,hash) = ...

Uso:
  # elenca tutti i wedge aperti (acknowledged_at IS NULL) nel DB
  python3 compose-wedge-unblock.py --db .gsd/gsd.db

  # componi le query per un wedge specifico
  python3 compose-wedge-unblock.py --db .gsd/gsd.db --wedge-id W-30dd5b75

  # scrivi anche su file, oltre che a schermo
  python3 compose-wedge-unblock.py --db .gsd/gsd.db --wedge-id W-30dd5b75 --out unblock.sql

Il DB non viene MAI aperto in scrittura (sqlite3.connect con mode=ro via URI) —
lo script non può, per costruzione, modificare nulla.
"""

import argparse
import sqlite3
import sys
from pathlib import Path


WEDGE_COLUMNS = [
    "wedge_id", "scope_id", "guard_id", "unit_type", "unit_id",
    "input_hash", "occurrence_count", "sanctioned_exit",
    "forensics_path", "created_at", "acknowledged_at",
]


def open_readonly(db_path: str) -> sqlite3.Connection:
    """Apre il DB in sola lettura tramite URI — nessuna scrittura è possibile
    con questa connessione, per costruzione, indipendentemente da cosa fa
    il resto dello script."""
    p = Path(db_path).resolve()
    if not p.exists():
        print(f"ERRORE: DB non trovato: {p}", file=sys.stderr)
        sys.exit(1)
    uri = f"file:{p}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def list_open_wedges(conn: sqlite3.Connection) -> list[dict]:
    cur = conn.execute(
        f"SELECT {', '.join(WEDGE_COLUMNS)} FROM liveness_wedge_records "
        f"WHERE acknowledged_at IS NULL ORDER BY created_at"
    )
    return [dict(zip(WEDGE_COLUMNS, row)) for row in cur.fetchall()]


def get_wedge(conn: sqlite3.Connection, wedge_id: str) -> dict | None:
    cur = conn.execute(
        f"SELECT {', '.join(WEDGE_COLUMNS)} FROM liveness_wedge_records "
        f"WHERE wedge_id = ?",
        (wedge_id,),
    )
    row = cur.fetchone()
    return dict(zip(WEDGE_COLUMNS, row)) if row else None


def sql_escape(value: str) -> str:
    """Escape minimale per stringhe SQLite (raddoppia gli apici singoli)."""
    return value.replace("'", "''")


def compose_queries(w: dict) -> str:
    lines = []
    lines.append(f"-- Wedge {w['wedge_id']} (guard_id={w['guard_id']}, unit={w['unit_type']} {w['unit_id']})")
    lines.append(f"-- occurrence_count={w['occurrence_count']}, created_at={w['created_at']}")
    if w["guard_id"] in ("orphaned-active-unit", "completed-no-advance"):
        lines.append(f"-- ATTENZIONE: guard_id='{w['guard_id']}' potrebbe essere già coperto da")
        lines.append("-- recheckWedge() nella versione corrente di gsd-pi — prova PRIMA:")
        lines.append(f"--   /gsd auto --resume-wedge {w['wedge_id']}")
        lines.append("-- Usa le query sotto solo se quel comando rifiuta esplicitamente.")
    lines.append("")
    lines.append("-- 1) Marca il wedge come acknowledged")
    lines.append(
        f"UPDATE liveness_wedge_records SET acknowledged_at = datetime('now') "
        f"WHERE wedge_id='{sql_escape(w['wedge_id'])}';"
    )
    lines.append("SELECT changes();  -- atteso: 1")
    lines.append("")
    lines.append("-- 2) Rimuove la firma di blocco così il guard non ritrova le stesse condizioni")
    lines.append("DELETE FROM liveness_block_signatures")
    lines.append(f"WHERE scope_id='{sql_escape(w['scope_id'])}'")
    lines.append(f"  AND guard_id='{sql_escape(w['guard_id'])}'")
    lines.append(f"  AND unit_type='{sql_escape(w['unit_type'])}'")
    lines.append(f"  AND unit_id='{sql_escape(w['unit_id'])}'")
    lines.append(f"  AND input_hash='{sql_escape(w['input_hash'])}';")
    lines.append("SELECT changes();  -- atteso: 0 o 1 (0 non è un errore)")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True, help="Path al file gsd.db (es. .gsd/gsd.db)")
    ap.add_argument("--wedge-id", help="ID del wedge da sbloccare (es. W-30dd5b75). Se omesso, elenca i wedge aperti.")
    ap.add_argument("--out", help="Scrivi anche le query composte su questo file, oltre che a schermo.")
    args = ap.parse_args()

    conn = open_readonly(args.db)

    if not args.wedge_id:
        open_wedges = list_open_wedges(conn)
        if not open_wedges:
            print("Nessun wedge aperto (acknowledged_at IS NULL) trovato. Niente da fare.")
            return
        print(f"Trovati {len(open_wedges)} wedge aperti:\n")
        for w in open_wedges:
            print(f"  {w['wedge_id']}  guard={w['guard_id']:<24} unit={w['unit_type']}/{w['unit_id']}  occ={w['occurrence_count']}  created={w['created_at']}")
        print(f"\nRilancia con --wedge-id <id> per comporre le query di sblocco per uno specifico.")
        return

    w = get_wedge(conn, args.wedge_id)
    if w is None:
        print(f"ERRORE: nessun wedge con wedge_id='{args.wedge_id}' trovato nel DB.", file=sys.stderr)
        sys.exit(1)

    if w["acknowledged_at"]:
        print(f"ATTENZIONE: questo wedge risulta già acknowledged (acknowledged_at={w['acknowledged_at']}).")
        print("Le query sotto sono comunque sicure da rieseguire (idempotenti), ma probabilmente non servono più.\n")

    composed = compose_queries(w)
    print(composed)

    if args.out:
        Path(args.out).write_text(composed + "\n", encoding="utf-8")
        print(f"\n==> Scritto anche su: {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
