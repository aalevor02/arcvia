# Arcvia Revit connector contract

Arcvia does not scrape the Revit desktop interface or reverse-engineer RVT.
An authorised Revit add-in or Autodesk Platform Services job exports a
versioned JSON envelope that the Studio processes locally.

## Envelope

```json
{
  format: arcvia-revit-export,
  version: 1,
  source: revit-api,
  units: m,
  coordinateSystem: revit-xyz,
  document: {
    title: Example,
    centralModelGuid: optional,
    revitVersion: 2026
  },
  elements: []
}
```

Only SI-metre connector output is accepted. Rejecting ambiguous internal units
prevents Revit's feet-based internal coordinates from silently entering
Arcvia's metre-only plan model.

## Element fields

- Identity: `uniqueId`, integer `elementId`, runtime class.
- Semantics: built-in category, display category, family, type and name.
- Relationships: host, level and reusable type UniqueIds.
- Geometry: SI bounds in Revit XYZ and an optional connector-derived
  longitudinal `planAxis`. Walls and hosted openings need this axis for
  editable plan conversion; Arcvia does not infer it from a rotated AABB.
- Data: parameters and material records are preserved without renaming.
  Material records may carry uniqueId, elementId, name, category and
  SI-metre thickness; compound records may instead contain an ordered layers
  array with the same fields. Arcvia never assumes a thickness when the
  connector omits it.
- Quantities: source value/unit plus an optional connector-computed SI value,
  SI unit and Revit parameter identifier.

The connector should read native API objects such as `Wall`,
`FamilyInstance`, `Level`, compound structures, location curves, solids,
parameters, materials, phases, design options, rooms/spaces and analytical
models. It should emit only documents and linked models the signed-in user is
authorised to access.

## Privacy and transport

The Studio accepts the JSON as a local file. Cloud upload, APS translation and
customer-model retention require separate explicit consent and credentials.
Document paths can contain sensitive project or client names and should be
omitted unless operationally necessary.
