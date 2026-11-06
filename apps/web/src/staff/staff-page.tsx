'use client';

import type { StaffRow, StaffSetup, StaffStatus } from '@ssdashboard/contracts';
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
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { useMe } from '@/auth/use-me';
import { useFormat } from '@/i18n/use-format';
import type { MessageKey } from '@ssdashboard/i18n';
import { loadConfig } from '@/shell/client-config';
import {
  disableStaff,
  enableStaff,
  listStaff,
  resendInvite,
  resetStaffPassword,
  resetStaffTwoFactor,
  revokeStaffSessions,
  type ApiResult,
  type StaffFilter,
} from './staff-api';
import { StaffConfirmDialog, type ConfirmKind } from './staff-confirm-dialog';
import { StaffSetupDialog } from './staff-setup-dialog';
import { StaffFormDialog } from './staff-form-dialog';

const STATUSES: readonly StaffStatus[] = ['invited', 'active', 'disabled'];
const SELECT =
  'h-9 min-w-0 rounded-md border border-input bg-transparent px-2 text-base shadow-xs outline-none focus-ring md:text-sm dark:bg-input/30';
const SEARCH_DELAY_MS = 300;

interface Page {
  key: string;
  rows: StaffRow[];
  next: string | null;
  failed: boolean;
}

type Dialog =
  | { kind: 'form'; editId: string | null }
  | { kind: 'confirm'; action: ConfirmKind; row: StaffRow }
  | { kind: 'setup'; setup: StaffSetup; reason: 'invite' | 'reset'; name: string };

/**
 * Staff administration (spec 0005, AC-12 to AC-18): search and filter the list, add and edit
 * people, reset a password, sign someone out everywhere, and disable or enable an account.
 * Needs `people.manage` (spec 0008); without it the page shows the no access state and asks the
 * api for no staff, and the api answers 403 anyway.
 */
