### Tests

- **Tests that asserted regexes over source text are gone or now run the behaviour.** The card wiring test goes through the flag parser and the command table, the `hippo context` test counts the rows the context admitted, and the source-text copies of contracts that already had a behaviour test are removed along with four duplicate or assertion-free declarations.
- **Negative assertions no longer follow a fixed sleep.** Eight tests waited a fixed time and then asserted that nothing happened; each now waits on the event that proves the decision was taken (a held resolver answer, a hand-fired heartbeat tick, the request's socket close, the recorded spawn list) and carries a control that shows the opposite outcome on the same setup.
