### Fixed

- **The dashboard map no longer treats your home folder as a project.** Memories captured in the home folder carry its name as a path tag, and the map pulled every such memory toward one "project" anchor. The home folder's tags were hard-coded to a single machine's folder name, so on every other machine they were not left out. The dashboard server now sends the running user's home-folder tags in `/api/config`, and the map leaves them out of project anchoring.
