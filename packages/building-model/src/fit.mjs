// The measured fit policy lives with its focused Node harness until the
// catalogue package is split out of the Studio. Export it through the shared
// package so production and the ingestion tests execute the same functions.
export * from '../../../tools/asset-ingest/fit.mjs'

