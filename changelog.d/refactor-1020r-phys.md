### Removed

- **The physics ranking engine is gone; recall ranks by hybrid search.** `mode=physics`, `hippo recall --physics`, `hippo explain --physics`, `hippo embed --reset-physics`, `physicsSearch`, `PhysicsParticle`, the sleep physics pass and the store's particle methods are removed, and a `physics` block in `config.json` is ignored; the `memory_physics` table stays in hippo.db, unread. See `docs/UPGRADING-3.0.md`.
