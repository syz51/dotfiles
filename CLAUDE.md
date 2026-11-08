# Dotfiles

- After testing, review and clean up temporary test files, including session transcripts and folders the test created.
- Keep the test suite in step with every change: add or update tests for the behavior you touch, and when removing or replacing behavior, rewrite its tests to pin the new behavior instead of deleting them. After each change, run the offline suites in SETUP.md's Verification section.
- The opt-in live suites bill the API, so when Claude Code behavior is affected, run only the live suite files and scenarios the change touches while you work, and the full live set once before merge.
