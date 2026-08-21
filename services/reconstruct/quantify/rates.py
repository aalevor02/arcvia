"""
What things cost, and how old that number is.

── Why staleness is the feature, not the refresh ───────────────────────────────
A rate library is only useful if you can say when it was true. Steel moved 18%
in a quarter more than once; cement moves with the monsoon. A costing produced
from a six-month-old table is not approximately right, it is confidently wrong,
and it goes into a client quotation looking exactly like a current one.

So every rate carries its own `Rate_Date` and every total carries the age of the
oldest rate that went into it. A quote built on stale numbers is *labelled*
stale rather than refused — refusing would send the user to a spreadsheet, which
is where they were before and has no dates on it at all.

── Why the weekly refresh is honest about what it can do ───────────────────────
The library cites three source hosts. Refreshing means re-reading a public price
page, and a public price page is a web page: it changes layout, it goes behind
Cloudflare, it stops existing. A refresher that silently fails and leaves the
old number in place is the single most dangerous thing this module could do,
because the whole point of the date is that it is true.

So a refresh does three things and reports all three: what it updated, what it
could not reach, and what it read but did not trust. Anything it could not
confirm keeps its old value *and its old date*, so the staleness surfaces at
quotation time rather than being papered over by a run that "succeeded".

Rates without a machine-readable source are marked `Vendor_Quote_Required` and
are never auto-refreshed. Those need a phone call, and pretending otherwise
would be the same lie in a different place.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

#: How old a rate may be before a costing built on it is called stale.
#:
#: Seven days because the brief asked for weekly, but the number that matters is
#: reported rather than enforced — see `Costing.oldest_rate_days`.
FRESH_DAYS = 7

#: Beyond this, a rate is not a price any more, it is a historical note.
STALE_DAYS = 90


@dataclass
class Rate:
    """One priced line from the library."""

    id: str
    category: str
    material: str
    specification: str
    tier: str
    unit: str
    low: float
    base: float
    high: float
    wastage: float          # fraction, e.g. 0.02
    gst: float              # fraction, e.g. 0.28
    rate_date: date | None
    basis: str
    vendor_quote_required: bool
    standard: str
    source_url: str

    def cost(self, quantity: float, band: str = "base") -> float:
        """
        What `quantity` of this costs, delivered and taxed.

        Wastage first, then GST, in that order and not the other way round: you
        are taxed on what you buy, and you buy the wastage too. Reversing them
        understates a 28% item with 5% wastage by about 1.4% — small enough to
        look like rounding and large enough to matter on a whole house.
        """
        rate = {"low": self.low, "base": self.base, "high": self.high}[band]
        return quantity * (1 + self.wastage) * rate * (1 + self.gst)

    def age_days(self, today: date | None = None) -> int | None:
        if not self.rate_date:
            return None
        return ((today or date.today()) - self.rate_date).days


def _number(value: str, default: float = 0.0) -> float:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def _rate_date(value: str) -> date | None:
    try:
        return datetime.strptime(str(value).strip(), "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


class RateLibrary:
    """The priced materials, indexed for lookup."""

    def __init__(self, rates: list[Rate], source: str = ""):
        self.rates = rates
        self.source = source
        self._by_id = {r.id: r for r in rates}

    @classmethod
    def load(cls, path: str | Path) -> "RateLibrary":
        path = Path(path)
        rates: list[Rate] = []

        # utf-8-sig: the supplied file carries a BOM, and without this the first
        # column name becomes "﻿Material_ID" and every lookup by header
        # silently misses.
        with open(path, newline="", encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                if not row.get("Material_ID"):
                    continue
                rates.append(
                    Rate(
                        id=row["Material_ID"].strip(),
                        category=row.get("Category", "").strip(),
                        material=row.get("Material", "").strip(),
                        specification=row.get("Specification / Grade", "").strip(),
                        tier=row.get("Quality_Tier", "Standard").strip(),
                        unit=row.get("Unit", "").strip(),
                        low=_number(row.get("Hyderabad_Low_INR")),
                        base=_number(row.get("Hyderabad_Base_INR")),
                        high=_number(row.get("Hyderabad_High_INR")),
                        wastage=_number(row.get("Wastage_%")),
                        gst=_number(row.get("GST_%")),
                        rate_date=_rate_date(row.get("Rate_Date", "")),
                        basis=row.get("Rate_Basis", "").strip(),
                        vendor_quote_required=str(
                            row.get("Vendor_Quote_Required", "")
                        ).strip().upper() in ("YES", "TRUE", "1"),
                        standard=row.get("IS_Code / Standard", "").strip(),
                        source_url=row.get("Source_URL", "").strip(),
                    )
                )

        return cls(rates, source=str(path))

    # ---- Lookup -------------------------------------------------------------

    def by_id(self, material_id: str) -> Rate | None:
        return self._by_id.get(material_id)

    def find(self, *terms: str, tier: str | None = None, unit: str | None = None) -> Rate | None:
        """
        The best match for a description, or None.

        Every term must appear somewhere in the material, its specification or
        its category. Deliberately strict: a costing that silently priced
        "waterproofing membrane" as "waterproofing chemical" would be wrong by a
        factor and would never announce itself. Returning None sends the caller
        to `unpriced`, which the report shows.
        """
        needles = [t.lower() for t in terms if t]
        best: Rate | None = None

        for rate in self.rates:
            if tier and rate.tier.lower() != tier.lower():
                continue
            if unit and rate.unit.lower() != unit.lower():
                continue

            haystack = f"{rate.material} {rate.specification} {rate.category}".lower()
            if not all(needle in haystack for needle in needles):
                continue

            # Prefer a direct market reference over a derived estimate: one is a
            # price someone quoted, the other is arithmetic on a price someone
            # quoted, and the difference belongs in the report.
            if best is None or (
                "direct" in rate.basis.lower() and "direct" not in best.basis.lower()
            ):
                best = rate

        return best

    # ---- Freshness ----------------------------------------------------------

    def freshness(self, today: date | None = None) -> dict:
        """How old this library is, in the terms a quotation needs."""
        today = today or date.today()
        ages = [r.age_days(today) for r in self.rates if r.rate_date]

        return {
            "rates": len(self.rates),
            "dated": len(ages),
            "undated": len(self.rates) - len(ages),
            "newestDays": min(ages) if ages else None,
            "oldestDays": max(ages) if ages else None,
            "fresh": bool(ages) and max(ages) <= FRESH_DAYS,
            "stale": bool(ages) and max(ages) > STALE_DAYS,
            "vendorQuoteRequired": sum(1 for r in self.rates if r.vendor_quote_required),
            "refreshable": sum(
                1 for r in self.rates
                if r.source_url.startswith("http") and not r.vendor_quote_required
            ),
        }

    def as_dict(self) -> dict:
        return {
            "source": self.source,
            "freshness": self.freshness(),
            "categories": sorted({r.category for r in self.rates}),
        }


@dataclass
class RefreshReport:
    """What a refresh actually managed, stated in three parts."""

    updated: list[dict] = field(default_factory=list)
    unreachable: list[dict] = field(default_factory=list)
    untrusted: list[dict] = field(default_factory=list)
    checked_at: str = ""

    def as_dict(self) -> dict:
        return {
            "checkedAt": self.checked_at,
            "updated": len(self.updated),
            "unreachable": len(self.unreachable),
            "untrusted": len(self.untrusted),
            "detail": {
                "updated": self.updated[:50],
                "unreachable": self.unreachable[:50],
                "untrusted": self.untrusted[:50],
            },
        }

    def write(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.as_dict(), indent=2), encoding="utf-8")
