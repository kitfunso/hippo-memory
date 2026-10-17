### Changed

- **Sleep and `hippo audit` read the store 1000 rows at a time.** Sleep's dedup, quality audit and ambient summary, and the quality audit on its own, no longer hold every row at once; the rows they remove and report are unchanged.
- **The sleep physics line no longer prints an energy figure.** The figure compared every pair of particles on every sleep, and only that log line read it; `hippo status` still prints the energy under its particle cap.
