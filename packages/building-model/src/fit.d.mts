export interface FitSize {
  width: number
  depth: number
  height: number
}

export interface FitEnvelope {
  width: number
  depth: number
  height?: number
}

export interface FitItem {
  id: string
  name?: string
  category?: string
  size?: FitSize
}

export type FitResult<T extends FitItem> =
  | { action: 'as-is'; item: T }
  | { action: 'swapped'; item: T; from: string }
  | { action: 'scaled'; item: T; factor: number; size: FitSize }
  | { action: 'refused'; reason: string; rigid?: boolean }

export const CLEARANCE: number
export const ELASTICITY: Readonly<Record<string, Readonly<{
  mode: 'rigid' | 'stepped' | 'elastic'
  min?: number
  max?: number
}>>>
export const DEFAULT_ELASTICITY: Readonly<{ mode: 'stepped' }>

export function elasticityOf(category?: string): Readonly<{
  mode: 'rigid' | 'stepped' | 'elastic'
  min?: number
  max?: number
}>
export function fitsWithin(size: FitSize, envelope: FitEnvelope): boolean
export function fitToEnvelope<T extends FitItem>(
  item: T,
  envelope: FitEnvelope,
  variants?: readonly T[],
): FitResult<T>

