"""Official Python client for the Textral RAG API.

Public API:

    from textral import Client, AsyncClient
    from textral import (
        TextralError,
        TextralAPIError,
        TextralRetryExhausted,
        TextralStreamInterrupted,
        TextralProfileNotFound,
    )
    from textral import RetryPolicy, DEFAULT_RETRY, NO_RETRY
    from textral import Profile, resolve_profile, load_profile_file
    from textral.models import BulkSubmitRequest, ...

See README.md for usage. Cookbook examples in `examples/`.
"""

from ._retry import (
    DEFAULT_RETRY,
    NO_RETRY,
    RequestContext,
    RetryInfo,
    RetryPolicy,
    normalize_path,
    parse_retry_after,
)
from ._version import __version__
from .async_client import AsyncClient
from .bulk import (
    BulkOrchestrateFile,
    BulkOrchestrateResult,
    bulk_ingest_orchestrate,
    bulk_ingest_orchestrate_async,
    poll_bulk_job,
    poll_bulk_job_async,
)
from .client import Client
from .errors import (
    TextralAPIError,
    TextralError,
    TextralProfileNotFound,
    TextralRetryExhausted,
    TextralStreamInterrupted,
)
from .profile import Profile, config_dir, config_path, load_profile_file, resolve_profile

__all__ = [
    "__version__",
    # Clients
    "Client",
    "AsyncClient",
    # Errors
    "TextralError",
    "TextralAPIError",
    "TextralRetryExhausted",
    "TextralStreamInterrupted",
    "TextralProfileNotFound",
    # Retry
    "RetryPolicy",
    "DEFAULT_RETRY",
    "NO_RETRY",
    "RetryInfo",
    "RequestContext",
    "normalize_path",
    "parse_retry_after",
    # Profile
    "Profile",
    "resolve_profile",
    "load_profile_file",
    "config_dir",
    "config_path",
    # Bulk orchestrator
    "BulkOrchestrateFile",
    "BulkOrchestrateResult",
    "bulk_ingest_orchestrate",
    "bulk_ingest_orchestrate_async",
    "poll_bulk_job",
    "poll_bulk_job_async",
]
