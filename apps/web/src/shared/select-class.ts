/** The look of a native `select` on every screen: control height, control corners, the `input` boundary, and the `bg-field` fill (page colour, card colour on a card in light). It must never add a shadow or a `dark:` fill of its own. */
export const SELECT_CLASS =
  'h-control w-full min-w-0 rounded-control border border-input bg-field px-2.5 text-base outline-none focus-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm';
