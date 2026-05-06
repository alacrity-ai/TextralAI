export {
  CorpusProfile,
  ChunkerId,
  ChunkingProfileConfig,
  EnrichmentPassDef,
  EnrichmentSection,
  InferenceModelRef,
  PassId,
  PromptDefaults,
  RerankConfig,
  RetrievalDefaults,
} from './schema.js';
export { getProfile, getProfileOrThrow, listProfiles } from './loader.js';
export { mergeProfile } from './merge.js';
export type { CorpusProfileOverride } from './merge.js';
