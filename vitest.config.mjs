import { defineConfig } from 'vitest/config';

// Without an explicit exclude, vitest's default include globs also match test files
// inside .claude/worktrees/*, so a leftover worktree gets its tests collected a second
// time and `npm test` reports roughly double the real count.
export default defineConfig({
  test: {
    // kit/ holds the vendored collab kit; its drift test is node:test, run by `npm test`.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'kit/**'],
  },
});
