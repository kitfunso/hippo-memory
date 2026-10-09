### Changed

- **The policy, customer-note, process and skill routes share one list, get, close and supersede handler.** `src/server/routes/object-routes.ts` holds the four handlers and the two body-field checks; each route file passes one config. No HTTP reply changes: status codes, error text and the order of the checks are the same.
