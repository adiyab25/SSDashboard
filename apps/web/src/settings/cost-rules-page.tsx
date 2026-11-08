'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { CostRulesView } from './cost-rules-view';

/**
 * The Cost rules page at `/settings/cost-rules` (spec 0009, AC-23, AC-25, D15). Opened by its
 * address without `cost.view` it shows the no access state and asks the api for nothing; a person
 * with `cost.view` reads the rules, and only one who also holds `settings.manage` gets the New rule
 * action. The api enforces both permissions too. If the who am I call fails it shows an error with
 * Try again.
 */
export function CostRulesPage() {
  const access = useAccess();
  const allowed = access.can('cost.view');

  if (access.failed) {
    return <AccessErrorState titleKey="settings.costRules.title" onRetry={access.retry} />;
  }
  if (access.ready && !allowed) return <NoAccessState titleKey="settings.costRules.title" />;
  return <CostRulesView enabled={allowed} canAdd={allowed && access.can('settings.manage')} />;
}
