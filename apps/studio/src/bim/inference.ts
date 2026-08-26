import type { BimAnalysisElement, BimPlanAnalysis } from './analytics'
import {
  scoreBimBaselineFeatures,
  type BimBaselineEvaluation,
} from './baselineClassifier'

export const BIM_INFERENCE_POLICY = {
  lowConfidenceBelow: 0.75,
  minimumMargin: 0.15,
  maxDistanceMultiplier: 1.25,
} as const

export type BimInferenceAbstentionReason =
  | 'ambiguous'
  | 'out-of-distribution'
  | 'insufficient-class-coverage'

export interface BimInferenceSuggestion {
  elementKey: string
  source: BimAnalysisElement['source']
  sourceId: string
  sourceClass?: string
  currentKind: BimAnalysisElement['kind']
  currentConfidence?: number
  eligibility: 'unknown-kind' | 'missing-confidence' | 'low-confidence'
  decision: 'suggested' | 'abstained'
  predictedKind?: string
  abstentionReason?: BimInferenceAbstentionReason
  marginScore: number
  nearestDistance: number
  allowedDistance: number
  ranked: Array<{ label: string; distance: number }>
}

export interface BimInferenceReport {
  version: 1
  reportId: string
  modelId: string
  corpusId: string
  source: BimPlanAnalysis['source']
  policy: {
    target: 'unknown-or-low-confidence-only'
    lowConfidenceBelow: number
    minimumMargin: number
    maxDistanceMultiplier: number
    neverMutatesSourceLabels: true
  }
  summary: {
    analysedElements: number
    eligibleElements: number
    suggestions: number
    abstentions: number
    skippedHighConfidence: number
  }
  suggestions: BimInferenceSuggestion[]
}

function hash32(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function eligibility(element: BimAnalysisElement): BimInferenceSuggestion['eligibility'] | null {
  if (element.kind === 'unknown') return 'unknown-kind'
  if (element.features.semantic.confidence === undefined) return 'missing-confidence'
  if (element.features.semantic.confidence < BIM_INFERENCE_POLICY.lowConfidenceBelow) {
    return 'low-confidence'
  }
  return null
}

/**
 * Produce review-only suggestions for uncertain elements.
 *
 * The report never changes the analysis or its native/source labels. It
 * abstains when the model has only one class, when the nearest class is beyond
 * its observed training radius, or when the two nearest classes are ambiguous.
 */
export function inferBimElementKinds(
  model: BimBaselineEvaluation,
  analysis: BimPlanAnalysis,
): BimInferenceReport {
  const suggestions = analysis.elements.flatMap((element): BimInferenceSuggestion[] => {
    const targetReason = eligibility(element)
    if (!targetReason) return []
    const score = scoreBimBaselineFeatures(
      model,
      element.features,
      BIM_INFERENCE_POLICY.maxDistanceMultiplier,
    )
    const common = {
      elementKey: element.key,
      source: element.source,
      sourceId: element.sourceId,
      sourceClass: element.sourceClass,
      currentKind: element.kind,
      currentConfidence: element.features.semantic.confidence,
      eligibility: targetReason,
      marginScore: score.marginScore,
      nearestDistance: score.nearestDistance,
      allowedDistance: score.allowedDistance,
      ranked: score.ranked,
    }
    if (model.training.centroids.length < 2) {
      return [{
        ...common,
        decision: 'abstained',
        abstentionReason: 'insufficient-class-coverage',
      }]
    }
    if (score.nearestDistance > score.allowedDistance + 1e-6) {
      return [{
        ...common,
        decision: 'abstained',
        abstentionReason: 'out-of-distribution',
      }]
    }
    if (score.marginScore < BIM_INFERENCE_POLICY.minimumMargin) {
      return [{
        ...common,
        decision: 'abstained',
        abstentionReason: 'ambiguous',
      }]
    }
    return [{ ...common, decision: 'suggested', predictedKind: score.predicted }]
  }).sort((left, right) => left.elementKey.localeCompare(right.elementKey))
  const suggested = suggestions.filter((item) => item.decision === 'suggested').length
  const identity = [
    model.modelId,
    ...suggestions.map((item) => [
      item.elementKey,
      item.decision,
      item.predictedKind ?? item.abstentionReason,
      item.marginScore,
      item.nearestDistance,
    ].join(':')),
  ].join('\u0000')

  return {
    version: 1,
    reportId: `arcvia-inference-${hash32(identity)}`,
    modelId: model.modelId,
    corpusId: model.corpusId,
    source: analysis.source,
    policy: {
      target: 'unknown-or-low-confidence-only',
      ...BIM_INFERENCE_POLICY,
      neverMutatesSourceLabels: true,
    },
    summary: {
      analysedElements: analysis.elements.length,
      eligibleElements: suggestions.length,
      suggestions: suggested,
      abstentions: suggestions.length - suggested,
      skippedHighConfidence: analysis.elements.length - suggestions.length,
    },
    suggestions,
  }
}
