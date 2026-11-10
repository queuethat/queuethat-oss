# Fonts

QueueThat ships two faces, both SIL Open Font License (`apps/web/public/fonts/GEIST-OFL-LICENSE.txt`):

| Role | Face | File |
| ---- | ---- | ---- |
| UI and headlines | Geist (variable, weights 100 to 900) | `apps/web/public/fonts/geist-latin-var.woff2` |
| Ticket numbers, codes | Geist Mono (variable) | `apps/web/public/fonts/geist-mono-latin-var.woff2` |

There is no serif and no request to a font CDN: the CSP keeps `font-src 'self'`, the UI face is
preloaded from `index.html`, and the service worker precaches `woff2`. Only the UI face is preloaded;
the mono face loads when a ticket number is first painted.

## Regenerate the subsets

```sh
npm pack geist@1.9.0 && tar xzf geist-1.9.0.tgz
U="U+0020-007E,U+00A0-00FF,U+0100-017F,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2013-2014,U+2018-201E,U+2022,U+2026,U+2030,U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212,U+00D7"
pyftsubset package/dist/fonts/geist-sans/Geist-Variable.woff2 --unicodes="$U" --flavor=woff2 \
  --layout-features='kern,liga,calt,tnum,ccmp,locl,case' --output-file=geist-latin-var.woff2
pyftsubset package/dist/fonts/geist-mono/GeistMono-Variable.woff2 --unicodes="$U" --flavor=woff2 \
  --layout-features='kern,tnum,zero,ccmp,locl' --output-file=geist-mono-latin-var.woff2
```

The range covers English, German and the other Western European locales. A locale needing more
glyphs (Cyrillic, Greek, Vietnamese) adds a second subset with a `unicode-range` `@font-face`.
