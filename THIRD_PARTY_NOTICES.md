# Third-party notices

MacTint is an unofficial tribute to MacPaint (Apple, 1984). It is not made, endorsed or
supported by Apple Inc. "Macintosh" and "MacPaint" are trademarks of Apple Inc.

## `classic-data.js` is not covered by the MIT licence

The file `classic-data.js` holds reference data taken from original Apple software. It is
included so that the application runs as published, but **it remains the property of Apple
Inc. and is not licensed to you by this repository**. The MIT licence in `LICENSE` applies
only to the code written for MacTint.

What the file contains:

- **Bitmap font strikes** of the original Macintosh system fonts: Geneva, Chicago, New York,
  Monaco, Venice, Athens, London, Toronto, Los Angeles, Symbol, San Francisco, Taliesin and
  Cairo. Source: the *Macintosh OS 1-6 / Originals* archive of
  <https://github.com/JohnDDuncanIII/macfonts> (commit `2091a81a`), SHA-256 of the archive
  `0e10717d0307887bd7d29715f1529bc8381908ebbacc972f465fd63ddff39c47`.
- **MacPaint 1.5 resources**: menu titles and items, the 38 fill patterns, the tool palette
  icons, the window chrome and the help screens. Source:
  <https://archive.org/details/mac_Paint_2>.

If you reuse MacTint in your own project, replace this file with data you have the right to
use, or obtain permission from the rights holder.

If you are the rights holder and want this material removed, open an issue on this
repository: it will be taken down.

## Everything else

`colorpaint.js`, `studio.js` and `index.html` use no third-party library and make no network
request. All sound is synthesised in the browser with the Web Audio API; no audio file is
shipped.
