### Fixed

- **The Z0 runner's git retries a loose object that Windows antivirus is still holding.** Git failed with `unable to write file .git/objects/..: Permission denied`, and the runner then voided the cell and blamed the agent. A stage 2 proof hit it 14 times in 44 state commits. Each retry is counted and the total is printed at the end of a run, and the snapshot builder uses the same retry.
