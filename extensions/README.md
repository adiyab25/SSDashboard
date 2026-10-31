# Extensions

Per client extension packages live here as `extensions/<client>`, one workspace package each. They are compiled into a thin derived image (`FROM ssdashboard-app:<version>` plus the extension) and listed in the `EXTENSIONS` env var. The api loads them at startup (`apps/api/src/extensions/load-extensions.ts`). The core never imports an extension.

The hook contract an extension implements is decided in feature 46. Until then this folder stays empty.
