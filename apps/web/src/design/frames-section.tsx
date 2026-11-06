'use client';

type FramePreviewSpec = {
  /** The accessible name of the iframe, which names the sample and its reading direction. */
  title: string;
  path: string;
};

const SAMPLES: readonly { heading: string; note: string; frames: readonly FramePreviewSpec[] }[] = [
  {
    heading: 'Portal with the sample brand',
    note: 'Brand #0A7C39 and a sample logo. The accent colours only the top rule, the logo tile, and the main button; the focus ring stays the system ring.',
    frames: [
      {
        title: 'Portal frame with the sample brand, left to right',
        path: '/en/returns/preview/brand',
      },
      {
        title: 'Portal frame with the sample brand, right to left',
        path: '/ar/returns/preview/brand',
      },
    ],
  },
  {
    heading: 'Portal with a rejected accent',
    note: 'Brand #A9780B fails both foregrounds, so the portal keeps the neutral primary and says why, with the nearest accepted colour.',
    frames: [
      {
        title: 'Portal frame with a rejected accent, left to right',
        path: '/en/returns/preview/rejected',
      },
      {
        title: 'Portal frame with a rejected accent, right to left',
        path: '/ar/returns/preview/rejected',
      },
    ],
  },
  {
    heading: 'Partner frame',
    note: 'Logo, partner name, and the three tabs of the partner area: statements, stock at your location, settlement.',
    frames: [
      { title: 'Partner frame with sample tabs, left to right', path: '/en/partner/preview' },
      { title: 'Partner frame with sample tabs, right to left', path: '/ar/partner/preview' },
    ],
  },
];

/**
 * The three frames of the system (spec 0003, AC-18). `PortalFrame` and `PartnerFrame` each render
 * their own `main`, and this page already has one, so each sample is a dev only preview page shown
 * in an `<iframe>`: it uses the real public document (its own `html lang dir`, fonts, and theme).
 * `AppShell` is the third frame, and it is the one this gallery sits in. It must never nest a
 * frame inline, which would put two `main` landmarks on the page.
 */
export function FramesSection() {
  return (
    <div className="flex flex-col gap-8">
      <p className="text-muted-foreground">
        The back office frame is <code className="font-mono">AppShell</code>: the sidebar, top bar,
        and command palette around this page. The other two are shown below as separate pages in
        frames, because each renders its own main landmark.
      </p>
      {SAMPLES.map((sample) => (
        <div key={sample.heading} className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">{sample.heading}</h3>
          <p className="text-xs text-muted-foreground">{sample.note}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {sample.frames.map((frame) => (
              <iframe
                key={frame.path}
                src={frame.path}
                title={frame.title}
                loading="lazy"
                className="h-[34rem] w-full rounded-lg border bg-background"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
