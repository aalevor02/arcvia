"""
The rate library, the bill of quantities, and the weekly refresh.

Run:  .venv/Scripts/python.exe test/test_quantify.py

── What these tests are actually defending ─────────────────────────────────────
Everything here produces a number that goes into a client quotation, so the
failure mode is never a crash. It is a plausible number that is wrong, carrying
a date that says it is current. Three of those have already happened in this
module and each one has a test below with its name on it:

  * mortar sand priced as coarse aggregate, because "m sand" appears inside
    "20 mm sand" and the lookup matched on a substring;
  * a refresh stamping today's date on a page it could not confirm;
  * a parse failure arriving as a 60% price move and being written to the CSV.

No network. `refresh.fetch` is replaced for the duration — a test suite that
reaches three public price pages is a test suite that fails on a train, and
these pages are small sites run by people.
"""

from __future__ import annotations

import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quantify import boq, refresh as refresh_mod  # noqa: E402
from quantify.rates import (  # noqa: E402
    FRESH_DAYS,
    STALE_DAYS,
    Rate,
    RateLibrary,
    _contains_phrase,
)

passed = 0
failed = 0


def ok(label: str, cond: bool, extra: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {label}" + (f"  {extra}" if extra else ""))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  {extra}" if extra else ""))


TODAY = date(2026, 8, 22)


def make_rate(rid, material, spec="", category="", base=100.0, wastage=0.0, gst=0.0,
              days_old=1, basis="Direct market reference", url="https://example.test/prices",
              vendor=False, tier="Standard", unit="piece") -> Rate:
    return Rate(
        id=rid, category=category, material=material, specification=spec, tier=tier,
        unit=unit, low=base * 0.9, base=base, high=base * 1.1,
        wastage=wastage, gst=gst,
        rate_date=TODAY - timedelta(days=days_old),
        basis=basis, vendor_quote_required=vendor, standard="", source_url=url,
    )


# ══ rates: the lookup ═══════════════════════════════════════════════════════
print("\n-- lookup: whole words, never substrings --")

# THE REGRESSION. The concatenated haystack for "Coarse Aggregate | 20 mm |
# Sand, Aggregate & Earth" reads "...20 mm sand, aggregate...", and "mm sand"
# contains "m sand". The bill carried coarse aggregate at the sand line, under
# the right description, and nothing errored.
aggregate_haystack = "coarse aggregate 20 mm sand, aggregate & earth"
ok("'m sand' does NOT match inside '20 mm sand'",
   not _contains_phrase(aggregate_haystack, "m sand"))
ok("'m sand' does match the real thing",
   _contains_phrase("m sand river sand, aggregate & earth", "m sand"))

# The same shape of bug in the other direction: a needle must not match a longer
# word that merely starts with it.
ok("a needle does not match a longer word it prefixes",
   not _contains_phrase("cement concrete", "cent"))
ok("but does match when the word ends there",
   _contains_phrase("opc cement 43 grade", "cement"))

library = RateLibrary([
    make_rate("R-SAND", "M Sand", "Washed", "Sand, Aggregate & Earth", base=55.0),
    make_rate("R-AGG", "Coarse Aggregate", "20 mm", "Sand, Aggregate & Earth", base=48.0),
    make_rate("R-CEM", "OPC Cement", "43 Grade", "Cement", base=383.0),
    make_rate("R-BRICK", "Red Clay Brick", "Table moulded", "Masonry", base=9.0),
    make_rate("R-TILE", "Vitrified Tile", "600x600", "Flooring", base=85.0),
    make_rate("R-EMUL", "Interior Emulsion", "Premium", "Paint", base=310.0),
    make_rate("R-DOOR", "Flush Door", "35 mm", "Joinery", base=4200.0),
])

found = library.find("m sand")
ok("the sand lookup returns sand, not aggregate",
   found is not None and found.id == "R-SAND",
   found.id if found else "None")

ok("every term must appear", library.find("opc cement", "43") is not None)
ok("and a term that does not appear returns None",
   library.find("opc cement", "53") is None)

# Returning None is a feature: it routes the line to `unpriced`, which the report
# prints. A near-miss silently priced as something else would not.
ok("an unknown material returns None rather than a near miss",
   library.find("waterproofing membrane") is None)

