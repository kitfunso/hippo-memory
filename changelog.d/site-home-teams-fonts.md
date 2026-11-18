### Changed

- **The home page uses the same fonts as every other page**: Newsreader for headings, the logo and big figures, Geist for text, small labels and the score table, and Geist Mono for code. It loads them with the same Astro font tags as the other pages, so the site ships five fewer font packages.

### Fixed

- **The 3D memory cards on the home page repaint in the loaded font.** A card with no content yet stopped the repaint, so other cards kept the fallback face.
