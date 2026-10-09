### Changed

- **Sleep:** a sleep run now reads the store twice instead of three times and keeps no deep copy of it; on a 20,000-row store the dry run's peak memory fell from 406 MB to 387 MB (median of five), and its time stayed flat at about 16 s.
