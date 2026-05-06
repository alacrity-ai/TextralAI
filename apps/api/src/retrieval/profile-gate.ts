// Profile compatibility gate (composite: chunking + embedding).

import { TextralError } from '@textral/contracts';
import type { Env } from '../types.js';
import {
  findVersionIndex,
  listVersionIndexesForVersion,
  type VersionIndexRow,
} from '../db/documents.js';

export interface ProfileGateRequest {
  version_id: string;
  embedding_profile: string;
  chunking_profile: string;
}

/** Resolves the composite profile gate for a single version_id, or
 *  throws EMBEDDING_PROFILE_MISMATCH with full details. */
export async function gateVersion(env: Env, req: ProfileGateRequest): Promise<VersionIndexRow> {
  const exact = await findVersionIndex(
    env.db,
    req.version_id,
    req.chunking_profile,
    req.embedding_profile,
  );
  if (exact) return exact;
  const available = await listVersionIndexesForVersion(env.db, req.version_id);
  const dimension = pickFailingDimension(available, req);
  throw new TextralError(
    'EMBEDDING_PROFILE_MISMATCH',
    400,
    `No version_index matches the requested (chunking_profile, embedding_profile) for version ${req.version_id}`,
    {
      dimension,
      requested: {
        chunking_profile: req.chunking_profile,
        embedding_profile: req.embedding_profile,
      },
      available: available.map((v) => ({
        chunking_profile: v.chunking_profile,
        embedding_profile: v.embedding_profile,
        version_index_id: v.id,
        status: v.status,
      })),
      version_id: req.version_id,
      suggestion:
        'Re-ingest with the requested profile, or query with one of the available profiles.',
    },
  );
}

function pickFailingDimension(
  available: VersionIndexRow[],
  req: ProfileGateRequest,
): 'embedding' | 'chunking' | 'both' {
  // If at least one row matches embedding_profile but no chunking_profile,
  // chunking is the failing dimension; vice-versa for embedding.
  let embeddingMatches = false;
  let chunkingMatches = false;
  for (const v of available) {
    if (v.embedding_profile === req.embedding_profile) embeddingMatches = true;
    if (v.chunking_profile === req.chunking_profile) chunkingMatches = true;
  }
  if (embeddingMatches && !chunkingMatches) return 'chunking';
  if (chunkingMatches && !embeddingMatches) return 'embedding';
  return 'both';
}
