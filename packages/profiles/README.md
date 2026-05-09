# @textral/profiles

Shared `~/.textral/profiles.toml` resolver. Used by
[`@textral/sdk`](https://www.npmjs.com/package/@textral/sdk) and
[`@textral/mcp`](https://www.npmjs.com/package/@textral/mcp); any
future Node tool that wants to address Textral by profile name
(local, hosted-dev, hosted-prod, self-host, …) consumes the same
shape.

## Install

```bash
npm install @textral/profiles
```

## Usage

```ts
import { resolveProfile } from '@textral/profiles';

// Pick by name.
const p = await resolveProfile({ name: 'hosted-prod' });
// → { name: 'hosted-prod', base_url: 'https://...', api_key: 'tx_live_...' }

// Or rely on the file's default + env-var fallback.
const p2 = await resolveProfile();

// Or pass explicit overrides (highest precedence).
const p3 = await resolveProfile({ baseUrl: 'http://localhost:8787', apiKey: 'tx_live_…' });
```

## Precedence

1. Constructor-supplied `{ baseUrl, apiKey }` (both required to win)
2. `name` argument → looked up in the file
3. `TEXTRAL_PROFILE` env var → looked up in the file
4. File's `default = "..."` field
5. Lex-first profile in the file
6. Synthesized `_env` profile from `TEXTRAL_BASE_URL` + `TEXTRAL_API_KEY`
7. Throws `TextralProfileNotFound`

## File format

```toml
default = "hosted-prod"

[profiles.local]
base_url = "http://localhost:8787"
api_key  = "tx_live_..."

[profiles.hosted-prod]
base_url = "https://api.textral.alacrity.ai"
api_key  = "tx_live_..."
```

The file is created in `~/.textral/profiles.toml` (or
`$TEXTRAL_CONFIG_DIR/profiles.toml`). It contains bearer
credentials — `chmod 600` is recommended; the loader emits a
non-fatal warning otherwise.

## Errors

- `TextralProfileNotFound` — named profile missing, or no
  precedence rung produced credentials.

## License

MIT.
