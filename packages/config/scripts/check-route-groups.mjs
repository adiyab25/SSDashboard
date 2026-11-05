#!/usr/bin/env node
// Fails when apps/web/src/app has a top level route group other than the four audiences.
// Spec 0007, Conventions (Organisation and naming).
//
// Usage: node check-route-groups.mjs [<repo root>]   (default: the current directory)
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOWED_GROUPS = ['(backoffice)', '(portal)', '(partner)', '(auth)'];

/** The route group folders directly under an app directory that are not allowed. */
export function badRouteGroups(appDir) {
  if (!existsSync(appDir)) return [];
  return readdirSync(appDir).filter(
    (name) =>
      /^\(.+\)$/.test(name) &&
      statSync(join(appDir, name)).isDirectory() &&
      !ALLOWED_GROUPS.includes(name),
  );
}

function main(args) {
  const root = args[0] ?? process.cwd();
  const appDir = join(root, 'apps', 'web', 'src', 'app');
  const bad = badRouteGroups(appDir);
  for (const name of bad) console.error(relative(process.cwd(), join(appDir, name)));
  if (bad.length > 0) {
    console.error(
      `\n${bad.length} route ${bad.length === 1 ? 'group is' : 'groups are'} not an audience. ` +
        `Allowed: ${ALLOWED_GROUPS.join(', ')}.`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
