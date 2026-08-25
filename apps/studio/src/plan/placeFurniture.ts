import { addFloor, addObject, setActiveFloor } from './planStore'
import type { Proposal } from './furnish'
import type { Plan } from './types'

/**
 * Commit one reviewed proposal batch onto its source plan floors.
 *
 * Raster proposals have no storey and retain the current-floor behavior.
 * Reconstruction proposals carry a zero-based storey, so missing floors are
 * created at the plan store's same 3 m rise and the user's active floor is
 * restored after the batch.
 */
export function placeFurniture(plan: Plan, pieces: Proposal[]): Plan {
  let next = plan
  const originalFloor = plan.activeFloorId
  const names = new Map(
    pieces
      .filter((piece) => piece.storey !== undefined && piece.storeyName)
      .map((piece) => [piece.storey as number, piece.storeyName as string]),
  )
  const highest = Math.max(-1, ...pieces.map((piece) => piece.storey ?? -1))
  while (next.floors.length <= highest) {
    next = addFloor(next, names.get(next.floors.length))
  }

  for (const piece of pieces) {
    const target = piece.storey === undefined
      ? originalFloor
      : next.floors[piece.storey]?.id
    if (!target) continue
    next = setActiveFloor(next, target)
    next = addObject(next, {
      item: piece.item,
      position: piece.position,
      rotation: piece.rotation,
      size: piece.size,
      elevation: piece.elevation,
      wallId: piece.wallId,
      customModel: piece.customModel,
      label: piece.label,
    })
  }
  return next.floors.some((floor) => floor.id === originalFloor)
    ? setActiveFloor(next, originalFloor)
    : next
}
