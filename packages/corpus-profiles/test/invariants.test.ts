// Profile YAML invariants. These catch the typo-class of bugs schema
// validation can't reach: "produces an artifact_type that's not in
// the retrieval set" / "depends_on a pass that doesn't exist".

import { describe, expect, it } from 'vitest';
import { listProfiles } from '../src/loader.js';

describe('profile invariants', () => {
  for (const profile of listProfiles()) {
    describe(profile.id, () => {
      it('retrieval_defaults.artifact_types includes "passage"', () => {
        expect(profile.retrieval_defaults.artifact_types).toContain('passage');
      });

      it('every produces[*] appears in retrieval artifact_types', () => {
        const allowed = new Set(profile.retrieval_defaults.artifact_types);
        for (const pass of profile.enrichment.passes) {
          for (const at of pass.produces) {
            expect(
              allowed.has(at),
              `pass ${pass.id} produces ${at}, not in artifact_types`,
            ).toBe(true);
          }
        }
      });

      it('every layer_budgets key is a valid artifact_type', () => {
        const allowed = new Set(profile.retrieval_defaults.artifact_types);
        for (const k of Object.keys(profile.retrieval_defaults.layer_budgets)) {
          expect(allowed.has(k), `layer_budgets[${k}] not in artifact_types`).toBe(true);
        }
      });

      it('every layer_order entry is a valid artifact_type', () => {
        const allowed = new Set(profile.retrieval_defaults.artifact_types);
        for (const k of profile.retrieval_defaults.layer_order) {
          expect(allowed.has(k), `layer_order[${k}] not in artifact_types`).toBe(true);
        }
      });

      it('every depends_on references an existing pass id', () => {
        const passIds = new Set(profile.enrichment.passes.map((p) => p.id));
        for (const pass of profile.enrichment.passes) {
          for (const d of pass.depends_on) {
            expect(passIds.has(d), `pass ${pass.id} depends_on=${d} (not a pass)`).toBe(true);
          }
        }
      });

      it('layer_budgets sum is between 0.99 and 1.01 (catches typos)', () => {
        const values = Object.values(profile.retrieval_defaults.layer_budgets);
        if (values.length === 0) return;
        const sum = values.reduce((a, b) => a + b, 0);
        expect(sum).toBeGreaterThanOrEqual(0.99);
        expect(sum).toBeLessThanOrEqual(1.01);
      });

      it('rerank-enabled requires provider + model', () => {
        const r = profile.retrieval_defaults.rerank;
        if (r.enabled) {
          expect(r.provider).toBeTruthy();
          expect(r.model).toBeTruthy();
        }
      });
    });
  }
});
