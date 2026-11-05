// Partner frame (spec 0007, section 2): not the staff app shell and no staff navigation. It will get its own partner session check with the partner feature.
export default function PartnerLayout({ children }: LayoutProps<'/'>) {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-2xl p-6 outline-none">
      {children}
    </main>
  );
}
