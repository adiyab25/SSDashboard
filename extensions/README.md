# Extensions

Per client extension packages live here as `extensions/<client>`, one workspace package each. They are compiled into a thin derived image (`FROM ssdashboard-app:<version>` plus the extension) and listed in the `EXTENSIONS` env var. The api loads them at startup (`apps/api/src/extensions/load-extensions.ts`). The core never imports an extension.

The hook contract an extension implements is decided in feature 46. Until then this folder stays empty.

## Adding a language

A client adds a language with no code change and no new web image (spec 0004):

1. Copy `packages/i18n/src/locales/en.ts` into `extensions/<client>/locales/<code>.json` (`<code>` is 2 to 3 lowercase letters, for example `fr`). Keys may be nested or flat dotted. Add a `_meta` block with the language's own name and its Intl tag:

   ```json
   { "_meta": { "nativeName": "Français", "intl": "fr-FR" }, "home": { "title": "Aperçu" } }
   ```

   Keys left out fall back to English. Plural keys use the forms the language needs (`_one`, `_few`, `_many`, `_other`, and so on).
2. Add the code to the `languages` setting (for example `["en","ar","fr"]`). Optionally set `default_language`.
3. Reload the back office. Caddy serves the file at `/locales/<code>.json` (it is mounted read only from `extensions/<client>/locales`). A file that is missing, malformed, or has no `_meta` hides that language and logs a console warning; it never breaks the shell.

Right to left is decided by the language code (`ar`, `he`, `fa`, `ur`, `ps`, `sd`, `ug`, `yi`, `dv`, `ckb`).
