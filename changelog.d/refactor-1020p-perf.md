### Changed

- **`hippo reject` and `hippo resolve` find the rows that hold a rejected value through an index.** Schema 65 keys each memory and dormant row by its rejection digest, so they no longer read every row of the tenant; the first `hippo sleep` fills the keys of older rows, and the vault and connector reads use new indexes.
