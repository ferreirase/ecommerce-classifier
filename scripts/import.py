"""Extract the two POC datasets from the xlsx dump (stdlib only, streams the 160MB sheet).

usage: python3 -I scripts/import.py promotions-vouchers-9.xlsx data
writes data/baseline.json (100 stratified non-Posthaus products) and data/posthaus.json (all Posthaus).
"""
import json
import random
import re
import sys
import zipfile
from pathlib import Path
from xml.etree.ElementTree import iterparse

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
FIELDS = [
    "id", "advertiser_name", "marketplace_name", "marketplace_category_name", "title", "brand_name",
    "description", "short_description", "image_url", "price", "category_name", "validation_mode",
]
BASELINE_SIZE = 100
LOAD_SIZE = 600
SEED = 42
# 75 kids + 75 adult, by current category_name (the label under test, so noisy by design).
VALIDATION_QUOTAS = {
    "Roupas Infantis": 50, "Calçados Infantis": 25,
    "Roupas Femininas": 20, "Roupas Masculinas": 20, "Calçados Femininos": 13,
    "Calçados Masculinos": 12, "Lingerie e Moda Íntima": 10,
}


def rows(xlsx: str):
    header = None
    with zipfile.ZipFile(xlsx) as z:
        for _, el in iterparse(z.open("xl/worksheets/sheet1.xml")):
            if el.tag != NS + "row":
                continue
            cells = {
                re.match(r"[A-Z]+", c.get("r")).group(): "".join(t.text or "" for t in c.iter(NS + "t"))
                for c in el.findall(NS + "c")
            }
            el.clear()
            if header is None:
                header = {v: k for k, v in cells.items()}
                continue
            yield {f: cells.get(header[f], "").strip() for f in FIELDS}


def slim(p: dict) -> dict:
    p["description"] = p["description"][:1500]
    p["price"] = float(p["price"]) if p["price"] else None
    return p


def main(xlsx: str, out: str):
    enabled = {c["name"] for c in json.loads(Path("categorias.txt").read_text()) if c["is_enabled"]}
    posthaus, by_cat, seen = [], {}, set()
    for p in rows(xlsx):
        if p["advertiser_name"] == "Posthaus":
            posthaus.append(slim(p))
        elif p["category_name"] in enabled and p["title"] and p["title"] not in seen:
            seen.add(p["title"])
            by_cat.setdefault(p["category_name"], []).append(p)

    # Stratified: shuffle each category (fixed seed), manual-validated rows first, then round-robin.
    rng = random.Random(SEED)
    queues = []
    for cat in sorted(by_cat):
        items = by_cat[cat]
        rng.shuffle(items)
        items.sort(key=lambda p: p["validation_mode"] != "manual")
        queues.append(items)
    baseline = []
    while len(baseline) < BASELINE_SIZE and any(queues):
        for q in queues:
            if q and len(baseline) < BASELINE_SIZE:
                baseline.append(slim(q.pop(0)))

    # Validation for the audience question: clothes and shoes from other stores, half kids, half adult.
    # Uses what the baseline left in by_cat (no overlap) and its own RNG (baseline stays identical).
    vrng = random.Random(SEED + 1)
    validacao = []
    for cat, quota in VALIDATION_QUOTAS.items():
        by_store = {}
        for p in by_cat.get(cat, []):
            by_store.setdefault(p["advertiser_name"] or p["marketplace_name"], []).append(p)
        stores = list(by_store.values())
        for s in stores:
            vrng.shuffle(s)
        vrng.shuffle(stores)
        picked = []
        while len(picked) < quota and any(stores):  # round-robin across stores
            for s in stores:
                if s and len(picked) < quota:
                    picked.append(slim(s.pop()))
        validacao += picked

    # Load-test set: random products from what is left, only to measure throughput and rate limits.
    rest = [p for items in by_cat.values() for p in items]
    random.Random(SEED + 2).shuffle(rest)
    carga = [slim(p) for p in rest[:LOAD_SIZE]]

    Path(out).mkdir(exist_ok=True)
    for name, data in (("baseline", baseline), ("posthaus", posthaus), ("validacao", validacao), ("carga", carga)):
        Path(out, f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1))
        print(f"{name}: {len(data)} products, {len({p['category_name'] for p in data})} categories")


if __name__ == "__main__":
    main(*sys.argv[1:3])
