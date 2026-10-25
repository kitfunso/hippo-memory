### Changed

- **The store port has one adapter, `sqliteStore`; the in-memory twin and its parity suite are gone, and CI proves `serve()` on any store by serving `sqliteStore` through the port alone (`HIPPO_TEST_STORE=port-only`).**
