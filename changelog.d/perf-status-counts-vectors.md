### Changed

- `hippo status` now counts stored vectors from their ids and one blob length instead of decoding every vector, so on a synthetic store of 20,000 vectors at 384 dimensions the read fell from a median 301 ms to 14 ms. The printed text is unchanged.
