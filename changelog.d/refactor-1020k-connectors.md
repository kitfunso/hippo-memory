### Changed

- **The `connectorEvents` store group has one method per concept: 22 methods became 15.** `eventRecord` and `markEventSeen` take the deletion lookup and archive, `route` answers Slack and GitHub tenant routing, `deadLetters` reads a page or one row, and `cursor` and `saveCursor` hold every backfill position. Webhook replies, replay holds, dead letters and stored rows do not change. `docs/UPGRADING-3.0.md` lists each old and new name.
- **`ledger.writeDeliveryEvent` is gone; `ledger.recordTurn({ uses: [], delivery })` books a delivery event alone.**
