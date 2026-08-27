# BIM data strategy

Arcvia should learn from the semantics already carried by BIM files before it
tries to infer an element from pixels or triangles. A Revit wall is a native
`Wall`; a Revit door or window is normally a `FamilyInstance` hosted by a wall.
In IFC, the corresponding objects are `IfcWall`, `IfcDoor`, and `IfcWindow`,
with openings and fills represented as explicit relationships.

The canonical mapping lives in `apps/studio/src/bim/semantics.ts`. It records
the source, source id, confidence, evidence, conflicts, relationships, and
unmodified properties. It does not hide an uncertain guess behind a confident
label.

## Acquisition order

1. **Open IFC files** — accept user-owned `.ifc` files and parse their entity
   classes, spatial hierarchy, types, property sets, quantities, materials,
   placements, geometry, voids, fills, and connections.
2. **Revit through supported interfaces** — for a model the user is authorised
   to access, use a Revit add-in or Autodesk Platform Services (APS) Model
   Derivative metadata. Do not scrape the desktop UI or reverse-engineer RVT.
3. **DXF/DWG layers and blocks** — preserve declared layers and block names,
   then translate them through a project-specific mapping. Their semantics are
   conventions, not a standard.
4. **Raster/PDF plans** — use Arcvia's existing room-boundary, OCR, and opening
   pipeline only after structured sources are unavailable.
5. **Geometry fallback** — classify unlabeled meshes with measurable evidence:
   orientation, aspect ratios, adjacency, containment, storey span, opening
   topology, and room-boundary contribution. Never overwrite an explicit source
   class with a geometric guess.

## Public, reusable starting corpus

| Source | What it supplies | Use |
|---|---|---|
| buildingSMART IFC 4.3 documentation | Authoritative entity and relationship definitions | Mapping and conformance rules |
| buildingSMART Sample-Test-Files | Small IFC certification scenes across schema versions | Parser regression tests |
| GNI BIM Dataset | CC BY 4.0 architectural and structural IFC models | Multi-model evaluation with attribution |
| IfcOpenShell documentation and test models | Open parser behaviour, geometry, spatial and clash examples | Cross-checking Arcvia results |
| Autodesk Revit API documentation | Native category, family, host, room, geometry, and parameter behaviour | Revit connector contract |
| Autodesk APS documentation | Authorized cloud translation, object trees and properties | RVT metadata connector contract |

Every downloaded model needs a manifest row containing its original URL,
publisher/author, licence, retrieval date, checksum, schema/version, permitted
use, and any required attribution. Files without a clear licence remain outside
the training corpus.

## What to extract

- Identity: source id, IFC GlobalId/Revit UniqueId, class, category, family/type.
- Spatial structure: project, site, building, storey, space, coordinates and CRS.
- Construction: material layers, thickness, profiles, compound structures,
  phase, load-bearing/external flags, fire and acoustic properties.
- Geometry: axis/profile/extrusion where available, mesh as a derived cache,
  bounding box, area, length and volume in SI units.
- Relationships: containment, aggregation, type assignment, wall connectivity,
  voids, doors/windows filling openings, room boundaries and systems.
- Quality: missing fields, contradictory labels, invalid geometry, orphaned
  openings, duplicates and confidence of any inferred value.

## Learning loop

Structured BIM provides ground-truth labels. Render several controlled views of
each licensed element and pair them with its semantic class and relationships.
Split evaluation by *building*, not by individual element, so pieces from the
same model cannot leak into both training and test sets. Measure per-class
precision/recall, host-relation accuracy, room closure, quantity error, and IFC
round-trip preservation. Human corrections should be stored as new labelled
examples with provenance; they should not silently mutate the source record.

## Source boundaries

- Honour robots.txt, Terms of Service, licences, rate limits, and `Retry-After`.
- Do not bypass logins, CAPTCHAs, 403 responses, paywalls, or application access
  controls. Prefer official APIs, bulk downloads, or written permission.
- Do not upload customer RVT/IFC models to third parties without explicit
  authorisation; building models commonly contain sensitive project data.
- Documentation is evidence for rules, not bulk training text to republish.

## Next implementation milestones

1. **Done:** browser-side IFC parsing emits canonical semantic records, full
   entity counts, key relationships, property sets, type properties and materials.
2. **Done:** the Studio accepts local IFC files, shows an inventory and exports
   the result as provenance-preserving JSON.
3. **Done:** five buildingSMART certification samples are licence-recorded,
   commit-pinned, checksum-verified, and parsed in the automated test suite.
