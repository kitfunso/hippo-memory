### Changed

- **The typed-object routes run through a store group.** A new optional `objects` group on the store port serves the list, get, close, save and supersede routes of decisions, processes, policies, skills, project briefs and customer notes, and the list, get and close routes of incidents. The save commits the mirror memory, the object row, the successor link and the audit rows in one transaction inside the store. Internal: no response, audit row or CLI output changes.
