import { isDeepStrictEqual } from 'node:util';

export function hasHumanModifiedArgs(
  originalArgs: Record<string, unknown>,
  modifiedArgs: Record<string, unknown> | undefined
): boolean {
  if (!modifiedArgs) return false;
  return !isDeepStrictEqual(originalArgs, modifiedArgs);
}

export function buildHumanOverrideNote(effectiveArgs: Record<string, unknown>): string {
  return `[SYSTEM NOTE: The human approver rejected your original arguments and modified them to: ${JSON.stringify(effectiveArgs)}. The following result is based on the modified arguments.]`;
}

