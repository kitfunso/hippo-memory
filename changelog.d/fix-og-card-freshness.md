### Fixed

- **hippo-memory.com share cards show each page's current title.** The home card still showed the title from before the new home page, so a link posted to X or LinkedIn showed old text. `npm run build` now fails when a page title differs from its card's, and each card link carries a hash of the image, so a redrawn card gets a new link that X and LinkedIn fetch again.
