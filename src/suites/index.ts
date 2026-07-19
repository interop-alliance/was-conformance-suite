/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import type { Suite } from '../harness/types.js'

import { changesQueryApi } from './changes-query-api.js'
import { clientBackends } from './client-backends.js'
import { clientDelegation } from './client-delegation.js'
import { clientExportImport } from './client-export-import.js'
import { clientResources } from './client-resources.js'
import { clientSpaces } from './client-spaces.js'
import { collectionApi } from './collection-api.js'
import { encryptionMarkerApi } from './encryption-marker-api.js'
import { policyApi } from './policy-api.js'
import { resourceApi } from './resource-api.js'
import { server } from './server.js'
import { spacesApi } from './spaces-api.js'

/**
 * The full conformance registry, in canonical run order (matching the
 * original file-alphabetical execution order of the ported suite).
 */
export const suites: Array<Suite<any>> = [
  changesQueryApi,
  clientBackends,
  clientDelegation,
  clientExportImport,
  clientResources,
  clientSpaces,
  collectionApi,
  encryptionMarkerApi,
  policyApi,
  resourceApi,
  server,
  spacesApi
]

export {
  changesQueryApi,
  clientBackends,
  clientDelegation,
  clientExportImport,
  clientResources,
  clientSpaces,
  collectionApi,
  encryptionMarkerApi,
  policyApi,
  resourceApi,
  server,
  spacesApi
}
