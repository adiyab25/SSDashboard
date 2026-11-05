// One undocumented export of every kind. `check-tsdoc-fixture.mjs` lints this file with the
// real shared config and fails unless `jsdoc/require-jsdoc` reports the declaration that
// follows each `kind:` marker (the marker sits on the line above, so Prettier keeps it valid).

// kind: function
export function undocumentedFunction() {
  return 1;
}

// kind: class
export class UndocumentedClass {
  // kind: method
  publicMethod() {
    return 1;
  }
}

// kind: interface
export interface UndocumentedInterface {
  id: string;
}

// kind: type alias
export type UndocumentedTypeAlias = { id: string };

// kind: enum
export enum UndocumentedEnum {
  A,
  B,
}

// kind: exported const
export const UNDOCUMENTED_CONSTANT = 42;

// kind: React component
export const UndocumentedComponent = () => <div />;

// kind: hook
export function useUndocumentedHook() {
  return 1;
}
