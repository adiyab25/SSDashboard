import { Logger } from '@nestjs/common';

/**
 * Loads the per client extension packages named in `EXTENSIONS`.
 * The core never imports an extension directly. The hook contract
 * extensions must implement is decided in feature 46; until then this
 * only proves each listed package can be imported.
 */
export async function loadExtensions(names: string[]): Promise<unknown[]> {
  const logger = new Logger('Extensions');
  const loaded: unknown[] = [];
  for (const name of names) {
    loaded.push(await import(name));
    logger.log(`Loaded extension ${name}`);
  }
  return loaded;
}
