"""Dump the enrichment runner's registered pass IDs as JSON.

Usage:
    cd apps/ingest && python scripts/dump_registry.py > app/enrichment/_registry.json

The TS-side test
(packages/corpus-profiles/test/registry-coverage.test.ts) imports
this JSON to cross-check that every pass id in every shipped profile
is registered in the Container.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Make the project importable when run as a script.
APP_ROOT = Path(__file__).resolve().parents[1]
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

from app.enrichment.runner import _lazy_load_registry, registered_pass_ids  # noqa: E402

_lazy_load_registry()
print(json.dumps(registered_pass_ids(), indent=2))
