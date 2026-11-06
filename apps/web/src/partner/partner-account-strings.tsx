'use client';

import type { Catalog } from '@ssdashboard/i18n';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Hands the account and sign in groups of the page's language to the partner frame. The frame
 * carries only the groups the partner pages read (`public-root-frame.tsx`), so the account screen
 * would show Arabic keys without this. The groups are added before the children first render, so
 * the text is right in the first byte. English is bundled and needs nothing. It must never
 * replace a group the frame already carries.
 */
export function PartnerAccountStrings({
  language,
  catalog,
  children,
}: {
  language: string;
  catalog: Catalog;
  children: React.ReactNode;
}) {
  const { i18n } = useTranslation();
  useState(() => {
    if (language !== 'en') i18n.addResourceBundle(language, 'translation', catalog, true, false);
    return true;
  });
  return children;
}
