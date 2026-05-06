// Single import site for `z` in the API package. Routes and components
// import `z` from here, not directly from `zod`, so the OpenAPI extension
// is guaranteed to be applied before any `.openapi(...)` call lands.
//
// `@hono/zod-openapi` calls `extendZodWithOpenApi(z)` at module-load
// time. That mutates the zod prototype on the singleton zod install,
// so plain-zod schemas imported from `@textral/contracts` (which never
// imports from this file) ALSO gain `.openapi()` for free — but we
// still call `.openapi('Name')` exclusively in `components.ts` so the
// contracts package stays framework-agnostic.

import { z } from '@hono/zod-openapi';

export { z };
