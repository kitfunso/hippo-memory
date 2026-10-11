### Fixed

- **The sharing-scrub speed test no longer fails at random on busy runners.** It used to divide the time for a 1 MB input by the time for a 64 KB one, and the small reading was under a millisecond, so timer noise could push the ratio over its limit. It now compares one 1 MB scrub with sixteen 64 KB scrubs of the same bytes. Linear work reads near 1 and quadratic work near 16, and the limit is 4.
