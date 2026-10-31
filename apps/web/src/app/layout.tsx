import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SSDashboard',
  description: 'Warehouse and ERP back office',
};

// Language and direction switching come with feature 5 (localization).
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
