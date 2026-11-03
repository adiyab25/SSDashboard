import { messages } from './messages.en';

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** A dotted path to one string in `messages.en.ts`. A wrong key fails the type check. */
export type MessageKey = Leaves<typeof messages>;

/** The English text for a key. */
export function t(key: MessageKey): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  return node as string;
}
