### Changed

- `hippo status` now counts its rows in one pass over ten narrow columns instead of loading every memory, so it reads no memory text and builds no row array. The printed text is unchanged.
