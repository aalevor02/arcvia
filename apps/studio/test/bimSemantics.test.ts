import { classifyBimElement, isHostedOpening } from '../src/bim/semantics'

let passed = 0
let failed = 0
const check = (label: string, condition: boolean, detail = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${detail ? '  ' + detail : ''}`)
  }
}

{
  const wall = classifyBimElement({ source: 'ifc', sourceId: '2MEi', sourceClass: 'IfcWall' })
  check('IFC wall is read from its schema class', wall.kind === 'wall' && wall.confidence === 1)

  const legacyWall = classifyBimElement({
    source: 'ifc', sourceId: 'wall-2', sourceClass: 'IFCWALLSTANDARDCASE',
  })
  check('IFC class matching is case-insensitive', legacyWall.kind === 'wall')
}

{
  const door = classifyBimElement({
    source: 'revit-api', sourceId: '41827', category: 'OST_Doors',
    relations: { hostId: 'wall-14' },
  })
  check('Revit built-in door category is recognised', door.kind === 'door')
  check('a Revit-hosted door is an opening', isHostedOpening(door))
}

{
  const window = classifyBimElement({
    source: 'ifc', sourceId: 'window-7', sourceClass: 'IfcWindow',
    relations: { fillsOpeningId: 'opening-7' },
  })
  check('IFC window is recognised', window.kind === 'window')
  check('IfcRelFillsElement makes the window a hosted opening', isHostedOpening(window))
}

{
  const conflicted = classifyBimElement({
    source: 'autodesk-aps', sourceId: '99', sourceClass: 'IfcDoor', category: 'Windows',
  })
  check('schema class wins over a conflicting display category', conflicted.kind === 'door')
  check('conflicting metadata is reported, not discarded', conflicted.conflicts[0]?.kind === 'window')
}

{
  const seat = classifyBimElement({ source: 'autodesk-aps', sourceId: 'seat-1', name: 'Window seat' })
  check('free-form names do not silently drive classification', seat.kind === 'unknown')

  const exactFallback = classifyBimElement(
    { source: 'vision', sourceId: 'shape-1', name: 'Window' },
    { allowNameFallback: true },
  )
  check('explicit exact-name fallback stays low confidence',
    exactFallback.kind === 'window' && exactFallback.confidence === 0.55)
}

{
  const unknown = classifyBimElement({
    source: 'ifc', sourceId: 'proxy-12', sourceClass: 'IfcBuildingElementProxy',
    properties: { FireRating: '60 min' },
  })
  check('explicit IFC proxies remain distinguishable from unmapped data', unknown.kind === 'proxy')
  check('unmapped source properties are preserved', unknown.properties.FireRating === '60 min')
}

{
  const beam = classifyBimElement({
    source: 'revit-api', sourceId: 'beam-4', category: 'Structural Framing',
  })
  check('Revit structural framing maps to beam', beam.kind === 'beam')
}

{
  const terminal = classifyBimElement({
    source: 'ifc', sourceId: 'terminal-1', sourceClass: 'IfcAirTerminal',
  })
  const duct = classifyBimElement({
    source: 'ifc', sourceId: 'duct-1', sourceClass: 'IfcDuctSegment',
  })
  check('IFC air terminals map to equipment', terminal.kind === 'equipment')
  check('IFC duct segments map to equipment', duct.kind === 'equipment')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
