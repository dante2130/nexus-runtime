// SPDX-License-Identifier: MIT
// Capabilities come from the exact pinned C++ source, never from a title or
// a launcher preference. Older modules need not have this optional manifest.
import fs from 'node:fs/promises';
import path from 'node:path';
const known = new Set(['xuser-offline-identity-v2', 'xgame-invitations-v1', 'achievement-notify-v1']);
export async function moduleCapabilities(directory) {
  let bytes;
  try { bytes = await fs.readFile(path.join(directory, 'nexus-capabilities.json')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (bytes.length > 4096) throw Error('C++ capability manifest exceeds limit');
  const value = JSON.parse(bytes);
  if (!value || value.schema !== 1 || Object.keys(value).sort().join(',') !== 'features,schema' ||
      !Array.isArray(value.features) || value.features.length > known.size ||
      value.features.some(feature => !known.has(feature)) || new Set(value.features).size !== value.features.length)
    throw Error('Unsupported C++ capability manifest');
  return [...value.features];
}
