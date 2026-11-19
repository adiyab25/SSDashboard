import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { Slot } from 'radix-ui';

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-control border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-ui press outline-none select-none focus-ring disabled:pointer-events-none disabled:border-border disabled:bg-card disabled:bg-none disabled:text-muted-foreground disabled:shadow-none aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'lift sheen gradient-primary border-primary-edge font-semibold text-primary-foreground disabled:font-medium',
        brand:
          'lift bg-brand font-semibold text-brand-foreground hover:bg-brand/90 disabled:font-medium',
        outline:
          'lift border-input bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
        secondary:
          'lift gradient-secondary-edge text-secondary-foreground hover:text-foreground disabled:[background:var(--card)] aria-expanded:text-foreground',
        ghost:
          'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
        destructive: 'lift bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default:
          'h-control gap-1.5 px-2.5 in-data-[slot=button-group]:rounded-control has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2',
        xs: "h-6 gap-1 rounded-control px-2 text-xs in-data-[slot=button-group]:rounded-control has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1 rounded-control px-2.5 in-data-[slot=button-group]:rounded-control has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5',
        lg: 'h-control gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2',
        icon: 'size-control',
        'icon-xs':
          "size-6 rounded-control in-data-[slot=button-group]:rounded-control [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8 rounded-control in-data-[slot=button-group]:rounded-control',
        'icon-lg': 'size-control',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

/** The base action control, with variants and sizes from the design system; use asChild to render a link or other trigger. */
function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
