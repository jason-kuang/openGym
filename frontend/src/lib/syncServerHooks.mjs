// Resolve hook: server-only heavy deps resolve to hermetic stubs. The sync
// protocol test exercises /api/data, which never touches passkeys or push.
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUBS = {
  '@simplewebauthn/server': 'syncServerStubs.mjs',
  'web-push': 'syncServerStubs.mjs',
};

export async function resolve(specifier, context, nextResolve) {
  const file = STUBS[specifier];
  if (file) {
    const url = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), file)
    ).href;
    return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
