### Fixed

- **The recall ranker goldens no longer depend on the real date.** The shared seed now writes its rows at the same frozen time that recall reads at. Before this, the prediction's mirror row took the real clock, so its strength kept growing, and from 14 Oct 2026 it reordered the hybrid rankings on every branch.
