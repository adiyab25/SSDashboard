import { randomUUID } from 'node:crypto';
import { createDatabase } from '@ssdashboard/db';
import { expect, test, type Page } from '@playwright/test';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { ownerDatabaseUrl } from './auth';
import { createLocation, createSku, receive, voidReceipt } from './master-data-api';

// Spec 0010 QA, real app: what the audit screen must NOT offer or show (AC-13, AC-14, spec 0008
// cost.view). Complements `audit.spec.ts`, which proves what it does show.

/** Plants one carrier entry whose diff carries cost fields; returns its record id. */
async function plantCostedEntry(): Promise<string> {
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  const recordId = randomUUID();
  try {
    await pool.query(
      `INSERT INTO audit_entries (correlation_id, actor_kind, actor_ref, action, record_type,
                                  record_id, before, after, reason)
       VALUES (gen_random_uuid(), 'carrier', 'bosta', 'stock_receipt.voided', 'stock_receipt', $1,
               '{"status":"posted","referenceValue":"111.11"}'::jsonb,
               '{"status":"voided","unitCost":"222.22"}'::jsonb, 'Costed plant')`,
      [recordId],
    );
  } finally {
    await pool.end();
  }
  return recordId;
}

async function openDetail(page: Page, recordId: string) {
  await page.goto(`/audit?recordType=stock_receipt&recordId=${recordId}`);
  await page.getByRole('button', { name: /^Details of/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Stock receipt voided' });
  await expect(dialog.getByRole('table', { name: 'Changed fields' })).toBeVisible();
  return dialog;
}

test.describe('cost fields on the audit screen', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let person: SeededAccount | undefined;
  test.afterEach(async () => {
    const seeded = person;
    person = undefined;
    await seeded?.remove();
  });

  for (const withCost of [false, true]) {
    test(`a manager ${withCost ? 'with' : 'without'} cost.view ${withCost ? 'sees' : 'never sees'} cost in the detail and the history (spec 0008)`, async ({
      page,
      context,
      baseURL,
    }) => {
      person = await seedAccount({
        hats: ['manager'],
        grants: withCost ? ['cost.view'] : [],
      });
      await signInThroughApi(context, person, baseURL ?? '');
      const recordId = await plantCostedEntry();
      const dialog = await openDetail(page, recordId);
      const diff = dialog.getByRole('table', { name: 'Changed fields' });
      await expect(diff.getByRole('row', { name: /status/ })).toBeVisible();
      await dialog.getByRole('button', { name: 'Show the history of this record' }).click();
      await expect(dialog.getByRole('table', { name: 'History of this record' })).toBeVisible();
      const expected = withCost ? 1 : 0;
      await expect(diff.getByRole('row', { name: /unitCost/ })).toHaveCount(expected);
      await expect(page.getByText('222.22')).toHaveCount(withCost ? 1 : 0);
      await expect(page.getByText('111.11')).toHaveCount(withCost ? 1 : 0);
    });
  }
});

test.describe('who may use the audit api, and the Undo control', () => {
  test('a real entry offers no Undo, since nothing is undoable yet (AC-14)', async ({
    page,
    request,
  }) => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const location = await createLocation(request, `AQ-${tag}`);
    const sku = await createSku(request, `AQS-${tag}`);
    const receipt = await receive(request, location.id, sku.id, 2);
    await voidReceipt(request, receipt.id, `No undo ${tag}`);
    await page.goto(`/audit?recordType=stock_receipt&recordId=${receipt.id}`);
    await page.getByRole('button', { name: /^Details of/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Stock receipt voided' });
    await expect(dialog.getByRole('table', { name: 'Changed fields' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Undo/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Undo/ })).toHaveCount(0);
  });

  test('exporting leaves an "Audit trail exported" entry on the screen (AC-15)', async ({
    page,
    request,
  }) => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const location = await createLocation(request, `AX-${tag}`);
    const sku = await createSku(request, `AXS-${tag}`);
    const receipt = await receive(request, location.id, sku.id, 2);
    await voidReceipt(request, receipt.id, `Export proof ${tag}`);
    const today = new Date().toISOString().slice(0, 10);
    await page.goto(
      `/audit?dayFrom=${today}&dayTo=${today}&recordType=stock_receipt&recordId=${receipt.id}`,
    );
    await expect(page.getByRole('button', { name: /^Details of/ })).toHaveCount(1);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    await download;
    await page.goto('/audit?action=audit.exported');
    await expect(
      page.getByRole('table', { name: 'Audit entries' }).getByText('Audit trail exported').first(),
    ).toBeVisible();
  });

  test.describe('a warehouse person', () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let person: SeededAccount | undefined;
    test.afterEach(async () => {
      const seeded = person;
      person = undefined;
      await seeded?.remove();
    });

    test('gets 403 FORBIDDEN from every audit route and no sidebar link (AC-13)', async ({
      page,
      context,
      baseURL,
      isMobile,
    }) => {
      person = await seedAccount({ hats: ['warehouse'] });
      await signInThroughApi(context, person, baseURL ?? '');
      const id = randomUUID();
      for (const path of [
        '/api/audit/entries',
        `/api/audit/entries/${id}`,
        `/api/audit/records/sku/${id}/entries`,
      ]) {
        const response = await page.request.get(path);
        expect(response.status(), path).toBe(403);
        expect(await response.json(), path).toMatchObject({ code: 'FORBIDDEN' });
      }
      const exported = await page.request.post(
        '/api/audit/entries/export?dayFrom=2026-01-01&dayTo=2026-01-02',
        { headers: { origin: new URL(baseURL ?? '').origin } },
      );
      expect(exported.status(), 'export').toBe(403);
      expect(await exported.json()).toMatchObject({ code: 'FORBIDDEN' });
      const undo = await page.request.post(`/api/audit/entries/${id}/undo`, {
        data: { reason: 'x' },
        headers: { origin: new URL(baseURL ?? '').origin },
      });
      expect(undo.status()).toBe(403);
      if (!isMobile) {
        await page.goto('/');
        const nav = page.getByRole('navigation', { name: 'Main' });
        await expect(nav).toBeVisible();
        await expect(nav.getByRole('link', { name: 'Audit trail' })).toHaveCount(0);
      }
    });
  });
});
