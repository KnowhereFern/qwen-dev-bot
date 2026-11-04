export function normalizeObjectiveLine(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').toLowerCase();
}

export function isExactApprovedRequirement(requirement: string, sourceContent: string): boolean {
  const lines = sourceContent.split(/\n+/);
  const target = normalizeObjectiveLine(requirement);
  return target.length >= 20 && lines.some((line) => {
    const content = line.replace(/^\s*(?:[-*]\s+|\d+[.)]\s+|#{1,6}\s+)/, '')
      .replace(/^\[[ xX]\]\s*/, '')
      .replace(/^Acceptance:\s*/i, '');
    return normalizeObjectiveLine(content) === target;
  });
}

export function isDetailOfPriorRequirement(requirement: string, priorRequirements: string[]): boolean {
  const target = normalizeObjectiveLine(requirement);
  if (target.length < 20) return false;
  const words = (value: string): Set<string> => new Set(normalizeObjectiveLine(value).split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !['the', 'and', 'with', 'from', 'into', 'without', 'that', 'this'].includes(word))
    .map((word) => word.endsWith('s') ? word.slice(0, -1) : word));
  const action = (value: string): string | null => {
    const normalized = normalizeObjectiveLine(value);
    return normalized.match(/\b(?:can|must|may|shall|should)\s+(?:be\s+able\s+to\s+)?([a-z]+)\b/)?.[1]
      ?? normalized.match(/^([a-z]+)\b/)?.[1] ?? null;
  };
  const acronyms = (value: string): Set<string> => new Set(value.match(/\b[A-Z][A-Z0-9]{1,}\b/g) ?? []);
  const targetWords = words(requirement);
  const targetAction = action(requirement);
  const targetAcronyms = acronyms(requirement);
  return priorRequirements.some((prior) => {
    if (normalizeObjectiveLine(prior).includes(target)) return true;
    if (!targetAction || action(prior) !== targetAction || targetWords.size < 4) return false;
    const priorAcronyms = acronyms(prior);
    if ([...targetAcronyms].some((term) => !priorAcronyms.has(term))) return false;
    const priorWords = words(prior);
    const shared = [...targetWords].filter((word) => priorWords.has(word)).length;
    return shared / targetWords.size >= 0.65;
  });
}