print("\n-- lookup: a direct reference beats a derived one --")
mixed = RateLibrary([
    make_rate("R-DERIVED", "Steel Rebar", "Fe500D", "Steel", base=62.0,
              basis="Derived from mill price"),
    make_rate("R-DIRECT", "Steel Rebar", "Fe500D", "Steel", base=64.0,
              basis="Direct market reference"),
])
pick = mixed.find("steel rebar")
ok("the direct market reference wins", pick is not None and pick.id == "R-DIRECT",
   pick.id if pick else "None")


# ══ rates: what a thing costs ═══════════════════════════════════════════════
print("\n-- cost: wastage is inside the tax base --")
taxed = make_rate("R-X", "Thing", base=100.0, wastage=0.05, gst=0.28)

# The substantive property is not the ORDER of the two multiplications — that is
# commutative and cannot matter. It is that the wastage is taxed: you are taxed
# on what you buy, and you buy the wastage too. Charging tax on the base alone
# and adding wastage untaxed gives 133.00 against 134.40, which is 1.04% low —
# small enough to read as rounding, and on a whole house it is not rounding.
ok("cost applies wastage and GST together",
   abs(taxed.cost(1.0) - 134.40) < 0.005, f"{taxed.cost(1.0):.4f}")
untaxed_wastage = 1.0 * 100.0 * 1.28 + 1.0 * 0.05 * 100.0
ok("and that is more than leaving the wastage untaxed",
   taxed.cost(1.0) > untaxed_wastage,
   f"{taxed.cost(1.0):.2f} vs {untaxed_wastage:.2f}")
ok("bands select low / base / high",
   taxed.cost(1.0, "low") < taxed.cost(1.0) < taxed.cost(1.0, "high"))


# ══ rates: freshness ════════════════════════════════════════════════════════
print("\n-- freshness --")
fresh_lib = RateLibrary([make_rate("A", "A", days_old=FRESH_DAYS)])
ok("a rate exactly at the boundary is still fresh",
   fresh_lib.freshness(TODAY)["fresh"] is True)

edge_lib = RateLibrary([make_rate("A", "A", days_old=FRESH_DAYS + 1)])
ok("one day past it is not",
   edge_lib.freshness(TODAY)["fresh"] is False)

old_lib = RateLibrary([make_rate("A", "A", days_old=STALE_DAYS + 1)])
ok("and well past it is stale", old_lib.freshness(TODAY)["stale"] is True)

undated = make_rate("U", "Undated")
undated.rate_date = None
mixed_dates = RateLibrary([make_rate("A", "A", days_old=3), undated])
report = mixed_dates.freshness(TODAY)
ok("an undated rate is counted, not silently dropped",
   report["undated"] == 1 and report["dated"] == 1,
   f"dated={report['dated']} undated={report['undated']}")
ok("an undated rate has no age", undated.age_days(TODAY) is None)

vendor_lib = RateLibrary([
    make_rate("V", "Bespoke Joinery", vendor=True),
    make_rate("W", "Cement", url="https://example.test/p"),
])
fr = vendor_lib.freshness(TODAY)
ok("vendor-quote rates are counted and excluded from refreshable",
   fr["vendorQuoteRequired"] == 1 and fr["refreshable"] == 1,
   f"vendor={fr['vendorQuoteRequired']} refreshable={fr['refreshable']}")


# ══ rates: loading ══════════════════════════════════════════════════════════
print("\n-- loading --")
# The supplied file carries a BOM. Without utf-8-sig the first column name
# becomes "﻿Material_ID" and EVERY lookup by header misses — silently,
# because DictReader just returns None for a header that is not there.
CSV = (
    "Material_ID,Category,Material,Specification / Grade,Quality_Tier,Unit,"
    "Hyderabad_Low_INR,Hyderabad_Base_INR,Hyderabad_High_INR,India_Typical_INR,"
    "Wastage_%,GST_%,Rate_Date,Rate_Basis,Vendor_Quote_Required,"
    "IS_Code / Standard,Notes,Source_URL\n"
    "HYD-1,Cement,OPC Cement,43 Grade,Standard,bag,370,383,395,380,"
    "0.02,0.28,2026-08-19,Direct market reference,NO,IS 8112,,https://example.test/p\n"
    ",,,,,,,,,,,,,,,,,\n"  # a blank row, which real exports contain
)
with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / "rates.csv"
    path.write_text("﻿" + CSV, encoding="utf-8")
    loaded = RateLibrary.load(path)

    ok("a BOM does not break the header", len(loaded.rates) == 1, str(len(loaded.rates)))
    ok("a blank row is skipped", all(r.id for r in loaded.rates))
    if loaded.rates:
        r = loaded.rates[0]
        ok("numbers parse", r.base == 383.0 and r.gst == 0.28, f"{r.base} {r.gst}")
        ok("the date parses", r.rate_date == date(2026, 8, 19), str(r.rate_date))
        ok("vendor NO reads as False", r.vendor_quote_required is False)

    # Round trip, because the refresher writes this file back.
    out = Path(tmp) / "out.csv"
    refresh_mod.write_csv(loaded, str(out))
    again = RateLibrary.load(out)
    ok("a written library reloads unchanged",
       len(again.rates) == 1
       and again.rates[0].base == 383.0
       and again.rates[0].rate_date == date(2026, 8, 19))


