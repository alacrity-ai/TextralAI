// Degradation level computation. Granular audit fields stay alongside
// the coarse enum — Phase 4 commits to citation integrity, not
// faithfulness.

import type { RetrievalStatus } from '../retrieval/hybrid.js';

export type DegradationLevel = 'full' | 'no_citations' | 'partial' | 'cannot_answer';
export type CitationIntegrity = 'valid' | 'invalid_removed' | 'missing';
export type SynthesisStatus = 'success' | 'truncated' | 'failed';

export interface DegradationInputs {
  retrieval_status: RetrievalStatus;
  citation_integrity: CitationIntegrity | null;
  synthesis_status: SynthesisStatus | null;
}

export function computeDegradation(inputs: DegradationInputs): DegradationLevel {
  if (inputs.retrieval_status === 'empty') return 'cannot_answer';
  if (inputs.synthesis_status === 'failed') return 'cannot_answer';
  if (inputs.synthesis_status === 'truncated') return 'partial';
  if (inputs.synthesis_status === null) return 'cannot_answer';
  if (inputs.citation_integrity === 'valid') return 'full';
  return 'no_citations';
}
