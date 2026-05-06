// Phase 7.4 — `textral eval` CLI.
//
// Subcommands:
//   textral eval ls --namespace <slug>
//   textral eval show <run_id> --namespace <slug> --set <set_id>
//   textral eval run <set_id> --namespace <slug> [--watch]
//
// Config resolution order (later wins):
//   1. ~/.textralrc JSON: { api_key, base_url, namespace? }
//   2. env: TEXTRAL_API_KEY, TEXTRAL_BASE_URL, TEXTRAL_NAMESPACE
//   3. flags: --api-key, --base-url, --namespace
//
// Output:
//   - JSON to stdout (machine-readable)
//   - Human summary to stderr
//   - Exit non-zero on any failed question or transport error.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface Config {
  api_key: string;
  base_url: string;
  namespace?: string;
}

function loadConfig(flags: Record<string, string>): Config {
  let cfg: Partial<Config> = {};
  const rcPath = join(homedir(), '.textralrc');
  if (existsSync(rcPath)) {
    try {
      cfg = JSON.parse(readFileSync(rcPath, 'utf-8')) as Partial<Config>;
    } catch {
      console.error(`Warning: ${rcPath} is not valid JSON; ignoring.`);
    }
  }
  if (process.env.TEXTRAL_API_KEY) cfg.api_key = process.env.TEXTRAL_API_KEY;
  if (process.env.TEXTRAL_BASE_URL) cfg.base_url = process.env.TEXTRAL_BASE_URL;
  if (process.env.TEXTRAL_NAMESPACE) cfg.namespace = process.env.TEXTRAL_NAMESPACE;
  if (flags['api-key']) cfg.api_key = flags['api-key']!;
  if (flags['base-url']) cfg.base_url = flags['base-url']!;
  if (flags['namespace']) cfg.namespace = flags['namespace']!;
  if (!cfg.api_key) die('missing api_key (TEXTRAL_API_KEY or --api-key or ~/.textralrc)');
  if (!cfg.base_url) die('missing base_url (TEXTRAL_BASE_URL or --base-url or ~/.textralrc)');
  return cfg as Config;
}

function die(msg: string): never {
  console.error(`textral eval: ${msg}`);
  process.exit(2);
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[k] = next;
        i++;
      } else {
        flags[k] = 'true';
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function api<T>(
  cfg: Config,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      'x-textral-api-key': cfg.api_key,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${cfg.base_url}${path}`, init);
  if (!res.ok) {
    const text = await res.text();
    die(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function requireNamespace(cfg: Config): string {
  if (!cfg.namespace) die('missing namespace (--namespace or TEXTRAL_NAMESPACE or .textralrc)');
  return cfg.namespace;
}

async function cmdLs(cfg: Config): Promise<void> {
  const ns = requireNamespace(cfg);
  const r = await api<{ data: unknown[] }>(cfg, 'GET', `/v1/namespaces/${ns}/eval-sets`);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

async function cmdShow(cfg: Config, args: string[]): Promise<void> {
  const ns = requireNamespace(cfg);
  const flags = parseArgs(args).flags;
  const setId = flags.set ?? die('missing --set');
  const runId = parseArgs(args).positional[0] ?? die('missing run_id positional');
  const r = await api<unknown>(
    cfg,
    'GET',
    `/v1/namespaces/${ns}/eval-sets/${setId}/runs/${runId}`,
  );
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

async function cmdRun(cfg: Config, args: string[]): Promise<void> {
  const ns = requireNamespace(cfg);
  const parsed = parseArgs(args);
  const setId = parsed.positional[0] ?? die('missing set_id positional');
  const inferProvider =
    parsed.flags['inference-provider'] ?? process.env.TEXTRAL_INFERENCE_PROVIDER ?? 'openai';
  const inferModel =
    parsed.flags['inference-model'] ?? process.env.TEXTRAL_INFERENCE_MODEL ?? 'gpt-4o-mini';
  const inferKeyRef =
    parsed.flags['inference-key-ref'] ?? process.env.TEXTRAL_INFERENCE_KEY_REF;
  const embedProvider =
    parsed.flags['embedding-provider'] ?? process.env.TEXTRAL_EMBEDDING_PROVIDER ?? 'openai';
  const embedModel =
    parsed.flags['embedding-model'] ?? process.env.TEXTRAL_EMBEDDING_MODEL ?? 'text-embedding-3-large';
  const embedKeyRef =
    parsed.flags['embedding-key-ref'] ?? process.env.TEXTRAL_EMBEDDING_KEY_REF;

  const body = {
    inference: {
      provider: inferProvider,
      model: inferModel,
      ...(inferKeyRef ? { provider_key_ref: inferKeyRef } : {}),
    },
    embedding: {
      provider: embedProvider,
      model: embedModel,
      dimensions: 1536,
      ...(embedKeyRef ? { provider_key_ref: embedKeyRef } : {}),
    },
    pass_threshold: parsed.flags['pass-threshold']
      ? Number(parsed.flags['pass-threshold'])
      : 4,
  };
  const r = await api<{
    id: string;
    status: string;
    num_questions: number;
    num_passed: number;
    num_failed: number;
  }>(cfg, 'POST', `/v1/namespaces/${ns}/eval-sets/${setId}/runs`, body);
  console.error(
    `Run ${r.id} status=${r.status} passed=${r.num_passed}/${r.num_questions} failed=${r.num_failed}`,
  );
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  if (r.num_failed > 0) process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error('usage: textral eval <ls|show|run> [args...]');
    process.exit(2);
  }
  if (argv[0] !== 'eval') die(`unknown top-level command: ${argv[0]}`);
  const sub = argv[1];
  const rest = argv.slice(2);
  const cfg = loadConfig(parseArgs(rest).flags);
  switch (sub) {
    case 'ls':
      return cmdLs(cfg);
    case 'show':
      return cmdShow(cfg, rest);
    case 'run':
      return cmdRun(cfg, rest);
    default:
      die(`unknown subcommand: ${sub}`);
  }
}

main().catch((e: unknown) => {
  console.error('textral eval: unhandled error:', (e as Error).message);
  process.exit(2);
});
