### Changed

- **`ambientCandidates` and `summaryWithDescendants` take their admission as data, so a store on a worker thread can answer them.** `hippo-memory/store-kit` exports `AmbientAdmission`, `DescendantAdmission` and the rules that apply them, `ambientRefusal` and `descendantAdmits`; `ambientCandidates` answers the rows it refused beside the rows it kept. See `docs/UPGRADING-3.0.md`.
