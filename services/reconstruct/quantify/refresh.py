"""
Keeping the rate library current, and being honest when it isn't.

── The failure this is designed around ─────────────────────────────────────────
The dangerous refresher is not the one that fails. It is the one that half
succeeds: it reaches two of three sources, silently keeps yesterday's number for
the third, stamps everything with today's date, and hands you a quotation that
looks current and is not. The date is the whole value of the library, so a
refresh that writes a date it cannot justify destroys the thing it was run to
maintain.

So nothing is stamped with a date it did not come with. A rate that could not be
confirmed keeps its old value *and its old `Rate_Date`*, and the staleness
surfaces later at quotation time — which is exactly where somebody is in a
position to do something about it.

── Why a parsed price is not trusted on sight ──────────────────────────────────
These are public web pages. A layout change turns a table cell into a phone
number, a GST percentage or next year's forecast, and every one of those parses
as a number. A rate that moves more than `TRUST_BAND` in a week is therefore not
accepted; it is reported as untrusted and left alone. Steel really can move 18%
in a quarter, so the band is not a claim that prices are stable — it is a claim
that a 60% overnight move is more likely to be a broken parser than a market.
"""

from __future__ import annotations

import re
import urllib.request
from datetime import date, datetime
from html import unescape

from .rates import Rate, RateLibrary, RefreshReport

#: A single-run move larger than this is treated as a parse failure, not a price.
TRUST_BAND = 0.40

#: Politeness, and self-defence. These are small sites run by people.
TIMEOUT = 20
USER_AGENT = "Arcvia rate refresher (+https://arcvia.local)"

#: Rows look like: <td>OPC 43 Grade Cement</td><td>50kg bag</td><td>₹383</td>
_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.I | re.S)
_CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.I | re.S)
_TAGS = re.compile(r"<[^>]+>")
_PRICE = re.compile(r"(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)")
_RANGE = re.compile(r"(?:₹|Rs\.?|INR)?\s*([\d,]+(?:\.\d+)?)\s*[–\-—]\s*(?:₹|Rs\.?|INR)?\s*([\d,]+(?:\.\d+)?)")
_UPDATED = re.compile(r"updated\s+(\d{1,2}\s+\w+\s+\d{4})", re.I)


def _text(fragment: str) -> str:
    return unescape(_TAGS.sub(" ", fragment)).strip()


def _number(value: str) -> float | None:
    try:
        return float(value.replace(",", ""))
    except (TypeError, ValueError):
        return None


