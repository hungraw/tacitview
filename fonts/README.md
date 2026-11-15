# Fonts

Served from this site so a visit makes no request to a font CDN.

- Schibsted Grotesk (variable, latin subset): Schibsted, SIL Open Font License 1.1, https://github.com/schibsted/schibsted-grotesk
- Geist Mono (variable, latin subset): Vercel, SIL Open Font License 1.1, https://github.com/vercel/geist-font

Files are the latin-subset woff2 builds published on Google Fonts, cut further (2026-11-11, fontTools pyftsubset, run once outside the project) to the characters the site uses: U+0020-007E, U+00A0, U+00A7, U+00B7, U+00D7, U+2013, U+2014, U+2016, U+2018, U+2019, U+201C, U+201D, U+2022, U+2026, U+203A, U+2190-2192, U+2212; features kern, liga, calt, tnum. 70 KB to 40 KB. Anything else falls back to the system font. License text: https://openfontlicense.org
