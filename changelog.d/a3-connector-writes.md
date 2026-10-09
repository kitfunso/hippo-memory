### Changed

- **Internal: connector writes run through a store group.** A Slack or GitHub write and its event log row go through an optional `connectorWrites` group on the store port, so no database handle crosses the api contract. No behaviour changes on hippo.db.
