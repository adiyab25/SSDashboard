'use client';

import type {
  PartnerAccount,
  PartnerUserRow,
  StaffSetup,
  StaffStatus,
} from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ssdashboard/ui/components/dropdown-menu';
import { Input } from '@ssdashboard/ui/components/input';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { LoaderCircleIcon, MoreHorizontalIcon, PlusIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { peoplePanelId, peopleTabId } from './people-tabs';
import { PartnerUserFormDialog } from './partner-user-form-dialog';
import { PartnerUserMoveDialog } from './partner-user-move-dialog';
import {
  disablePartnerUser,
  enablePartnerUser,
  listPartnerAccounts,
  listPartnerUsers,
  resendPartnerInvite,
  resetPartnerUserPassword,
  resetPartnerUserTwoFactor,
  revokePartnerUserSessions,
  type PartnerUserFilter,
} from './partner-users-api';
import type { ApiResult } from './api-request';
import { StaffConfirmDialog, type ConfirmKind } from './staff-confirm-dialog';
import { StaffSetupDialog } from './staff-setup-dialog';

const STATUSES: readonly StaffStatus[] = ['invited', 'active', 'disabled'];
const SELECT =
  'h-9 min-w-0 rounded-md border border-input bg-transparent px-2 text-base shadow-xs outline-none focus-ring md:text-sm dark:bg-input/30';
const SEARCH_DELAY_MS = 300;
const COLUMNS = ['name', 'email', 'account', 'status', 'lastSignIn', 'twoFactor'] as const;

interface Page {
  key: string;
  rows: PartnerUserRow[];
  next: string | null;
  failed: boolean;
}

type Dialog =
  | { kind: 'form'; editId: string | null }
  | { kind: 'move'; row: PartnerUserRow; opener: HTMLElement | null }
  | { kind: 'confirm'; action: ConfirmKind; row: PartnerUserRow }
  | { kind: 'setup'; setup: StaffSetup; reason: 'invite' | 'reset'; name: string };

interface Props {
  /** True when this install sends email: a reset sends a link and Resend invite is offered. */
  mailEnabled: boolean;
  /** Language codes enabled on the install (`GET /api/config`). */
  languages: readonly string[];
}

/**
 * The Partner logins tab of the people screen (spec 0008, AC-15, AC-18): list the logins of
 * consignment partners filtered by partner account, status and search, add one bound to a partner
 * account, edit details, move one to another account with a reason, reset a password or two
 * factor, sign someone out everywhere, resend an invite, and disable or enable. Only drawn on the
 * people screen, which needs `people.manage`; the api answers 403 anyway. It decides no rule: a
 * partner login has no hats and no cost, and the account changes only through the move dialog.
 */
export function PartnerLoginsTab({ mailEnabled, languages }: Props) {
  const { t } = useTranslation();
  const format = useFormat();
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<PartnerUserFilter>({
    q: '',
    status: '',
    partnerAccountId: '',
  });
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [message, setMessage] = useState('');
  const [accounts, setAccounts] = useState<readonly PartnerAccount[]>([]);
  const [accountsFailed, setAccountsFailed] = useState(false);
  const [accountsReload, setAccountsReload] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  // Each row's actions button, so focus can go back to it after the move dialog.
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  // The row whose actions button takes focus once the list has reloaded after a save.
  const focusAfterLoad = useRef<string | null>(null);

  const key = JSON.stringify([filter, reload]);
  const loading = page === null || page.key !== key;
  // A login bound to an archived account, or any login while the accounts list failed, still
  // gets a plain label instead of an empty cell.
  const accountName = (id: string) =>
    accounts.find((account) => account.id === id)?.name ?? t('staff.partners.account.unknown');

  useEffect(() => {
    let active = true;
    void listPartnerAccounts().then((result) => {
      if (!active) return;
      setAccountsFailed(!result.ok);
      if (result.ok) setAccounts(result.data);
    });
    return () => {
      active = false;
    };
  }, [accountsReload]);

  // Loads the first page whenever the filter changes or something was saved. State is only set
  // when the answer arrives, so a slow answer for an old filter can never replace a newer one.
  useEffect(() => {
    let active = true;
    void listPartnerUsers(filter).then((result) => {
      if (!active) return;
      setPage({
        key,
        rows: result.ok ? result.data.rows : [],
        next: result.ok ? result.data.nextCursor : null,
        failed: !result.ok,
      });
    });
    return () => {
      active = false;
    };
  }, [filter, key]);

  // After a save reloads the list the old row buttons are gone; focus goes to the new one.
  useEffect(() => {
    if (loading || focusAfterLoad.current === null) return;
    triggers.current.get(focusAfterLoad.current)?.focus();
    focusAfterLoad.current = null;
  }, [loading, page]);

  function onSearch(value: string) {
    setText(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => setFilter((current) => ({ ...current, q: value.trim() })),
      SEARCH_DELAY_MS,
    );
  }

  async function loadMore() {
    if (!page?.next || loadingMore) return;
    setLoadingMore(true);
    const result = await listPartnerUsers(filter, page.next);
    setLoadingMore(false);
    if (!result.ok) {
      setMessage(t('staff.partners.loadError'));
      return;
    }
    const data = result.data;
    setPage((current) =>
      current && current.key === key
        ? { ...current, rows: [...current.rows, ...data.rows], next: data.nextCursor }
        : current,
    );
  }

  /** Runs an action, then refreshes the list. Resolves to an error message, or null on success. */
  async function run<T>(
    action: Promise<ApiResult<T>>,
    done: (data: T) => void,
  ): Promise<string | null> {
    const result = await action;
    if (!result.ok) {
      const known = `staff.partners.errors.${result.code}` as MessageKey;
      return t(known, { defaultValue: t('staff.partners.errors.generic') });
    }
    done(result.data);
    setReload((count) => count + 1);
    return null;
  }

  async function runConfirmed(action: ConfirmKind, row: PartnerUserRow, reason: string) {
    const close = (note: string) => {
      setDialog(null);
      setMessage(note);
    };
    if (action === 'disable') {
      return run(disablePartnerUser(row.id, reason), () => close(t('staff.messages.disabled')));
    }
    if (action === 'twoFactor') {
      return run(resetPartnerUserTwoFactor(row.id), () =>
        close(t('staff.messages.twoFactorReset')),
      );
    }
    if (action === 'revoke') {
      return run(revokePartnerUserSessions(row.id), () => close(t('staff.messages.sessionsEnded')));
    }
    return run(resetPartnerUserPassword(row.id), (data) =>
      setDialog({ kind: 'setup', setup: data.setup, reason: 'reset', name: row.name }),
    );
  }

  async function enable(row: PartnerUserRow) {
    const failure = await run(enablePartnerUser(row.id), () =>
      setMessage(t('staff.messages.enabled')),
    );
    if (failure) setMessage(failure);
  }

  async function invite(row: PartnerUserRow) {
    const failure = await run(resendPartnerInvite(row.id), () =>
      setMessage(t('staff.messages.inviteSent')),
    );
    if (failure) setMessage(failure);
  }

  return (
    <div
      id={peoplePanelId('partners')}
      role="tabpanel"
      aria-labelledby={peopleTabId('partners')}
      className="flex min-w-0 flex-col gap-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-sm text-muted-foreground">
          {t('staff.partners.description')}
        </p>
        <Button onClick={() => setDialog({ kind: 'form', editId: null })}>
          <PlusIcon aria-hidden data-icon="inline-start" />
          {t('staff.partners.add')}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-52 flex-1 flex-col gap-1.5">
          <label htmlFor="partner-users-search" className="text-sm font-medium">
            {t('staff.partners.search')}
          </label>
          <Input
            id="partner-users-search"
            type="search"
            value={text}
            aria-describedby="partner-users-search-hint"
            onChange={(event) => onSearch(event.target.value)}
            autoComplete="off"
          />
          <span id="partner-users-search-hint" className="text-xs text-muted-foreground">
            {t('staff.partners.searchHint')}
          </span>
        </div>
        {/* min-w-0 and max-w-full: a long account name must not stretch the page past a phone's width. */}
        <div className="flex min-w-0 max-w-full flex-col gap-1.5">
          <label htmlFor="partner-users-account" className="text-sm font-medium">
            {t('staff.partners.account.label')}
          </label>
          <select
            id="partner-users-account"
            className={`${SELECT} max-w-full`}
            value={filter.partnerAccountId}
            onChange={(event) =>
              setFilter((current) => ({ ...current, partnerAccountId: event.target.value }))
            }
          >
            <option value="">{t('staff.partners.account.all')}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.code})
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="partner-users-status" className="text-sm font-medium">
            {t('staff.status.label')}
          </label>
          <select
            id="partner-users-status"
            className={SELECT}
            value={filter.status}
            onChange={(event) =>
              setFilter((current) => ({
                ...current,
                status: STATUSES.find((status) => status === event.target.value) ?? '',
              }))
            }
          >
            <option value="">{t('staff.status.all')}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`staff.status.${status}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {accountsFailed && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('staff.partners.account.loadError')}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAccountsReload((count) => count + 1)}
            >
              {t('staff.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {message}
      </p>

      {page?.key === key && page.failed ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('staff.partners.loadError')}
            <Button size="sm" variant="outline" onClick={() => setReload((count) => count + 1)}>
              {t('staff.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div
          role="region"
          // A scrolling region must be reachable by keyboard (axe scrollable-region-focusable).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          aria-label={t('staff.partners.columns.table')}
          className="relative overflow-x-auto rounded-lg border focus-ring"
        >
          <table className="w-full text-sm" aria-busy={loading}>
            <thead className="bg-muted text-start">
              <tr className="h-row-header">
                {COLUMNS.map((column) => (
                  <th key={column} scope="col" className="px-3 text-start font-medium">
                    {t(`staff.partners.columns.${column}`)}
                  </th>
                ))}
                <th scope="col" className="w-12 px-3 text-start font-medium">
                  <span className="sr-only">{t('staff.partners.columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 5 }, (_, index) => (
                  <tr key={index} className="h-row border-t" aria-hidden>
                    <td colSpan={COLUMNS.length + 1} className="px-3">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  </tr>
                ))}
              {!loading && page?.rows.length === 0 && (
                <tr>
                  <td
                    colSpan={COLUMNS.length + 1}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    {t('staff.partners.empty')}
                  </td>
                </tr>
              )}
              {!loading &&
                page?.rows.map((row) => (
                  <tr key={row.id} className="h-row border-t">
                    <td className="px-3 font-medium">{row.name}</td>
                    <td className="px-3">
                      <LtrText>{row.email}</LtrText>
                    </td>
                    <td className="px-3">{accountName(row.partnerAccountId)}</td>
                    <td className="px-3">{t(`staff.status.${row.status}`)}</td>
                    <td className="px-3">
                      {row.lastSignInAt ? format.dateTime(row.lastSignInAt) : t('staff.never')}
                    </td>
                    <td className="px-3">
                      {row.twoFactorEnabled ? t('staff.on') : t('staff.off')}
                    </td>
                    <td className="px-3">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            ref={(node) => {
                              if (node) triggers.current.set(row.id, node);
                              else triggers.current.delete(row.id);
                            }}
                            variant="ghost"
                            size="icon-sm"
                            className="coarse:min-h-touch coarse:min-w-touch"
                            aria-label={t('staff.partners.row.menu', { name: row.name })}
                          >
                            <MoreHorizontalIcon aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => setDialog({ kind: 'form', editId: row.id })}
                          >
                            {t('staff.partners.row.edit')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              setDialog({
                                kind: 'move',
                                row,
                                opener: triggers.current.get(row.id) ?? null,
                              })
                            }
                          >
                            {t('staff.partners.row.move')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setDialog({ kind: 'confirm', action: 'reset', row })}
                          >
                            {t('staff.partners.row.resetPassword')}
                          </DropdownMenuItem>
                          {row.status === 'invited' && mailEnabled && (
                            <DropdownMenuItem onSelect={() => void invite(row)}>
                              {t('staff.partners.row.resendInvite')}
                            </DropdownMenuItem>
                          )}
                          {row.twoFactorEnabled && (
                            <DropdownMenuItem
                              onSelect={() =>
                                setDialog({ kind: 'confirm', action: 'twoFactor', row })
                              }
                            >
                              {t('staff.partners.row.resetTwoFactor')}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onSelect={() => setDialog({ kind: 'confirm', action: 'revoke', row })}
                          >
                            {t('staff.partners.row.revokeSessions')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {row.status === 'disabled' ? (
                            <DropdownMenuItem onSelect={() => void enable(row)}>
                              {t('staff.partners.row.enable')}
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() =>
                                setDialog({ kind: 'confirm', action: 'disable', row })
                              }
                            >
                              {t('staff.partners.row.disable')}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && page?.next && (
        <Button
          variant="outline"
          className="self-center"
          disabled={loadingMore}
          aria-busy={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore && (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          )}
          {t('staff.loadMore')}
        </Button>
      )}

      {dialog?.kind === 'form' && (
        <PartnerUserFormDialog
          editId={dialog.editId}
          accounts={accounts}
          languages={languages}
          onClose={() => setDialog(null)}
          onSaved={({ partnerUser, created, emailChanged }) => {
            setReload((count) => count + 1);
            if (created) {
              setDialog({
                kind: 'setup',
                setup: created,
                reason: 'invite',
                name: partnerUser.name,
              });
              setMessage(t('staff.partners.messages.created'));
            } else {
              setDialog(null);
              setMessage(
                emailChanged
                  ? t(
                      mailEnabled
                        ? 'staff.messages.emailChangedInvite'
                        : 'staff.messages.emailChangedReset',
                    )
                  : t('staff.partners.messages.saved'),
              );
            }
          }}
        />
      )}
      {dialog?.kind === 'move' && (
        <PartnerUserMoveDialog
          partnerUserId={dialog.row.id}
          name={dialog.row.name}
          accounts={accounts}
          opener={dialog.opener}
          onClose={() => setDialog(null)}
          onSaved={() => {
            focusAfterLoad.current = dialog.row.id;
            setDialog(null);
            setMessage(t('staff.partners.messages.moved'));
            setReload((count) => count + 1);
          }}
        />
      )}
      {dialog?.kind === 'confirm' && (
        <StaffConfirmDialog
          kind={dialog.action}
          name={dialog.row.name}
          mailEnabled={mailEnabled}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => runConfirmed(dialog.action, dialog.row, reason)}
        />
      )}
      {dialog?.kind === 'setup' && (
        <StaffSetupDialog
          setup={dialog.setup}
          reason={dialog.reason}
          name={dialog.name}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
