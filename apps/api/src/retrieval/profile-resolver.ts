// Resolve the corpus profile for a request.
//
// The namespace's `corpus_profile` column is the lookup key; the
// request body's structural overrides (chunking, enrichment,
// retrieval, prompt) merge on top via mergeProfile (workspace
// package; deep-merge with array-replace semantics).

import { TextralError } from '@textral/contracts';
import type {
  CorpusProfile,
  CorpusProfileOverride,
} from '@textral/corpus-profiles';
import { getProfileOrThrow, mergeProfile } from '@textral/corpus-profiles';
import { getNamespaceBySlug } from '../db/namespaces.js';
import type { Env } from '../types.js';

export interface ResolveArgs {
  env: Env;
  tenant_id: string;
  namespace_slug: string;
  request_overrides?: CorpusProfileOverride | undefined;
}

export async function resolveCorpusProfile(args: ResolveArgs): Promise<{
  profile: CorpusProfile;
  namespace_id: string;
  default_embedding_profile: string;
}> {
  const ns = await getNamespaceBySlug(args.env.db, args.tenant_id, args.namespace_slug);
  if (!ns) {
    throw new TextralError(
      'NAMESPACE_NOT_FOUND',
      404,
      `Namespace not found: ${args.namespace_slug}`,
    );
  }
  // The profile name is validated at namespace-create time (see
  // routes/namespaces.ts), so getProfileOrThrow on a missing entry
  // here is genuinely an internal-state bug.
  const base = getProfileOrThrow(ns.corpus_profile);
  const merged = args.request_overrides ? mergeProfile(base, args.request_overrides) : base;
  return {
    profile: merged,
    namespace_id: ns.id,
    default_embedding_profile: ns.default_embedding_profile,
  };
}
