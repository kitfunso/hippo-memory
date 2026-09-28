### Documentation

- **The LongMemEval comparison with gbrain now compares like with like.** gbrain's 97.6% counted a hit when any answer session was in the top 5. Its report now leads with the stricter measure, every answer session in the top 5 over the 470 questions that have an answer: 95.53% with a reranker and 93.19% without. Hippo's MiniLM runs score 86.8 to 88.5% on that measure, so the README and website no longer call the two tied.
- **`hippo init --scan ~` is described as it behaves.** It installs the Claude Code hooks and the OpenCode plugin but adds no block to any `CLAUDE.md` or `AGENTS.md`.
- **Supersession is no longer listed as measured helping.** The mechanism audit measured outcome marks and retrieval strengthening; supersession has not been measured.
- **Smaller README and website fixes.** Error memories start with a 730-day half-life, the GitHub connector route is listed, the Cursor import examples use `.cursor/rules`, and Windsurf is now Devin Desktop.
