const UNIT_CODES = new Set(['mm', 'cm', 'm', 'in', 'ft'])
const UNIT_LABELS = new Map([
  ['millimetres', 'mm'],
  ['centimetres', 'cm'],
  ['metres', 'm'],
  ['inches', 'in'],
  ['feet', 'ft'],
])
const ACTIONABLE_UNIT_CHECKS = new Set([
  'walls-from-linework',
  'median-thickness',
  'plan-span',
  'room-size',
])

export class CadPatchError extends Error {}

function iso(value) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString()
}

/** A re-solve may apply only a patch emitted by this exact job's solver output. */
export function cadPatchWasOffered(markers, requested) {
  return (markers?.verifyChecks ?? [])
    .flatMap((check) => check.choices ?? [])
    .map((choice) => choice.patch)
    .some((patch) =>
      patch.op === requested?.op &&
      patch.target === requested?.target &&
      JSON.stringify(patch.value) === JSON.stringify(requested?.value))
}

export function normaliseCadPatch(raw, at = new Date().toISOString()) {
/** Validate one model decision and record the human acceptance provenance. */
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CadPatchError('A model patch object is required.')
  }
  if (typeof raw.target !== 'string' || !raw.target.trim()) {
    throw new CadPatchError('The model patch needs a target.')
  }

  const patch = {
    op: raw.op,
    target: raw.target.trim(),
    value: raw.value,
    by: 'user',
    at: iso(at) ?? new Date().toISOString(),
  }

  if (patch.op === 'setUnit') {
    if (patch.target !== 'unit' || !UNIT_CODES.has(patch.value)) {
      throw new CadPatchError('setUnit must target unit with mm, cm, m, in or ft.')
    }
    return patch
  }

  if (patch.op === 'setLayerRole') {
    if (patch.value !== 'wall' && patch.value !== 'ignore') {
      throw new CadPatchError('setLayerRole must choose wall or ignore.')
    }
    return patch
  }

  if (patch.op === 'acceptAlternative') {
    if (!['frame', 'building'].includes(patch.target) ||
        !Number.isInteger(patch.value) || patch.value < 0) {
      throw new CadPatchError('acceptAlternative must choose a non-negative frame or building index.')
    }
    return patch
  }

  throw new CadPatchError(`Patch operation ${String(patch.op)} is not replayable yet.`)
}

/** Apply one accepted decision to the engine spec and retain it for every later re-solve. */
export function applyCadPatch(spec, raw, at) {
  const patch = normaliseCadPatch(raw, at)
  const next = {
    ...spec,
    layers: Array.isArray(spec.layers) ? [...spec.layers] : spec.layers,
    patches: [...(Array.isArray(spec.patches) ? spec.patches : []), patch],
  }

  if (patch.op === 'setUnit') next.unit = patch.value
  if (patch.op === 'acceptAlternative') next[patch.target] = patch.value
  if (patch.op === 'setLayerRole') {
    const layers = new Set(next.layers ?? [])
    if (patch.value === 'wall') layers.add(patch.target)
    else layers.delete(patch.target)
    next.layers = [...layers].sort()
    next.autoLayers = false
  }
  return next
}

function choice(label, patch) {
  return { label, patch: { ...patch, by: 'solver' } }
}

/** Attach only choices the current CLI can faithfully replay. */
export function choicesForCadChecks(model, checks, at = new Date().toISOString()) {
  if (model.scale) return (checks ?? []).map((check) => ({ ...check }))
  return (checks ?? []).map((check) => {
    let choices = []

    if (check.name === 'site-scope') {
      choices = (model.site?.buildings ?? [])
        .filter((building) => (building.named ?? 0) > 0)
        .map((building) => choice(
          `Build #${building.index + 1} - ${building.rooms} rooms, ${building.area} m2`,
          { op: 'acceptAlternative', target: 'building', value: building.index, at },
        ))
    } else if (ACTIONABLE_UNIT_CHECKS.has(check.name)) {
      choices = (model.unitMeasured?.candidates ?? [])
        .filter((candidate) => (candidate.paired ?? 0) > 0)
        .slice(0, 3)
        .flatMap((candidate) => {
          const code = UNIT_LABELS.get(candidate.label)
          if (!code || code === model.unit) return []
          return [choice(
            `Read as ${candidate.label} - ${candidate.extent} m across`,
            { op: 'setUnit', target: 'unit', value: code, at },
          )]
        })
    }

    return choices.length ? { ...check, choices } : { ...check }
  })
}

/** Turn an unresolved floor stack into the same choice-bearing review shape. */
export function frameChoiceCheck(model, refusals, at = new Date().toISOString()) {
  const choices = (model.frames ?? []).map((frame, index) => choice(
    `Use drawing ${index + 1}${frame.title ? ` - ${frame.title}` : ''}`,
    { op: 'acceptAlternative', target: 'frame', value: index, at },
  ))
  return {
    name: 'storey-unregistered',
    level: 'blocking',
    message:
      'Several matching plans were found but their floor order could not be confirmed. ' +
      (refusals ?? []).map((item) => item.reason).join(' '),
    value: refusals?.length ?? 0,
    ...(choices.length ? { choices } : {}),
  }
}

