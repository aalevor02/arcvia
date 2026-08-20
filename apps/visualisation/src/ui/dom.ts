type Child = Node | string | null | undefined | false
type Attrs = Record<string, string | number | boolean | EventListener | undefined>

/**
 * Minimal element builder.
 *
 * Everything on these pages is built from project data — unit codes, room
 * names, marketing copy — and some of that will eventually be edited by a
 * salesperson rather than a developer. Building through createElement and
 * textContent means a stray angle bracket in a room name can never become
 * markup, which an innerHTML template would allow.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key === 'class') {
      node.className = String(value)
    } else {
      node.setAttribute(key, String(value))
    }
  }

  append(node, children)
  return node
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

/** SVG needs its own namespace; createElement silently produces a dead node. */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | EventListener | undefined> = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else {
      node.setAttribute(key, String(value))
    }
  }
  append(node, children)
  return node
}

/** Square metres, to the precision the drawings actually state. */
export function area(value: number): string {
  return `${value.toFixed(2).replace(/\.00$/, '')} m²`
}

/** "3.82 × 4.00 m", or an em dash where the drawing gives no dimension. */
export function dimension(width?: number, depth?: number): string {
  if (width === undefined || depth === undefined) return '—'
  return `${width.toFixed(2)} × ${depth.toFixed(2)} m`
}

export function squareMetres(width?: number, depth?: number): number | null {
  if (width === undefined || depth === undefined) return null
  return width * depth
}