# ══ refresh: the dangerous half-success ═════════════════════════════════════
print("\n-- refresh: never stamp a date it cannot justify --")

PAGE_WITH_DATE = """
<html><body><p>Last updated 20 August 2026</p><table>
<tr><td>OPC Cement 43 Grade</td><td>50kg bag</td><td>&#8377;391</td></tr>
</table></body></html>
"""

PAGE_NO_DATE = """
<html><body><table>
<tr><td>OPC Cement 43 Grade</td><td>50kg bag</td><td>&#8377;391</td></tr>
</table></body></html>
"""

PAGE_ABSURD = """
<html><body><p>Last updated 20 August 2026</p><table>
<tr><td>OPC Cement 43 Grade</td><td>50kg bag</td><td>&#8377;9120</td></tr>
</table></body></html>
"""


def with_page(html, fn):
    """Run `fn` with the network replaced by a fixed page."""
    original = refresh_mod.fetch
    refresh_mod.fetch = lambda url, timeout=None: html
    try:
        return fn()
    finally:
        refresh_mod.fetch = original


def cement_library():
    return RateLibrary([
        make_rate("HYD-1", "OPC Cement", "43 Grade", "Cement",
                  base=383.0, days_old=30, unit="bag")
    ])


lib = cement_library()
res = with_page(PAGE_WITH_DATE, lambda: refresh_mod.refresh(lib, today=TODAY))
ok("a confirmable price is updated", len(res.updated) == 1, str(res.as_dict()))
ok("to the value on the page", lib.rates[0].base == 391.0, str(lib.rates[0].base))
ok("and stamped with the PAGE's date, not today",
   lib.rates[0].rate_date == date(2026, 8, 20), str(lib.rates[0].rate_date))

lib = cement_library()
was = lib.rates[0].rate_date
res = with_page(PAGE_NO_DATE, lambda: refresh_mod.refresh(lib, today=TODAY))
ok("a page with no date still updates the price", lib.rates[0].base == 391.0)
ok("but the rate keeps its OLD date — freshness is never invented",
   lib.rates[0].rate_date == was, str(lib.rates[0].rate_date))
ok("and the old date is not today", lib.rates[0].rate_date != TODAY)

print("\n-- refresh: a big move is a parse failure, not a market --")
lib = cement_library()
before_value, before_date = lib.rates[0].base, lib.rates[0].rate_date
res = with_page(PAGE_ABSURD, lambda: refresh_mod.refresh(lib, today=TODAY))
ok("a move past TRUST_BAND is refused",
   len(res.untrusted) == 1 and len(res.updated) == 0, str(res.as_dict()))
ok("the value is left alone", lib.rates[0].base == before_value)
ok("and so is the date", lib.rates[0].rate_date == before_date)
ok("and the report says why",
   bool(res.untrusted) and "moved" in res.untrusted[0]["reason"],
   res.untrusted[0]["reason"] if res.untrusted else "")

print("\n-- refresh: what it could not do --")
lib = cement_library()


def boom():
    def explode(url, timeout=None):
        raise OSError("Connection reset by peer")
    original = refresh_mod.fetch
    refresh_mod.fetch = explode
    try:
        return refresh_mod.refresh(lib, today=TODAY)
    finally:
        refresh_mod.fetch = original


