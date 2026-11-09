### Fixed

- **A Health panel no longer shows the previous project's error.** When a panel switched to a new key, it kept the old key's error and loading flag until the next fetch started. It now returns no error and a loading state for the new key at once.
- **Refresh on the Board clears the old error.** After a failed load, pressing refresh now shows "loading cards" (or removes the toolbar alert) while the new fetch runs, instead of leaving the old error on screen.
- **A Health panel no longer stays on loading after a switch away and back.** If the load for the other key was cut short or failed, returning to the first key left the panel loading with nothing to end it. It now loads the first key again.

### Changed

- **The Health action controller is now a reducer.** Forget, Mark wrong, Resolve and Pin keep their state in one pure `reduce(state, event)` over an exhaustive event union, with each row's state held as independent lanes that each carry a phase. Timers and requests run as effects of that state. What you see on the dashboard is unchanged.
