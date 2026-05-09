// Composes the markdown bodies for the `SDK · Node` and
// `SDK · Python` Scalar tags from the package READMEs. The
// READMEs are the single source of truth; this module only
// massages them for the Scalar context (strip License, swap the
// install banner for a version-aware footer, prepend a Try-It
// nudge).

import {
  SDK_NODE_README,
  SDK_NODE_VERSION,
  SDK_PYTHON_README,
  SDK_PYTHON_VERSION,
} from './sdk-readmes.gen.js';

const REPO = 'https://github.com/alacrity-ai/TextralAI';

if (!SDK_NODE_README || !SDK_NODE_VERSION) {
  throw new Error(
    'sdk-readmes.gen.ts is missing or stale; run `tsx apps/api/scripts/build-sdk-readmes.ts`',
  );
}

function tryItBanner(): string {
  return [
    '> **Want to skip the prose?** Hit the [`POST /v1/query`](#tag/query)',
    '> Try-It panel in the API reference — the SDK code samples on every',
    "> operation page show the same call as the snippets below.",
    '',
  ].join('\n');
}

function versionFooter(
  pkgName: string,
  version: string,
  installCmd: string,
): string {
  return [
    '',
    '---',
    '',
    '## Install & version',
    '',
    '```bash',
    installCmd,
    '```',
    '',
    `Current version: **\`${pkgName}@${version}\`**. Released in lockstep`,
    'with `@textral/contracts`. See the',
    `[SDKs design plan](${REPO}/blob/main/docs/development/sdks/SDKS_DESIGN_PLAN.md)`,
    'for the version policy.',
    '',
  ].join('\n');
}

// Strip:
//   * trailing `## License` section (license is a tag-group concern)
//   * top-of-README install code-fence (replaced by the version-aware
//     footer)
function scrub(md: string, installCmd: string): string {
  const noLicense = md.replace(/\n## License\b[\s\S]*$/m, '\n');
  // The install fence is the first ```bash block after the H1 + tagline.
  // We only strip if it matches the expected install command shape, so
  // we don't accidentally drop a different code fence.
  const installPattern = new RegExp(
    `\\n\`\`\`bash\\n${installCmd.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\n\`\`\`\\n`,
  );
  return noLicense.replace(installPattern, '\n');
}

export function nodeSdkPage(): string {
  const body = scrub(SDK_NODE_README, 'npm install @textral/sdk');
  return [
    tryItBanner(),
    body,
    versionFooter('@textral/sdk', SDK_NODE_VERSION, 'npm install @textral/sdk'),
  ].join('\n');
}

export function pythonSdkPage(): string {
  const body = scrub(SDK_PYTHON_README, 'pip install textral');
  return [
    tryItBanner(),
    body,
    versionFooter('textral', SDK_PYTHON_VERSION, 'pip install textral'),
  ].join('\n');
}
