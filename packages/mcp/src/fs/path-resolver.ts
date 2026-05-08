// Local filesystem resolution for `ingest_local_paths`. Runs in the
// MCP server's Node process — never on the API side. The tool receives
// paths or globs; this module turns them into a list of resolved files
// that the bulk-ingest API can consume.
//
// The pipeline (LARGE_INGEST_ISSUE.md §3.8):
//   1. require absolute path
//   2. realpath (resolve symlinks)
//   3. assert under allowlisted root
//   4. stat (exists, regular file)
//   5. extension policy
//   6. size policy
//   7. open as ReadableStream / Buffer for upload

import { realpath, stat, readdir, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, join, basename } from 'node:path';

export interface McpFsConfig {
  /** Mode: `stdio_only` (default) lights up only over stdio; `allow`
   *  enables it everywhere; `deny` disables. */
  mode: 'stdio_only' | 'allow' | 'deny';
  /** Allowlisted roots (absolute paths). A path must realpath to
   *  somewhere under one of these. Empty = `cwd()`. */
  roots: string[];
  /** Allowed extensions (lowercase, including the dot). Empty = no
   *  extension filter. */
  extensions: string[];
  /** Per-file size cap in bytes. */
  maxFileBytes: number;
  /** Per-batch size cap in bytes. */
  maxBatchBytes: number;
}

const DEFAULT_EXTENSIONS = [
  '.md',
  '.mdx',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.pdf',
];

export function loadFsConfigFromEnv(): McpFsConfig {
  const env = process.env;
  return {
    mode: (env.TEXTRAL_MCP_FS_INGEST as McpFsConfig['mode']) ?? 'stdio_only',
    roots: (env.TEXTRAL_MCP_FS_INGEST_ROOTS ?? process.cwd())
      .split(':')
      .filter(Boolean)
      .map((r) => resolve(r)),
    extensions:
      (env.TEXTRAL_MCP_FS_INGEST_EXTENSIONS?.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)) ?? DEFAULT_EXTENSIONS,
    maxFileBytes: Number(env.TEXTRAL_MCP_FS_INGEST_MAX_FILE_BYTES ?? 10 * 1024 * 1024),
    maxBatchBytes: Number(env.TEXTRAL_MCP_FS_INGEST_MAX_BATCH_BYTES ?? 500 * 1024 * 1024),
  };
}

export interface ResolvedFile {
  abs_path: string;
  realpath: string;
  size_bytes: number;
  content_type: string;
  rel_path: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface ResolveOutcome {
  files: ResolvedFile[];
  skipped: SkippedFile[];
}

export async function resolveExplicitFiles(
  paths: string[],
  config: McpFsConfig,
): Promise<ResolveOutcome> {
  return resolveCandidates(paths, config);
}

/** Walk a directory tree under `root` and return files matching any
 *  of the simple-glob patterns. Patterns support `*` and `**`; no
 *  full glob library to keep the package dep-free. */
export async function resolveGlob(
  root: string,
  patterns: string[],
  config: McpFsConfig,
  exclude: string[] = [],
): Promise<ResolveOutcome> {
  if (!isAbsolute(root)) {
    return {
      files: [],
      skipped: [{ path: root, reason: 'PATH_NOT_ABSOLUTE' }],
    };
  }
  const candidates: string[] = [];
  await walkDir(root, root, candidates);
  const matched = candidates.filter((rel) =>
    patterns.some((p) => simpleGlobMatch(p, rel)),
  );
  const filtered = matched.filter(
    (rel) => !exclude.some((p) => simpleGlobMatch(p, rel)),
  );
  return resolveCandidates(filtered.map((rel) => join(root, rel)), config);
}

async function walkDir(
  root: string,
  current: string,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // skip hidden
    const full = join(current, e.name);
    if (e.isDirectory()) {
      // Skip common heavy dirs.
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      await walkDir(root, full, out);
    } else if (e.isFile()) {
      out.push(relative(root, full));
    }
  }
}

/** Simple glob: `**` matches any number of path segments, `*` matches
 *  one segment (no slash), `?` matches one char. No brace expansion,
 *  no character classes. Sufficient for `**` + `*.md` workflows. */
export function simpleGlobMatch(pattern: string, path: string): boolean {
  const norm = path.split(sep).join('/');
  const re = patternToRegex(pattern);
  return re.test(norm);
}

function patternToRegex(pattern: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** — any number of path segments
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++; // consume trailing slash
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '.';
      i++;
    } else if ('.+(){}^$|\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

async function resolveCandidates(
  paths: string[],
  config: McpFsConfig,
): Promise<ResolveOutcome> {
  if (config.mode === 'deny') {
    return {
      files: [],
      skipped: paths.map((p) => ({ path: p, reason: 'FS_INGEST_DISABLED' })),
    };
  }

  const files: ResolvedFile[] = [];
  const skipped: SkippedFile[] = [];
  let runningBytes = 0;

  for (const p of paths) {
    if (!isAbsolute(p)) {
      skipped.push({ path: p, reason: 'PATH_NOT_ABSOLUTE' });
      continue;
    }
    let real: string;
    try {
      real = await realpath(p);
    } catch {
      skipped.push({ path: p, reason: 'PATH_NOT_FOUND' });
      continue;
    }
    if (!isUnderAnyRoot(real, config.roots)) {
      skipped.push({ path: p, reason: 'PATH_NOT_ALLOWED' });
      continue;
    }
    let st;
    try {
      st = await stat(real);
    } catch {
      skipped.push({ path: p, reason: 'PATH_NOT_FOUND' });
      continue;
    }
    if (!st.isFile()) {
      skipped.push({ path: p, reason: 'NOT_A_REGULAR_FILE' });
      continue;
    }
    if (st.size > config.maxFileBytes) {
      skipped.push({ path: p, reason: 'FILE_TOO_LARGE' });
      continue;
    }
    if (config.extensions.length > 0) {
      const ext = extOf(real);
      if (!config.extensions.includes(ext)) {
        skipped.push({ path: p, reason: 'EXTENSION_NOT_ALLOWED' });
        continue;
      }
    }
    if (runningBytes + st.size > config.maxBatchBytes) {
      skipped.push({ path: p, reason: 'BATCH_TOO_LARGE' });
      continue;
    }
    runningBytes += st.size;
    files.push({
      abs_path: p,
      realpath: real,
      size_bytes: st.size,
      content_type: contentTypeFromExt(extOf(real)),
      rel_path: basename(real),
    });
  }
  return { files, skipped };
}

function isUnderAnyRoot(p: string, roots: string[]): boolean {
  if (roots.length === 0) return true;
  return roots.some((r) => {
    const rel = relative(r, p);
    return !rel.startsWith('..') && !isAbsolute(rel);
  });
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i === -1 ? '' : path.slice(i).toLowerCase();
}

function contentTypeFromExt(ext: string): string {
  switch (ext) {
    case '.md':
    case '.mdx':
      return 'text/markdown';
    case '.txt':
      return 'text/plain';
    case '.pdf':
      return 'application/pdf';
    case '.json':
      return 'application/json';
    case '.yaml':
    case '.yml':
      return 'application/yaml';
    default:
      return 'application/octet-stream';
  }
}

/** Read a file's bytes. Used by the tool to upload to the API.
 *  The bytes never leave this process — they go straight from disk
 *  to fetch(PUT). */
export async function readResolvedFileBytes(file: ResolvedFile): Promise<Buffer> {
  return readFile(file.realpath);
}
