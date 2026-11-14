import type { FrameBrand } from '../lib/brand-tokens';

/**
 * The 36px logo tile and the brand name, shared by the portal and partner frames. The tile is the
 * brand fill with the brand foreground; an image logo gets `alt` from the brand name (AC-19), and
 * without a logo the tile shows the first letter of the name as decoration. It must never colour
 * anything but the tile, and never carry text the app did not pass.
 */
export function BrandMark({ brand }: { brand: FrameBrand }) {
  const initial = Array.from(brand.name.trim())[0]?.toUpperCase() ?? '';
  return (
    <span data-slot="brand-mark" className="flex min-w-0 items-center gap-3">
      {brand.logoUrl ? (
        <img
          src={brand.logoUrl}
          alt={brand.name}
          width={36}
          height={36}
          className="size-9 shrink-0 rounded-control bg-brand object-contain"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand text-base font-semibold text-brand-foreground"
        >
          {initial}
        </span>
      )}
      <span className="truncate text-base font-semibold">{brand.name}</span>
    </span>
  );
}
