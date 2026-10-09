### Changed

- **Secret scrubbing, injection screening, the id, cursor and argv parsers, recall ordering and the store error codec are now also tested on generated inputs.** `tests/_helpers/property.ts` draws them from fixed seeds and reports the smallest failing input. Internal only, no runtime behaviour changes.
