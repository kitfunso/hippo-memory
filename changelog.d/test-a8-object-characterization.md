### Tests

- **The typed-object behaviour that no test owned is now pinned in one table-driven file, ahead of the lifecycle refactor.** `tests/typed-object-characterization.test.ts` covers the seven types (decisions, incidents, processes, skills, customer notes, policies, project briefs) through the live HTTP server, the rows left in the store and the CLI: refusal wording, audit rows and their order, which list checks run before auth, graph rows after a close, and how each CLI verb reads an id. Behaviour that an existing test already pins gets no new test. No source file changes.
