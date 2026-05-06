import type { ResourceDef } from './types.js';
import { openapiResource } from './openapi.js';
import { profilesResource } from './profiles.js';
import { errorCatalogResource } from './error-catalog.js';

export const allResources: ResourceDef[] = [
  openapiResource,
  profilesResource,
  errorCatalogResource,
];
