### Fixed

- **Default capture keeps a plain imperative rule from a later reply.** A reply such as "Cut a new branch and write a failing test for the feature" was dropped unless it named code or held a limiting word, so the same mistake came back. Capture now also keeps a statement of four or more words that opens on an imperative verb, past any leading symbols or short labels such as "No:". Opt-in model capture still catches the rules the verb list misses.
