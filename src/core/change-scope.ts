/**
 * Machine-readable frozen change-scope marker for normalized tasks.
 *
 * A task opts into deterministic changed-path enforcement through a single
 * constraint of the exact form:
 *
 *   Change scope: path/to/file.ts, src/module/
 *
 * Paths are repository-relative, comma-separated, and are either exact files
 * or directory prefixes ending in '/'. The marker must be a machine-readable
 * constraint string starting exactly with the prefix below; scope is never
 * inferred from arbitrary prose. A malformed marker fails closed (throws) so
 * enforcement can never silently degrade into an unbounded guard, and tasks
 * without any marker are not subject to this guard at all.
 */
export const CHANGE_SCOPE_MARKER = 'Change scope:';

export class ChangeScopeMarkerError extends Error {
  constructor(reason: string) {
    super(`Malformed Change scope marker: ${reason}`);
    this.name = 'ChangeScopeMarkerError';
  }
}

/**
 * Parse the change scope from a task's constraint list. Returns null when no
 * constraint carries the marker (the guard stays inactive for that task).
 * Throws ChangeScopeMarkerError on any malformed marker: an empty path list,
 * empty or blank paths, absolute paths, backslashes, '.' or '..' segments,
 * glob metacharacters (including a wildcard root), duplicates, or more than
 * one marker constraint (ambiguous/conflicting scope).
 */
export function parseChangeScopeMarker(constraints: readonly string[] | null | undefined): string[] | null {
  if (!constraints) return null;
  const markers = constraints.filter((constraint) => constraint.startsWith(CHANGE_SCOPE_MARKER));
  if (markers.length === 0) return null;
  if (markers.length > 1) {
    throw new ChangeScopeMarkerError(`${markers.length} conflicting marker constraints are present; exactly one is required`);
  }
  const body = markers[0]!.slice(CHANGE_SCOPE_MARKER.length);
  if (body.trim().length === 0) {
    throw new ChangeScopeMarkerError('the marker lists no paths');
  }
  const paths = body.split(',').map((entry) => entry.trim());
  const seen = new Set<string>();
  for (const entry of paths) {
    if (entry.length === 0) {
      throw new ChangeScopeMarkerError('an empty path entry is present');
    }
    if (entry.includes('\\')) {
      throw new ChangeScopeMarkerError(`path ${JSON.stringify(entry)} uses backslashes; use forward slashes`);
    }
    if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) {
      throw new ChangeScopeMarkerError(`path ${JSON.stringify(entry)} is absolute; paths must be repository-relative`);
    }
    if (entry.split('/').some((segment) => segment === '..' || segment === '.')) {
      throw new ChangeScopeMarkerError(`path ${JSON.stringify(entry)} contains a '.' or '..' segment`);
    }
    if (/[*?[\]]/.test(entry)) {
      throw new ChangeScopeMarkerError(`path ${JSON.stringify(entry)} contains a glob metacharacter; only exact files or directory prefixes ending in '/' are allowed`);
    }
    // Directory prefixes may have one trailing slash, but no empty segment.
    const segments = entry.endsWith('/') ? entry.slice(0, -1).split('/') : entry.split('/');
    if (segments.some((segment) => segment.length === 0)) {
      throw new ChangeScopeMarkerError(`path ${JSON.stringify(entry)} has an empty segment`);
    }
    if (seen.has(entry)) {
      throw new ChangeScopeMarkerError(`path ${JSON.stringify(entry)} is listed more than once`);
    }
    seen.add(entry);
  }
  return paths;
}

/** Whether one repository-relative changed path falls inside the scope. */
export function isPathWithinScope(file: string, scope: readonly string[]): boolean {
  return scope.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));
}

/**
 * Deterministic enforcement: every changed path (additions, deletions, and
 * both sides of renames — the caller supplies whatever GitWorkspace.changedFiles
 * or filesChangedBetween enumerated) must fall inside the parsed scope.
 * Throws with the offending paths otherwise; returns silently when all paths
 * are in scope.
 */
export function assertChangedFilesWithinScope(
  files: readonly string[],
  scope: readonly string[],
  context: string,
): void {
  const violations = files.filter((file) => !isPathWithinScope(file, scope));
  if (violations.length > 0) {
    throw new Error(
      `Change scope violation (${context}): changed paths outside the frozen Change scope [${scope.join(', ')}]: ${violations.join(', ')}`,
    );
  }
}