export function StaffPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const me = useMe();
  const access = useAccess();
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<StaffFilter>({ q: '', status: '' });
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [message, setMessage] = useState('');
  const [mailEnabled, setMailEnabled] = useState(false);
  const [languages, setLanguages] = useState<readonly string[]>(['en']);
  const timer = useRef<number | undefined>(undefined);

  const key = JSON.stringify([filter, reload]);
  const loading = page === null || page.key !== key;
  const canManage = access.can('people.manage');

  useEffect(() => {
    let active = true;
    void loadConfig().then((config) => {
      if (!active || !config) return;
      setMailEnabled(config.mailEnabled);
      setLanguages(config.languages);
    });
    return () => {
      active = false;
    };
  }, []);

  // Loads the first page whenever the filter changes or something was saved. State is only set
  // when the answer arrives, so a slow answer for an old filter can never replace a newer one.
  useEffect(() => {
    if (!canManage) return;
    let active = true;
    void listStaff(filter).then((result) => {
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
  }, [canManage, filter, key]);

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
    const result = await listStaff(filter, page.next);
    setLoadingMore(false);
    if (!result.ok) {
      setMessage(t('staff.loadError'));
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
      const known = `staff.errors.${result.code}` as MessageKey;
      return t(known, { defaultValue: t('staff.errors.generic') });
    }
    done(result.data);
    setReload((count) => count + 1);
    return null;
  }

  function confirm(action: ConfirmKind, row: StaffRow) {
    setDialog({ kind: 'confirm', action, row });
  }

  async function runConfirmed(action: ConfirmKind, row: StaffRow, reason: string) {
    const close = (text?: string) => {
      setDialog(null);
      if (text) setMessage(text);
    };
    if (action === 'disable') {
      return run(disableStaff(row.id, reason), () => close(t('staff.messages.disabled')));
    }
    if (action === 'twoFactor') {
      return run(resetStaffTwoFactor(row.id), () => close(t('staff.messages.twoFactorReset')));
    }
    if (action === 'revoke') {
      return run(revokeStaffSessions(row.id), () => close(t('staff.messages.sessionsEnded')));
    }
    return run(resetStaffPassword(row.id), (data) =>
      setDialog({ kind: 'setup', setup: data.setup, reason: 'reset', name: row.name }),
    );
  }

  async function enable(row: StaffRow) {
    const failure = await run(enableStaff(row.id), () => setMessage(t('staff.messages.enabled')));
    if (failure) setMessage(failure);
  }

  async function invite(row: StaffRow) {
    const failure = await run(resendInvite(row.id), () =>
      setMessage(t('staff.messages.inviteSent')),
    );
    if (failure) setMessage(failure);
  }

  if (access.ready && !canManage) return <NoAccessState titleKey="staff.title" />;

  // The table's scroll box below is `relative`: the screen reader only header text is absolutely
  // positioned and would otherwise escape the box and widen the whole page.
  const columns = ['name', 'email', 'role', 'status', 'lastSignIn', 'twoFactor'] as const;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{t('staff.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('staff.description')}</p>
        </div>
        <Button onClick={() => setDialog({ kind: 'form', editId: null })}>
          <PlusIcon aria-hidden data-icon="inline-start" />
          {t('staff.add')}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-52 flex-1 flex-col gap-1.5">
          <label htmlFor="staff-search" className="text-sm font-medium">
            {t('staff.search')}
          </label>
          <Input
            id="staff-search"
            type="search"
            value={text}
            aria-describedby="staff-search-hint"
            onChange={(event) => onSearch(event.target.value)}
            autoComplete="off"
          />
          <span id="staff-search-hint" className="text-xs text-muted-foreground">
            {t('staff.searchHint')}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="staff-status" className="text-sm font-medium">
            {t('staff.status.label')}
          </label>
          <select
            id="staff-status"
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

      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {message}
      </p>

      {page?.key === key && page.failed ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('staff.loadError')}
            <Button size="sm" variant="outline" onClick={() => setReload((count) => count + 1)}>
              {t('staff.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="relative overflow-x-auto rounded-lg border">
          <table className="w-full text-sm" aria-busy={loading}>
            <thead className="bg-muted text-start">
              <tr className="h-row-header">
                {columns.map((column) => (
                  <th key={column} scope="col" className="px-3 text-start font-medium">
                    {t(`staff.columns.${column}`)}
                  </th>
                ))}
                <th scope="col" className="w-12 px-3 text-start font-medium">
                  <span className="sr-only">{t('staff.columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 5 }, (_, index) => (
                  <tr key={index} className="h-row border-t" aria-hidden>
                    <td colSpan={columns.length + 1} className="px-3">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  </tr>
                ))}
              {!loading && page?.rows.length === 0 && (
                <tr>
                  <td
                    colSpan={columns.length + 1}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    {t('staff.empty')}
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
                    <td className="px-3">{t(`shell.user.roles.${row.role}`)}</td>
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
                            variant="ghost"
                            size="icon-sm"
                            className="coarse:min-h-touch coarse:min-w-touch"
                            aria-label={t('staff.row.menu', { name: row.name })}
                          >
                            <MoreHorizontalIcon aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => setDialog({ kind: 'form', editId: row.id })}
                          >
                            {t('staff.row.edit')}
                          </DropdownMenuItem>
                          {row.id !== me?.id && (
                            <DropdownMenuItem onSelect={() => confirm('reset', row)}>
                              {t('staff.row.resetPassword')}
                            </DropdownMenuItem>
                          )}
                          {row.status === 'invited' && mailEnabled && (
                            <DropdownMenuItem onSelect={() => void invite(row)}>
                              {t('staff.row.resendInvite')}
                            </DropdownMenuItem>
                          )}
                          {row.twoFactorEnabled && row.id !== me?.id && (
                            <DropdownMenuItem onSelect={() => confirm('twoFactor', row)}>
                              {t('staff.row.resetTwoFactor')}
                            </DropdownMenuItem>
                          )}
                          {row.id !== me?.id && (
                            <DropdownMenuItem onSelect={() => confirm('revoke', row)}>
                              {t('staff.row.revokeSessions')}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {row.status === 'disabled' ? (
                            <DropdownMenuItem onSelect={() => void enable(row)}>
                              {t('staff.row.enable')}
                            </DropdownMenuItem>
                          ) : (
                            row.id !== me?.id && (
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => confirm('disable', row)}
                              >
                                {t('staff.row.disable')}
                              </DropdownMenuItem>
                            )
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
        <StaffFormDialog
          editId={dialog.editId}
          languages={languages}
          onClose={() => setDialog(null)}
          onSaved={({ staff, created, emailChanged }) => {
            setReload((count) => count + 1);
            if (created) {
              setDialog({ kind: 'setup', setup: created, reason: 'invite', name: staff.name });
              setMessage(t('staff.messages.created'));
            } else {
              setDialog(null);
              setMessage(
                emailChanged
                  ? t(
                      mailEnabled
                        ? 'staff.messages.emailChangedInvite'
                        : 'staff.messages.emailChangedReset',
                    )
                  : t('staff.messages.saved'),
              );
            }
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
