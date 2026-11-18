### Changed

- **/teams/ has the home page's look**: the dark theme, the floating nav, numbered section heads with the colour bar, the home buttons and the home footer. Its wording is unchanged.
- **The home page's head, nav and footer live in `layouts/Lagoon.astro`, `LagoonNav` and `LagoonFooter`**, so the home page and /teams/ share one copy, and any other page can switch to the dark look with the same layout.
