import { renameSync, writeFileSync } from 'node:fs';

/**
 * Writes `data` to `path` so that a crash or power loss mid-write never leaves a truncated
 * file: the bytes go to a sibling temp file first, which then replaces the target in one
 * rename (atomic on the same NTFS volume).
 */
export function atomicWriteFileSync(path: string, data: Buffer): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
