import { describe, expect, it } from 'vitest';

import { splitFrontmatter } from '../../../src/renderer/components/memory/frontmatter';

describe('splitFrontmatter', () => {
  it('parses the memory-skill frontmatter shape from the user example', () => {
    const content = `---
name: snapshot-is-full-fetch-outcome
description: "The snapshot cache must capture the full fetch outcome, not just clean rendered HTML"
metadata:
  node_type: memory
  type: project
  originSessionId: d80a02b8-c421-462e-840c-606423cd4894
---

\`harness/prepare.py\` builds a per-site snapshot...
`;
    const { frontmatter, body } = splitFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.name).toBe('snapshot-is-full-fetch-outcome');
    expect(frontmatter!.description).toBe(
      'The snapshot cache must capture the full fetch outcome, not just clean rendered HTML'
    );
    expect(frontmatter!.metadata).toEqual({
      node_type: 'memory',
      type: 'project',
      originSessionId: 'd80a02b8-c421-462e-840c-606423cd4894',
    });
    expect(body.trimStart().startsWith('`harness/prepare.py`')).toBe(true);
  });

  it('returns null frontmatter and untouched body when no frontmatter is present', () => {
    const content = '# Just markdown\n\nNo frontmatter here.\n';
    const { frontmatter, body } = splitFrontmatter(content);
    expect(frontmatter).toBeNull();
    expect(body).toBe(content);
  });

  it('does not treat a body-internal `---` divider as frontmatter', () => {
    const content = '# Title\n\nIntro.\n\n---\n\nMore body.\n';
    const { frontmatter } = splitFrontmatter(content);
    expect(frontmatter).toBeNull();
  });

  it('handles single-quoted values', () => {
    const content = `---
name: 'with-single-quotes'
description: 'short text'
---
body
`;
    const { frontmatter } = splitFrontmatter(content);
    expect(frontmatter?.name).toBe('with-single-quotes');
    expect(frontmatter?.description).toBe('short text');
  });

  it('survives a frontmatter with no metadata block', () => {
    const content = `---
name: simple
description: just a name
---
body
`;
    const { frontmatter, body } = splitFrontmatter(content);
    expect(frontmatter?.metadata).toEqual({});
    expect(body).toBe('body\n');
  });
});
