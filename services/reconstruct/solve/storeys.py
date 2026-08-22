"""
Which drawings on this sheet are storeys of one building?

── The failure this exists to stop ─────────────────────────────────────────────
`DOWN VILLA -WD 22-1-24.dxf` draws two floors of one villa side by side, 2.477 m
apart. Reconstructed as one drawing that is a 505 m² building with 901 m of wall
and a ₹3.25M bill of quantities for something that does not exist, and it passed
the verification gate. `solve/frames.py` now separates them, so the sheet
correctly reports two plans — and the engine still builds one of them and throws
the other away, because `storey0` is hardcoded.

Separating the drawings was the prerequisite. This is the question that follows:
**are these two plans two storeys of one building, or two different buildings?**

── The rule, and why it is shaped this way ─────────────────────────────────────
**Geometry may over-group. Only text may confirm. Nothing is stacked that the
drawing did not name.**

Geometry cannot answer this. Two storeys of one villa and two identical villa
units side by side on a site plan are *the same picture* — same footprint, same
alignment, same spacing. An independent pass proved this the hard way: it built
"two storeys 3 m apart" and "one house with a 3 m utility court" from the same
helper and compared the wall lists elementwise. Not similar inputs — **the same
input**. No geometric discriminator can separate them, so one must not be
invented.

The drawing already knows. `DOWN VILLA` carries 'Ground Floor Plan', 'Lower
Ground Floor Plan', 'First Floor Plan' and three more as plain TEXT. That is the
answer, written down by the architect, and until recently `cli.py` deleted every
one of them.

So: footprint congruence proposes a group, and a level title confirms it. A group
whose members are not all named is **refused** — emitted as separate drawings,
which is today's behaviour and already stamped provisional downstream. A refusal
is a product, not an error path.

── The thing that would have been got wrong ────────────────────────────────────
Order does NOT come from position on the sheet. Measured on the villa: the frame
HIGHER on the paper is 'Lower Ground Floor Plan' and the one LOWER is 'Ground
Floor Plan'. Sheet layout is **inverted** against storey order on that drawing.
Anything ranking storeys by where they sit puts the lawn upstairs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

#: Storey names and their level, ordinal from the ground.
#:
#: Ordered longest-pattern-first because 'lower ground' must match before
#: 'ground' and 'upper basement' before 'basement'. A dict would not preserve
#: that and the bug would be silent — 'Lower Ground Floor Plan' scoring as the
#: ground floor is exactly the error that puts the lawn upstairs.
_LEVELS: tuple[tuple[str, float], ...] = (
    (r"lower\s+ground", -1),
    (r"upper\s+ground", 0.5),
    (r"lower\s+basement", -2),
    (r"basement", -1),
    (r"cellar", -1),
    (r"stilt", 0),
    (r"ground", 0),
    (r"mezzanine", 0.5),
    (r"first", 1),
    (r"second", 2),
    (r"third", 3),
    (r"fourth", 4),
    (r"fifth", 5),
    (r"sixth", 6),
    (r"seventh", 7),
    (r"eighth", 8),
    (r"ninth", 9),
    (r"tenth", 10),
    (r"terrace", 90),
    (r"roof", 91),
)

_TYPICAL = re.compile(r"\btypical\b", re.I)

#: Two frames belong to the same building only if their footprints are this
#: close in each dimension.
#:
#: **The signal is measured; the threshold is CHOSEN.** Storeys of one villa
#: share a structural envelope — on the real villa both storeys are 20.82 m wide
#: to the centimetre, a ratio of 1.00 — which is what establishes that footprint
#: congruence carries information at all. It says nothing about where to put the
#: cut, and 0.75 was not swept.
#:
#: It is deliberately loose, because the error it must not make is the strict
#: one: an upper floor is routinely SMALLER than the floor below (setbacks,
#: terraces, a roof over a single-storey wing), so a tight test rejects exactly
#: the buildings this exists for. Over-grouping is safe here — the title check
#: downstream refuses anything the drawing did not name.
FOOTPRINT_CONGRUENCE = 0.75

#: Floor-to-floor when nothing says otherwise. Indian residential is typically
#: 3.0-3.2 m; this is the clear wall height plus a nominal slab.
DEFAULT_STOREY_RISE = 3.0


def classify_level(title: str | None) -> float | None:
    """
    The storey a plan title names, as an ordinal from the ground, or None.

    Deliberately separate from `classify_room`. Widening that function to know
    about floors is the obvious fix and it is wrong: it ALREADY returns
    'outdoor' for 'TERRACE PLAN' and 'study' for 'OFFICE PATIO (BELOW)', which
    is how a sheet title and a void marker ended up in the villa's room list as
    rooms. Two different questions asked of the same text get two functions.
    """
    if not title:
        return None
    text = title.lower()
    # 'TYPICAL FLOOR PLAN' names a repeated level, not a specific one. It cannot
    # be ordered against a ground floor, so it is not a level — refusing is
    # right, and an apartment sheet full of them should say so rather than
    # stack an arbitrary guess.
    if _TYPICAL.search(text):
        return None
    for pattern, level in _LEVELS:
        if re.search(rf"\b{pattern}\b", text):
            return float(level)
    return None


@dataclass
class Storey:
    """One frame, placed at a level."""

    frame_index: int
    level: float
    title: str
    base_z: float

    def as_dict(self) -> dict:
        return {
            "frame": self.frame_index,
            "level": self.level,
            "title": self.title,
            "baseZ": round(self.base_z, 3),
        }


@dataclass
class Refusal:
    """A group that looked like a building and could not be confirmed as one."""

    frames: list[int]
    reason: str

    def as_dict(self) -> dict:
        return {"frames": self.frames, "reason": self.reason}


@dataclass
class Registration:
    stacks: list[list[Storey]] = field(default_factory=list)
    refusals: list[Refusal] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "stacks": [[s.as_dict() for s in stack] for stack in self.stacks],
            "refusals": [r.as_dict() for r in self.refusals],
            # Stated rather than inferred: a caller that sees zero stacks needs
            # to know whether nothing grouped or nothing was NAMED, because
            # those call for completely different action from a human.
            "storeys": sum(len(s) for s in self.stacks),
        }


def _congruent(a, b) -> bool:
    """Do two frames share a footprint closely enough to be one building?"""
    aw, ah = a.bbox[2] - a.bbox[0], a.bbox[3] - a.bbox[1]
    bw, bh = b.bbox[2] - b.bbox[0], b.bbox[3] - b.bbox[1]
    if min(aw, bw) <= 0 or min(ah, bh) <= 0:
        return False
    return (min(aw, bw) / max(aw, bw) >= FOOTPRINT_CONGRUENCE
            and min(ah, bh) / max(ah, bh) >= FOOTPRINT_CONGRUENCE)


def register_storeys(frames, rise: float = DEFAULT_STOREY_RISE) -> Registration:
    """
    Group the drawings on a sheet into buildings, order them, and place them.

    `frames` are `solve.frames.Frame`, each of which may carry a `title` read off
    the sheet. Returns stacks and refusals; the refusals are as much the answer
    as the stacks.
    """
    registration = Registration()
    if len(frames) < 2:
        return registration

    # Congruence proposes. Union-find over "these two could be the same
    # building", which deliberately OVER-groups — text does the refusing.
    parent = list(range(len(frames)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(frames)):
        for j in range(i + 1, len(frames)):
            if _congruent(frames[i], frames[j]):
                parent[find(j)] = find(i)

    groups: dict[int, list[int]] = {}
    for i in range(len(frames)):
        groups.setdefault(find(i), []).append(i)

    for members in groups.values():
        if len(members) < 2:
            continue

        levels = [(i, classify_level(getattr(frames[i], "title", None)))
                  for i in members]
        named = [(i, lv) for i, lv in levels if lv is not None]

        # Every member must be named. A group where two frames are titled and a
        # third is not is a group we do not understand, and stacking the two we
        # do understand would quietly drop the third from the building.
        if len(named) != len(members):
            registration.refusals.append(Refusal(
                frames=sorted(members),
                reason=(
                    f"{len(members)} congruent drawings, {len(named)} carry a "
                    f"level title. Not stacked — the sheet does not say what "
                    f"the others are."
                ),
            ))
            continue

        if len({lv for _i, lv in named}) != len(named):
            registration.refusals.append(Refusal(
                frames=sorted(members),
                reason=(
                    "two drawings claim the same level. Not stacked — this is "
                    "two buildings of the same type, or a repeated title."
                ),
            ))
            continue

        # Order by what the drawing CALLS them, never by where they sit. On the
        # villa the frame higher on the sheet is the LOWER ground floor.
        named.sort(key=lambda pair: pair[1])
        ground = min((lv for _i, lv in named), key=abs)
        registration.stacks.append([
            Storey(
                frame_index=i,
                level=lv,
                title=getattr(frames[i], "title", "") or "",
                base_z=(lv - ground) * rise,
            )
            for i, lv in named
        ])

    registration.stacks.sort(key=lambda s: -len(s))
    return registration