def fetch(url: str, timeout: int = TIMEOUT) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def page_date(html: str) -> date | None:
    """The date the page says it was updated, if it says one."""
    match = _UPDATED.search(_text(html))
    if not match:
        return None
    for fmt in ("%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(match.group(1), fmt).date()
        except ValueError:
            continue
    return None


def parse_prices(html: str) -> dict[str, dict]:
    """
    Every priced row on the page, keyed by its normalised item name.

    Regex over table rows rather than a parser, because this service keeps a
    quarantined venv with no HTML dependency and one more package for one page
    is a poor trade. The fragility is real and is handled downstream: anything
    this misreads becomes an implausible move and is refused.
    """
    found: dict[str, dict] = {}

    for row in _ROW.findall(html):
        cells = [_text(c) for c in _CELL.findall(row)]
        if len(cells) < 2:
            continue

        joined = " | ".join(cells)
        price = _PRICE.search(joined)
        if not price:
            continue

        base = _number(price.group(1))
        if base is None or base <= 0:
            continue

        low = high = None
        spread = _RANGE.search(joined)
        if spread:
            low, high = _number(spread.group(1)), _number(spread.group(2))
            # A "range" that does not bracket the headline number is not a range
            # — it is two unrelated numbers that happened to sit near a dash.
            if not (low and high and low <= base <= high):
                low = high = None

        key = _normalise(cells[0])
        if key and key not in found:
            found[key] = {"base": base, "low": low, "high": high, "label": cells[0]}

    return found


def _normalise(name: str) -> str:
    """Lowercase alphanumerics, so 'OPC 43 Grade Cement' meets 'OPC Cement 43 Grade'."""
    return " ".join(sorted(re.findall(r"[a-z0-9]+", name.lower())))


def _matches(rate: Rate, parsed_key: str) -> bool:
    """Does this parsed row describe this rate?"""
    wanted = set(_normalise(f"{rate.material} {rate.specification}").split())
    # Drop pure units and packaging words, which appear on one side only.
    wanted -= {"kg", "50", "grade", "mm", "in", "standard"}
    if not wanted:
        return False
    have = set(parsed_key.split())
    return wanted.issubset(have)


def refresh(
    library: RateLibrary,
    today: date | None = None,
    only_older_than: int = 7,
    limit_hosts: set[str] | None = None,
) -> RefreshReport:
    """
    Re-read the sources and update what can be confirmed.

    `only_older_than` is why this is safe to run on a schedule: a rate refreshed
    yesterday is not re-fetched today, so a weekly cron costs one pass over the
    pages that have actually had time to move.
    """
    today = today or date.today()
    report = RefreshReport(checked_at=today.isoformat())

    # Grouped by URL so each page is fetched once however many rates cite it.
    by_url: dict[str, list[Rate]] = {}
    for rate in library.rates:
        if rate.vendor_quote_required or not rate.source_url.startswith("http"):
            continue
        age = rate.age_days(today)
        if age is not None and age < only_older_than:
            continue
        by_url.setdefault(rate.source_url, []).append(rate)

    for url, rates in by_url.items():
        if limit_hosts and not any(host in url for host in limit_hosts):
            continue

        try:
            html = fetch(url)
        except Exception as error:
            for rate in rates:
                report.unreachable.append(
                    {"id": rate.id, "url": url, "reason": str(error)[:120]}
                )
            continue

        prices = parse_prices(html)
        stamped = page_date(html)

        for rate in rates:
            match = next((v for k, v in prices.items() if _matches(rate, k)), None)
            if not match:
                report.untrusted.append(
                    {"id": rate.id, "url": url, "reason": "no row matched this material"}
                )
                continue

            before = rate.base
            move = abs(match["base"] - before) / before if before else 1.0

            if move > TRUST_BAND:
                report.untrusted.append({
                    "id": rate.id,
                    "url": url,
                    "reason": f"moved {move:.0%} in one refresh ({before} -> {match['base']})",
                })
                continue

            rate.base = match["base"]
            if match["low"]:
                rate.low = match["low"]
            if match["high"]:
                rate.high = match["high"]
            # Only ever the date the *page* claims. Stamping today's date on a
            # page that has not been updated since March would be inventing
            # freshness, which is the one thing this must never do.
            if stamped:
                rate.rate_date = stamped

            report.updated.append({
                "id": rate.id,
                "material": rate.material,
                "from": before,
                "to": rate.base,
                "move": round(move, 4),
                "pageDate": stamped.isoformat() if stamped else None,
            })

    return report


def write_csv(library: RateLibrary, path: str) -> None:
    """Write the library back in the shape it was read."""
    import csv

    columns = [
        "Material_ID", "Category", "Material", "Specification / Grade", "Quality_Tier",
        "Unit", "Hyderabad_Low_INR", "Hyderabad_Base_INR", "Hyderabad_High_INR",
        "India_Typical_INR", "Wastage_%", "GST_%", "Rate_Date", "Rate_Basis",
        "Vendor_Quote_Required", "IS_Code / Standard", "Notes", "Source_URL",
    ]

    with open(path, "w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        writer.writerow(columns)
        for rate in library.rates:
            writer.writerow([
                rate.id, rate.category, rate.material, rate.specification, rate.tier,
                rate.unit, rate.low, rate.base, rate.high, "",
                rate.wastage, rate.gst,
                rate.rate_date.isoformat() if rate.rate_date else "",
                rate.basis, "YES" if rate.vendor_quote_required else "NO",
                rate.standard, "", rate.source_url,
            ])
