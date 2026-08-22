/**
 * The shape of a published visualisation.
 *
 * Moved to `@arcvia/publication`, because it is a contract with two ends: the
 * studio composes one of these and stores it, and this app reads it. Two
 * declarations of one payload drift, and the drift is silent — a field the
 * studio stops writing is simply a field this site stops showing.
 *
 * Re-exported rather than deleted so every `from '../types'` in this app keeps
 * working and reading naturally.
 */
export type {
  Room,
  Floor,
  VillaType,
  WalkthroughScene,
  Unit,
  SiteLabel,
  GalleryItem,
  Project,
} from '@arcvia/publication'
