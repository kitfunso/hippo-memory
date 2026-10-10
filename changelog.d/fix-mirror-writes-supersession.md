### Fixed

- A store rebuilt from its markdown mirror now keeps which memories were superseded, when each became valid, where each was extracted from, and its DAG level and parent. Before, the mirror files left these out, so a rebuild brought superseded memories back as current.