res = boom()
ok("an unreachable source is reported, not swallowed", len(res.unreachable) == 1)
ok("and its rate is untouched",
   lib.rates[0].base == 383.0 and lib.rates[0].rate_date == TODAY - timedelta(days=30))

lib = cement_library()
res = with_page("<html><body><table><tr><td>Wall Putty</td><td>&#8377;40</td></tr>"
                "</table></body></html>",
                lambda: refresh_mod.refresh(lib, today=TODAY))
ok("a page with no matching row is untrusted, not updated",
   len(res.untrusted) == 1 and len(res.updated) == 0)

print("\n-- refresh: what it declines to touch --")
lib = RateLibrary([
    make_rate("V-1", "OPC Cement", "43 Grade", "Cement", vendor=True, days_old=30),
])
res = with_page(PAGE_WITH_DATE, lambda: refresh_mod.refresh(lib, today=TODAY))
ok("a vendor-quote rate is never auto-refreshed",
   not (res.updated or res.untrusted or res.unreachable), str(res.as_dict()))

lib = RateLibrary([
    make_rate("N-1", "OPC Cement", "43 Grade", "Cement", url="", days_old=30),
])
res = with_page(PAGE_WITH_DATE, lambda: refresh_mod.refresh(lib, today=TODAY))
ok("a rate with no machine-readable source is skipped",
   not (res.updated or res.untrusted or res.unreachable))

# This is what makes a weekly cron cheap: yesterday's rate is not re-fetched.
lib = RateLibrary([
    make_rate("F-1", "OPC Cement", "43 Grade", "Cement", days_old=2),
])
res = with_page(PAGE_WITH_DATE,
                lambda: refresh_mod.refresh(lib, today=TODAY, only_older_than=7))
ok("a rate refreshed recently is not fetched again",
   not (res.updated or res.untrusted or res.unreachable), str(res.as_dict()))


# ══ refresh: parsing ════════════════════════════════════════════════════════
print("\n-- parsing --")
prices = refresh_mod.parse_prices(PAGE_WITH_DATE)
ok("a priced row is found", len(prices) == 1, str(prices))

# A "range" that does not bracket the headline number is two unrelated numbers
# that happened to sit near a dash — a phone number, a date range, a GST band.
bogus = ("<table><tr><td>OPC Cement 43 Grade</td>"
         "<td>&#8377;391</td><td>2020 - 2024</td></tr></table>")
parsed = refresh_mod.parse_prices(bogus)
ok("a range that does not bracket the base is discarded",
   bool(parsed) and next(iter(parsed.values()))["low"] is None,
   str(parsed))

good = ("<table><tr><td>OPC Cement 43 Grade</td>"
        "<td>&#8377;370 - &#8377;395</td><td>&#8377;383</td></tr></table>")
parsed = refresh_mod.parse_prices(good)
row = next(iter(parsed.values())) if parsed else {}
ok("a range that does bracket it is kept",
   row.get("low") == 370.0 and row.get("high") == 395.0, str(row))

ok("a page with no date reports none", refresh_mod.page_date(PAGE_NO_DATE) is None)
ok("and a page with one reports it",
   refresh_mod.page_date(PAGE_WITH_DATE) == date(2026, 8, 20))


# ══ boq ═════════════════════════════════════════════════════════════════════
print("\n-- bill of quantities --")


def wall(x0, y0, x1, y1, thickness=0.23):
    return {"a": {"x": x0, "y": y0}, "b": {"x": x1, "y": y1}, "thickness": thickness}


MODEL = {
    "elements": {
        "walls": [wall(0, 0, 10, 0), wall(10, 0, 10, 10),
                  wall(10, 10, 0, 10), wall(0, 10, 0, 0)],
        "spaces": [
            {"area": 80.0, "name": "LIVING", "kind": "living"},
            {"area": 25.0, "name": "LAWN", "kind": "outdoor"},
            {"area": 12.0, "name": "VERANDAH", "kind": "outdoor"},
        ],
        "openings": [
            {"width": 0.9, "height": 2.1, "kind": "door", "thickness": 0.23},
        ],
    }
}