4. **Done:** measured straight IFC walls convert into Arcvia's editable,
   multi-storey planar graph. Door/window geometry follows the explicit
   opening-to-host-wall relationship; georeferenced offsets remain recorded.
5. **Done:** every native IFC object definition is preserved as a referenced
   BIM record, even when it is not editable. Aggregation, containment, types,
   systems/groups, properties, materials, native classes and provenance remain
   available in the exported inventory.
6. **Done:** IFC length, area, volume, count, mass and time quantities retain
   their source values and normalize independently into SI from declared project
   units. Measured slab, roof, column, beam, stair, railing, furniture and
   equipment bounds persist as visibly distinct 2D/3D reference solids.
7. **Done:** reference solids support selection, undoable movement, resizing,
   elevation editing, source/quantity inspection, and retained IFC nesting,
   connectivity, system/group and space-boundary topology.
8. **Done:** import-time BIM quality analysis reports duplicate GlobalIds,
   orphaned openings, unresolved hosts/units, invalid bounds and missing spatial
   containment without mutating source data.
9. **Done:** retain exact transformed IFC triangle meshes for non-wall
   components within a model-wide vertex budget. Invalid, unavailable or
   over-budget meshes fall back atomically to measured bounds; semantic walls
   and openings continue through the editable planar conversion.
   Imported plans also retain the native storey names and a model-level source
   envelope (source kind/name, schema, record count, origin and quality counts)
   for audit and downstream export.
   Editable walls, split wall descendants, doors and windows retain immutable
   native element IDs/classes, including IFC express IDs and Revit UniqueIds.
   They also retain classification confidence/evidence/conflicts, topology,
   normalized quantities and cloneable source properties as immutable semantic
   snapshots. Reference components carry the same audit snapshot.
11. **Done:** plan-level BIM analytics deduplicate split wall segments by native
    source identity, aggregate normalized quantities once per source element,
    report kind/class/storey and exact-mesh coverage, surface confidence,
    conflict/unit/traceability findings, and export deterministic JSON.
12. **Done:** normalize direct IFC materials and ordered compound material
    layers from schema relationships, convert layer thickness with declared
    project units, accept authorized Revit SI material records, retain them on
    semantic snapshots, and aggregate source-deduplicated material takeoffs.
13. **Done:** export deterministic per-source element fingerprints and compare
    revisions locally, separating additions/removals from geometry, semantics,
    storey, class, kind and split-segment changes. Numeric noise below one
    micrometre is ignored; model files and analyses remain in the browser.
14. **Done:** prepare permission-gated, deterministic BIM learning datasets with
    one example per native source element. Packages retain canonical/native
    labels, storeys, fingerprints, SI geometry and quantities, material layers,
    topology signals and property-field presence while excluding raw property
    values. A stable building identifier assigns every element and revision of
    that building to one 80/10/10 train/validation/test split, preventing
    element-level leakage across evaluation partitions.
15. **Done:** validate and combine multiple local building packages into a
    deterministic learning corpus. Runtime contracts reject unsigned or
    privacy-unsafe inputs; the audit blocks duplicate datasets/elements,
    tampered building assignments, element/package boundary violations,
    conflicting labels and identical geometry crossing train/evaluation
    splits. It reports class, source, property-field, geometry, quantity,
    material and per-split building/example coverage before declaring a corpus
    training-ready. Files remain browser-local and the full audit is exportable.
16. **Done:** train an interpretable standardized nearest-centroid baseline on
    structured geometry, topology, normalized quantity and material features.
    Native classes, semantic label evidence and raw properties are excluded
    from model inputs. Fitting uses training buildings only; validation and test
    buildings are scored without refitting and report predictions, confusion
    matrices, per-class precision/recall/F1, accuracy and macro F1. Dataset,
    corpus and model identities are deterministic and content-sensitive, and
    the complete reproducible parameters/evaluation export locally. This is a
    benchmark for future models, not a production classifier.
17. **Done:** apply exported structured baseline models to unknown,
    missing-confidence and low-confidence elements as review-only suggestions.
    Inference uses the same rounded feature contract as evaluation, abstains for
    single-class models, ambiguous classifications and geometry outside each
    class's observed training radius, recomputes when the current analysis
    changes, and never rewrites native IFC/Revit labels or semantic snapshots.
10. **Contract ready:** authorised Revit add-in/APS exports can already enter
    Studio as versioned SI JSON and use the same semantics, quality and editable
    wall/opening pipeline. Live APS translation still waits for credentials,
    storage policy and customer consent.
