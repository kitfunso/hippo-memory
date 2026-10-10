### Changed

- `hippo recall --help`, `explain --help`, `eval --help` and `auth create` now print the embedding weight, MMR lambda, graph hops, graph seeds and key lifetime defaults the code uses, instead of copies typed into the help.
- **Internal:** ambient summary cut points and replay weights are named constants; `continuityTokensOf` no longer shadows `tokenize`; `loadPredictionList` has a return type; comment and string lines over 160 characters are wrapped.