full = RateLibrary([
    make_rate("B", "Red Clay Brick", "Table moulded", "Masonry", base=9.0, unit="piece"),
    make_rate("C", "OPC Cement", "43 Grade", "Cement", base=383.0, unit="bag"),
    make_rate("S", "M Sand", "Washed", "Sand, Aggregate & Earth", base=55.0, unit="m³"),
    make_rate("T", "Vitrified Tile", "600x600", "Flooring", base=85.0, unit="sq ft"),
    make_rate("K", "Kota Stone", "Honed", "Flooring", base=60.0, unit="sq ft"),
    make_rate("E", "Interior Emulsion", "Premium", "Paint", base=310.0, unit="litre"),
    make_rate("D", "Flush Door", "35 mm", "Joinery", base=4200.0, unit="piece"),
])

costing = boq.build(MODEL, full, height=3.0)
result = costing.as_dict(TODAY)

# THE ERROR THIS PREVENTS, from the module's own comment: costed naively the
# villa's lawns came to 93 m2 of vitrified floor tiling. Tiling the lawn is a
# line a quantity surveyor spots in five seconds, and it discredits the sheet.
tiling = [ln for ln in result["lines"] if "Vitrified" in ln["description"]]
ok("only interior area is tiled",
   len(tiling) == 1 and abs(tiling[0]["quantity"] - 80.0 * 10.7639) < 1.0,
   str(tiling[0]["quantity"]) if tiling else "no tiling line")

paving = [ln for ln in result["lines"] if "paving" in ln["description"].lower()]
ok("a covered patio is paved, not tiled and not dropped",
   len(paving) == 1 and abs(paving[0]["quantity"] - 12.0 * 10.7639) < 1.0,
   str(paving[0]["quantity"]) if paving else "no paving line")

soft = [ln for ln in result["unpriced"] if "landscape" in ln["description"].lower()]
ok("soft landscape is an UNPRICED line, never a missing one",
   len(soft) == 1 and abs(soft[0]["quantity"] - 25.0) < 0.01,
   str(soft) if soft else "dropped entirely")

ok("every priced line states the rule that produced it",
   all(ln["rule"] for ln in result["lines"]))
ok("and carries the date of the rate behind it",
   all(ln["rateDate"] for ln in result["lines"]))

print("\n-- boq: openings come out of the masonry --")
solid = {"elements": {**MODEL["elements"], "openings": []}}


def masonry_quantity(model):
    lines = boq.build(model, full, height=3.0).as_dict(TODAY)["lines"]
    return next(ln["quantity"] for ln in lines if ln["section"] == "Masonry")


# Compare the MASONRY, not the total. Putting a door in a wall removes some
# brickwork and adds a ~4,200 shutter, so the total goes UP — which is correct
# and is why "a hole makes it cheaper" is the wrong assertion to write here.
ok("a hole removes brickwork",
   masonry_quantity(MODEL) < masonry_quantity(solid),
   f"{masonry_quantity(MODEL):.0f} vs {masonry_quantity(solid):.0f} bricks")
ok("but the door itself is charged, so the total goes up",
   boq.build(MODEL, full, height=3.0).total
   > boq.build(solid, full, height=3.0).total)

print("\n-- boq: staleness reaches the report --")
stale_lib = RateLibrary([
    make_rate("B", "Red Clay Brick", "Table moulded", "Masonry", base=9.0, days_old=200),
    make_rate("C", "OPC Cement", "43 Grade", "Cement", base=383.0, days_old=3),
])
aged = boq.build(MODEL, stale_lib, height=3.0).as_dict(TODAY)
ok("oldestRateDays reports the OLDEST rate used, not the average",
   aged["oldestRateDays"] == 200, str(aged["oldestRateDays"]))

print("\n-- boq: an unpriceable line is shown, not omitted --")
# A BOQ that silently drops what it could not price is a BOQ that is quietly too
# cheap, and the omission is invisible exactly where it matters most.
thin = RateLibrary([make_rate("C", "OPC Cement", "43 Grade", "Cement", base=383.0)])
sparse = boq.build(MODEL, thin, height=3.0).as_dict(TODAY)
ok("lines with no matching rate go to `unpriced`", len(sparse["unpriced"]) > 0)
ok("and every one says why",
   all(ln["note"] for ln in sparse["unpriced"]),
   str([ln["note"] for ln in sparse["unpriced"]][:3]))
ok("the report always carries its caveats", len(sparse["caveats"]) >= 3)

empty = boq.build({"elements": {"walls": [], "spaces": [], "openings": []}}, full)
ok("an empty model produces no total rather than a crash",
   empty.total == 0.0, str(empty.total))


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
