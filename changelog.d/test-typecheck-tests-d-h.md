### Changed

- **Type-checked the test files whose names start with d to h.** Their fixtures now match the real `createMemory`, `Context`, `Actor` and reranker types, so a wrong call shape fails the compiler instead of passing by accident. No runtime or CLI change.
