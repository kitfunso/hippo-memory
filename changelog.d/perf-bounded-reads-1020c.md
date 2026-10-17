### Changed

- **The salience gate compares a new memory with at most the 500 newest rows.** A `salience.recentWindow` of 0 or less used to read the whole tenant, and a window above 500 read more than a duplicate check needs; both now stop at 500. The default window of 20 is unchanged.
