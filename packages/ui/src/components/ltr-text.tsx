import { cn } from 'cn';

/**
 * A code that always reads left to right, even inside right to left text: a SKU, barcode,
 * document number, email, URL, or version. `bdi` isolates it from the surrounding text so
 * `SKU-A/12` keeps its order; `dir="ltr"` sets its own direction. It sets the monospace face
 * (Geist Mono) so codes read apart from names; it must never be used for prose.
 */
function LtrText({ className, ...props }: React.ComponentProps<'bdi'>) {
  return <bdi data-slot="ltr-text" dir="ltr" className={cn('font-mono', className)} {...props} />;
}

export { LtrText };
