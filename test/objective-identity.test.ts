import { describe, expect, it } from 'vitest';
import { isDetailOfPriorRequirement, isExactApprovedRequirement } from '../src/core/objective-identity.js';

describe('frozen objective requirement identity', () => {
  it('accepts exact approved lines across prose, numbered, and checklist formats', () => {
    const source = [
      '- Acceptance: Import a Skill Block file into the Registry.',
      '1. Export a Skill Block file from the Registry.',
      '- [ ] Record the completed handoff with a PIN.',
      'A runner receives the delivery window.',
    ].join('\n');
    expect(isExactApprovedRequirement('Import a Skill Block file into the Registry.', source)).toBe(true);
    expect(isExactApprovedRequirement('Export a Skill Block file from the Registry.', source)).toBe(true);
    expect(isExactApprovedRequirement('Record the completed handoff with a PIN.', source)).toBe(true);
    expect(isExactApprovedRequirement('A runner receives the delivery window.', source)).toBe(true);
    expect(isExactApprovedRequirement('Delete the Registry without a PIN.', source)).toBe(false);
  });

  it('keeps XML import inside the frozen JSON/XML requirement but separates CSV and export', () => {
    const prior = 'An administrator can import a Skill Block file (JSON/XML) into the Registry without agent restart.';
    expect(isDetailOfPriorRequirement('Administrator can import XML Skill Blocks into the Registry without agent restart.', [prior])).toBe(true);
    expect(isDetailOfPriorRequirement('Import XML Skill Blocks into the Registry without restart.', [prior])).toBe(true);
    expect(isDetailOfPriorRequirement('An administrator can import a Skill Block file (CSV) into the Registry without agent restart.', [prior])).toBe(false);
    expect(isDetailOfPriorRequirement('An administrator can export a Skill Block file (JSON/XML) from the Registry without agent restart.', [prior])).toBe(false);
  });
});
