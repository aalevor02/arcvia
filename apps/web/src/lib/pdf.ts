/**
 * A one-page PDF, written by hand.
 *
 * ── Why by hand and not a library ───────────────────────────────────────────
 * This runs inside the published walkthrough, and the configurator's own rule
 * applies: a dependency added here is shipped to every client walkthrough ever
 * published. jsPDF is ~350 KB to produce what this file produces in ~200 lines,
 * because the document is fixed: a title, one JPEG, a list of rows, small
 * print. PDF 1.4 with the fourteen standard fonts needs no font embedding, and
 * a JPEG drops into a PDF byte-for-byte as a DCTDecode XObject — the format
 * was designed for exactly this.
 *
 * ── The part that must be byte-exact ────────────────────────────────────────
 * The xref table at the end records the BYTE OFFSET of every object. Browsers
 * tolerate a wrong table (they rebuild it); Acrobat and print pipelines do
 * not, and "works in Chrome, blank in Acrobat" is this format's version of the
 * split-half failure. So the writer assembles binary parts and measures real
 * encoded bytes — never string lengths, which diverge the moment any text
 * holds a non-ASCII character.
 */

export interface SummaryRow {
  label: string
  value: string
}

export interface SummaryPdfInput {
  title: string
  subtitle: string
  /** A data-URL JPEG, e.g. from the viewer's own snapshot(). Optional. */
  imageJpeg?: string | null
  rows: SummaryRow[]
  /** Small print: attribution lines, disclaimers. */
  credits: string[]
  footer: string
}

const A4 = { width: 595.28, height: 841.89 }
const MARGIN = 50

const encoder = new TextEncoder()

/** Latin-1 only: PDF string objects in this writer are WinAnsi. */
function toLatin1(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63
    // The characters this product actually emits beyond Latin-1: metres
    // squared arrives as ², which IS Latin-1; the em dash and typographic
    // quotes are not, and are mapped rather than dropped so a title keeps
    // reading like a title.
    if (code <= 255) out += ch
    else if (ch === '—' || ch === '–') out += '-'
    else if (ch === '’' || ch === '‘') out += "'"
    else if (ch === '“' || ch === '”') out += '"'
    else if (ch === '·') out += '-'
    else out += '?'
  }
  return out
}

function escapeText(text: string): string {
  return toLatin1(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** Width and height straight from the JPEG's own start-of-frame marker. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let at = 2
  while (at < bytes.length - 8) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    // SOF0..SOF15, minus the ones that are not frames (DHT, DAC, RST).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[at + 5] << 8) | bytes[at + 6],
        width: (bytes[at + 7] << 8) | bytes[at + 8],
      }
    }
    at += 2 + ((bytes[at + 2] << 8) | bytes[at + 3])
  }
  return null
}

function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const base64 = dataUrl.split(',')[1]
  if (!base64) return null
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** Naive wrap: small print only, where a rough break beats an overrun. */
function wrap(text: string, chars: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && line.length + word.length + 1 > chars) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}

export function buildSummaryPdf(input: SummaryPdfInput): Blob {
  const image = input.imageJpeg ? dataUrlBytes(input.imageJpeg) : null
  const imageDims = image ? jpegSize(image) : null

  // ---- Content stream --------------------------------------------------------
  let y = A4.height - MARGIN - 20
  const ops: string[] = []
  const text = (font: string, size: number, x: number, atY: number, value: string, gray = 0) => {
    ops.push(
      `BT /${font} ${size} Tf ${gray} g ${x.toFixed(2)} ${atY.toFixed(2)} Td (${escapeText(value)}) Tj ET`,
    )
  }

  text('F2', 20, MARGIN, y, input.title)
  y -= 18
  text('F1', 10, MARGIN, y, input.subtitle, 0.35)
  y -= 16

  if (image && imageDims) {
    const maxWidth = A4.width - MARGIN * 2
    const maxHeight = 300
    const scale = Math.min(maxWidth / imageDims.width, maxHeight / imageDims.height)
    const w = imageDims.width * scale
    const h = imageDims.height * scale
    y -= h
    ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${MARGIN} ${y.toFixed(2)} cm /Im1 Do Q`)
    y -= 24
  }

  for (const row of input.rows) {
    text('F2', 11, MARGIN, y, row.label)
    text('F1', 11, MARGIN + 170, y, row.value)
    y -= 18
  }

  y -= 12
  for (const credit of input.credits) {
    for (const line of wrap(credit, 100)) {
      text('F1', 8, MARGIN, y, line, 0.45)
      y -= 11
    }
  }

  text('F1', 8, MARGIN, MARGIN - 10, input.footer, 0.45)

  const content = encoder.encode(ops.join('\n'))

  // ---- Objects ---------------------------------------------------------------
  // Assembled as parts whose byte lengths are measured after encoding, because
  // the xref table records byte offsets and a Latin-1 title measured as a JS
  // string would shift every offset after it.
  const parts: Uint8Array[] = []
  let offset = 0
  const offsets: number[] = [0] // object 0 is the free-list head
  const push = (part: Uint8Array | string) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part
    parts.push(bytes)
    offset += bytes.length
  }
  const object = (body: string) => {
    offsets.push(offset)
    push(`${offsets.length - 1} 0 obj\n${body}\nendobj\n`)
  }

  push('%PDF-1.4\n%âãÏÓ\n')

  object('<< /Type /Catalog /Pages 2 0 R >>')
  object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
      `/Resources << /Font << /F1 5 0 R /F2 6 0 R >>` +
      (image ? ' /XObject << /Im1 7 0 R >>' : '') +
      ' >> /Contents 4 0 R >>',
  )

  offsets.push(offset)
  push(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`)
  push(content)
  push('\nendstream\nendobj\n')

  object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')

  if (image && imageDims) {
    offsets.push(offset)
    push(
      `7 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageDims.width} ` +
        `/Height ${imageDims.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
        `/Filter /DCTDecode /Length ${image.length} >>\nstream\n`,
    )
    push(image)
    push('\nendstream\nendobj\n')
  }

  const xrefAt = offset
  const count = offsets.length
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let i = 1; i < count; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  push(xref)
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)

  return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}
