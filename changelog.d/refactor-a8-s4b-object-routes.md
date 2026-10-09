### Changed

- **The decision, incident and project-brief routes use the shared list, get and close handlers.** All seven typed-object route files now pass one config to `src/server/routes/object-routes.ts`; the project-brief supersede uses the shared one too. The decision supersede stays in its own file because it answers 201 and leaves the missing-row check to the store. No HTTP reply changes: status codes, error text and the order of the checks are the same.
