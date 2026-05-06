"""Pytest config — keep test imports self-contained.

Add the Container app's parent directory to sys.path so `from app...`
imports resolve when running pytest from the apps/ingest workdir or
from the repo root.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
