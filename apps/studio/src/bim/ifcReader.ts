import { IfcAPI } from 'web-ifc'
import wasmUrl from 'web-ifc/web-ifc.wasm?url'
import {
  extractOpenIfcMetadata,
  type IfcMetadataOptions,
  type IfcMetadataResult,
} from './ifcMetadata'

/** Open IFC bytes in the browser, extract metadata, and always release WASM memory. */
export async function readIfcMetadata(
  data: Uint8Array,
  options: IfcMetadataOptions = {},
): Promise<IfcMetadataResult> {
  const api = new IfcAPI()
  await api.Init((path) => path.endsWith('.wasm') ? wasmUrl : path, true)
  const modelID = api.OpenModel(data)
  if (modelID < 0) throw new Error('web-ifc could not open this model.')

  try {
    return await extractOpenIfcMetadata(api, modelID, {
      includeGeometry: true,
      includeMeshes: true,
      ...options,
    })
  } finally {
    api.CloseModel(modelID)
    api.Dispose()
  }
}
