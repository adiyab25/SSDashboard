// Public portal frame (spec 0007, section 2): not the staff app shell, no staff session check, no staff navigation. The page is public.
export default function PortalLayout({ children }: LayoutProps<'/'>) {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-2xl p-6 outline-none">
      {children}
    </main>
  );
}
