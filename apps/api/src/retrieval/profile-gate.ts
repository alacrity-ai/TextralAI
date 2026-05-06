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
    buildMismatchMessage(req, available, dimension),
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

function buildMismatchMessage(
  req: ProfileGateRequest,
  available: VersionIndexRow[],
  dimension: 'embedding' | 'chunking' | 'both',
): string {
  if (available.length === 0) {
    return (
      `This version (${req.version_id}) has no indexed profiles yet. ` +
      `Requested (${req.chunking_profile}, ${req.embedding_profile}). ` +
      `Wait for ingestion to finish, or re-ingest under the requested profile.`
    );
  }
  if (dimension === 'embedding') {
    const reqDim = parseDimFromProfile(req.embedding_profile);
    const availProfiles = uniq(available.map((v) => v.embedding_profile));
    const availDims = uniq(availProfiles.map(parseDimFromProfile).filter((d): d is number => d != null));
    const dimHint =
      reqDim != null && availDims.length > 0
        ? ` (requested ${reqDim} dim, available [${availDims.join(', ')}])`
        : '';
    return (
      `Embedding profile mismatch${dimHint}. ` +
      `Query asked for "${req.embedding_profile}" but this namespace was ingested with [${availProfiles.join(', ')}]. ` +
      `Re-query with one of the available profiles, or re-ingest at the requested profile.`
    );
  }
  if (dimension === 'chunking') {
    const availChunking = uniq(available.map((v) => v.chunking_profile));
    return (
      `Chunking profile mismatch. ` +
      `Query asked for "${req.chunking_profile}" but this namespace was ingested with [${availChunking.join(', ')}]. ` +
      `Re-query with one of the available chunking profiles.`
    );
  }
  const availPairs = uniq(
    available.map((v) => `(${v.chunking_profile}, ${v.embedding_profile})`),
  );
  return (
    `Profile mismatch on chunking and embedding. ` +
    `Requested (${req.chunking_profile}, ${req.embedding_profile}); ` +
    `available: [${availPairs.join(', ')}].`
  );
}

/** Best-effort: pull a trailing `-<digits>` from an embedding profile name
 *  (e.g. `openai-text-embedding-3-large-1024` → 1024). Returns undefined
 *  for soft-default profile names that don't encode a dimension. */
function parseDimFromProfile(profile: string): number | undefined {
  const m = /-(\d{3,5})$/.exec(profile);
  return m ? Number(m[1]) : undefined;
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
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
