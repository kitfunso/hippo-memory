### Changed

- **Part-word search and the dashboard text filter read a trigram index (schema v61) instead of testing the 2,000 newest rows.** Sleep, digest and churn reads are bounded, and one store runtime per process owns open-step memory, idle read handles and exit cleanup.
