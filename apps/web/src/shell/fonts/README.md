# Fonts

The three variable font files `root-fonts.ts` loads with `next/font/local`. They are committed so that building the web image needs no request to Google or any font host (spec 0003, AC-23). All three are SIL Open Font License 1.1; the license texts ship in `public/licenses/fonts/`.

| File                                  | Family           | Upstream                                                      | Version (font `name` table) | Subset and `unicode-range`                                                              | Weight range | License                                                              |
| ------------------------------------- | ---------------- | ------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| `inter-latin-variable.woff2`          | Inter            | The Inter Project, <https://github.com/rsms/inter>            | `Version 4.001;git-66647c0bb` | latin: `U+0000-00FF`, `U+0131`, `U+0152-0153`, `U+02BB-02BC`, `U+02C6`, `U+02DA`, `U+02DC`, `U+0304`, `U+0308`, `U+0329`, `U+2000-206F`, `U+20AC`, `U+2122`, `U+2191`, `U+2193`, `U+2212`, `U+2215`, `U+FEFF`, `U+FFFD` | 100 to 900   | OFL 1.1, [inter-OFL.txt](../../../public/licenses/fonts/inter-OFL.txt) |
| `noto-sans-arabic-arabic-variable.woff2` | Noto Sans Arabic | The Noto Project, <https://github.com/notofonts/arabic>       | `Version 2.012`             | arabic: `U+0600-06FF` (covers U+0660-0669 and U+06F0-06F9), `U+0750-077F`, `U+0870-0891`, `U+0897-08E1`, `U+08E3-08FF`, `U+200C-200E`, `U+2010-2011`, `U+204F`, `U+2E41`, `U+FB50-FDFF`, `U+FE70-FE74`, `U+FE76-FEFC`, plus the Arabic blocks above `U+10000` listed in `root-fonts.ts` | 100 to 900   | OFL 1.1, [noto-sans-arabic-OFL.txt](../../../public/licenses/fonts/noto-sans-arabic-OFL.txt) |
| `jetbrains-mono-latin-variable.woff2` | JetBrains Mono   | The JetBrains Mono Project, <https://github.com/JetBrains/JetBrainsMono> | `Version 2.211`             | latin: same `unicode-range` as Inter's file above                                        | 100 to 800   | OFL 1.1, [jetbrains-mono-OFL.txt](../../../public/licenses/fonts/jetbrains-mono-OFL.txt) |

The files are the woff2 subsets Google Fonts serves for the `latin` and `arabic` subsets of each family (the same ones `next/font/google` used to download), copied unchanged. The `unicode-range` values are the ones in `root-fonts.ts`; keep the two in step.

Western digits and Latin text inside an Arabic page are not in the Noto Sans Arabic file (its `latin` subset is not kept), so they fall back to Inter through the `--font-arabic` stack in `packages/ui/src/styles/globals.css`.

`root-fonts.ts` turns off the generated Arial fallback face (`adjustFontFallback: false`) and lists each real family name in `fallback`; the comment there says why (Turbopack names the CSS variable after the const, not the face).

## How to update a font

1. Fetch the new file from upstream (the Google Fonts CSS for the family, `subset` `latin` or `arabic`, lists the woff2 URL per `unicode-range`) and replace the file here, keeping the name.
2. Read the new version from the font's `name` table (name id 5) and update the table above; update `unicode-range` and the weight range in `root-fonts.ts` and here if they changed.
3. Check that Noto Sans Arabic still maps U+0660-0669 and U+06F0-06F9 in its cmap.
4. Re-run `pnpm --filter @ssdashboard/web build`, the web tests, and the Playwright `shell`, `localization`, and `production` specs.
