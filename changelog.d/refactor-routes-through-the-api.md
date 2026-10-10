### Changed

- **Internal:** The graph, prediction and typed-object routes now reach the store through `src/api` functions that take the request Context, and `check-layers` fails any file under `src/server/routes/` that names `requireGroup` or `storeFor`.
