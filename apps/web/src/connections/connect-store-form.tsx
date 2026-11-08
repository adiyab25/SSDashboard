'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ConnectShopifyBody, type AppOwner } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { Label } from '@ssdashboard/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@ssdashboard/ui/components/radio-group';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, LoaderCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { connectionKeys, connectShopify } from './connections-api';

/** The failing codes of AC-1 the list can show after a connect, explained under the form. */
const CHECK_REASONS = [
  'APP_NOT_INSTALLED',
  'APP_ORGANIZATION_MISMATCH',
  'CREDENTIALS_REJECTED',
  'SCOPES_MISSING',
  'PROTECTED_DATA_MISSING',
  'CURRENCY_MISMATCH',
  'PUBLIC_URL_NOT_HTTPS',
] as const;

/** The app owners, in the order the form offers them. */
const OWNERS: readonly { value: AppOwner; labelKey: 'appOwnerOrganization' | 'appOwnerPerson' }[] =
  [
    { value: 'organization', labelKey: 'appOwnerOrganization' },
    { value: 'person', labelKey: 'appOwnerPerson' },
  ];

/** A message the api edge answered that belongs to one field. */
const FIELD_CODES = {
  SHOP_ALREADY_CONNECTED: 'shopDomain',
  INVALID_SHOP_DOMAIN: 'shopDomain',
  STORE_CODE_TAKEN: 'storeCode',
} as const;

/** The api error codes the form words itself; any other answer reads as the generic one. */
const FORM_CODES = ['INVALID_BODY', 'FORBIDDEN'] as const;

/**
 * The Shopify connect form (spec 0015, AC-1, AC-2, Q-13.8): label, store code, shop domain, client
 * id, client secret, and who owns the app, validated with the contract's own schema and sent as
 * exactly that body. The owner types the secret on the call with the onboarding person: it is a
 * password input with autocomplete off, it is cleared as soon as the form is sent (whatever the
 * answer), and it is never put in client state, a query cache, a toast, or a log. On success it
 * goes to the list, where health reads Connecting until the check job ends.
 */
export function ConnectStoreForm() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<ConnectShopifyBody>({
    resolver: zodResolver(ConnectShopifyBody),
    // Not onTouched: a blur would add an error line and move Connect between press and release,
    // so the click was lost. Errors show on submit, then update as the person types.
    mode: 'onSubmit',
    reValidateMode: 'onChange',
    defaultValues: {
      label: '',
      storeCode: '',
      shopDomain: '',
      clientId: '',
      clientSecret: '',
      appOwner: 'organization',
    },
  });
  const { errors } = form.formState;

  const submit = form.handleSubmit(async (body) => {
    setPending(true);
    setFormError(null);
    // Gone from the form before the answer: a failed connect makes the owner type it again.
    form.setValue('clientSecret', '', { shouldValidate: false, shouldDirty: false });
    try {
      await connectShopify(body);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'generic';
      if (code in FIELD_CODES) {
        const field = FIELD_CODES[code as keyof typeof FIELD_CODES];
        form.setError(field, { message: code }, { shouldFocus: true });
      } else {
        setFormError((FORM_CODES as readonly string[]).includes(code) ? code : 'generic');
      }
      setPending(false);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
    toast.success(t('connections.form.success', { label: body.label }));
    router.push('/connections');
  });

  /** The words under a field: the contract's refusal, or the api's code. */
  const fieldText = (
    field: 'label' | 'storeCode' | 'shopDomain' | 'clientId' | 'clientSecret',
    message: string | undefined,
  ) => {
    if (message === 'SHOP_ALREADY_CONNECTED' || message === 'INVALID_SHOP_DOMAIN') {
      return t(`connections.form.errors.${message}`);
    }
    if (message === 'STORE_CODE_TAKEN') return t('connections.form.errors.STORE_CODE_TAKEN');
    const own = {
      label: 'labelRequired',
      storeCode: 'storeCodeInvalid',
      shopDomain: 'shopDomainInvalid',
      clientId: 'clientIdRequired',
      clientSecret: 'clientSecretRequired',
    } as const;
    return t(`connections.form.errors.${own[field]}`);
  };

  return (
    <div className="flex min-w-0 max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Button asChild variant="ghost" size="sm" className="self-start">
          <Link href="/connections">
            <ArrowLeftIcon aria-hidden data-icon="inline-start" className="rtl:rotate-180" />
            {t('connections.form.back')}
          </Link>
        </Button>
        <h1 className="text-xl font-semibold">{t('connections.form.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('connections.form.description')}</p>
      </div>

      {formError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {t(`connections.form.errors.${formError as 'generic'}`)}
          </AlertDescription>
        </Alert>
      )}

      <form noValidate className="grid gap-6" onSubmit={(event) => void submit(event)}>
        <FieldGroup className="gap-4">
          <Field data-invalid={!!errors.label}>
            <FieldLabel htmlFor="connection-label">
              {t('connections.form.label')}
              <span className="font-normal text-muted-foreground">
                ({t('connections.form.required')})
              </span>
            </FieldLabel>
            <Input
              id="connection-label"
              autoComplete="off"
              aria-required
              aria-invalid={!!errors.label}
              aria-describedby={errors.label ? 'connection-label-error' : 'connection-label-hint'}
              {...form.register('label')}
            />
            {errors.label ? (
              <FieldError id="connection-label-error">
                {fieldText('label', errors.label.message)}
              </FieldError>
            ) : (
              <FieldDescription id="connection-label-hint">
                {t('connections.form.labelHint')}
              </FieldDescription>
            )}
          </Field>

          <Field data-invalid={!!errors.storeCode}>
            <FieldLabel htmlFor="connection-store-code">
              {t('connections.form.storeCode')}
              <span className="font-normal text-muted-foreground">
                ({t('connections.form.required')})
              </span>
            </FieldLabel>
            <Input
              id="connection-store-code"
              dir="ltr"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="sm:max-w-64"
              aria-required
              aria-invalid={!!errors.storeCode}
              aria-describedby={
                errors.storeCode ? 'connection-store-code-error' : 'connection-store-code-hint'
              }
              {...form.register('storeCode')}
            />
            {errors.storeCode ? (
              <FieldError id="connection-store-code-error">
                {fieldText('storeCode', errors.storeCode.message)}
              </FieldError>
            ) : (
              <FieldDescription id="connection-store-code-hint">
                {t('connections.form.storeCodeHint')}
              </FieldDescription>
            )}
          </Field>

          <Field data-invalid={!!errors.shopDomain}>
            <FieldLabel htmlFor="connection-shop-domain">
              {t('connections.form.shopDomain')}
              <span className="font-normal text-muted-foreground">
                ({t('connections.form.required')})
              </span>
            </FieldLabel>
            <Input
              id="connection-shop-domain"
              dir="ltr"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-required
              aria-invalid={!!errors.shopDomain}
              aria-describedby={
                errors.shopDomain ? 'connection-shop-domain-error' : 'connection-shop-domain-hint'
              }
              {...form.register('shopDomain')}
            />
            {errors.shopDomain ? (
              <FieldError id="connection-shop-domain-error">
                {fieldText('shopDomain', errors.shopDomain.message)}
              </FieldError>
            ) : (
              <FieldDescription id="connection-shop-domain-hint">
                {t('connections.form.shopDomainHint')}
              </FieldDescription>
            )}
          </Field>

          <Field data-invalid={!!errors.clientId}>
            <FieldLabel htmlFor="connection-client-id">
              {t('connections.form.clientId')}
              <span className="font-normal text-muted-foreground">
                ({t('connections.form.required')})
              </span>
            </FieldLabel>
            <Input
              id="connection-client-id"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              aria-required
              aria-invalid={!!errors.clientId}
              aria-describedby={errors.clientId ? 'connection-client-id-error' : undefined}
              {...form.register('clientId')}
            />
            {errors.clientId && (
              <FieldError id="connection-client-id-error">
                {fieldText('clientId', errors.clientId.message)}
              </FieldError>
            )}
          </Field>

          <Field data-invalid={!!errors.clientSecret}>
            <FieldLabel htmlFor="connection-client-secret">
              {t('connections.form.clientSecret')}
              <span className="font-normal text-muted-foreground">
                ({t('connections.form.required')})
              </span>
            </FieldLabel>
            <Input
              id="connection-client-secret"
              type="password"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              aria-required
              aria-invalid={!!errors.clientSecret}
              aria-describedby={
                errors.clientSecret
                  ? 'connection-client-secret-error'
                  : 'connection-client-secret-hint'
              }
              {...form.register('clientSecret')}
            />
            {errors.clientSecret ? (
              <FieldError id="connection-client-secret-error">
                {fieldText('clientSecret', errors.clientSecret.message)}
              </FieldError>
            ) : (
              <FieldDescription id="connection-client-secret-hint">
                {t('connections.form.clientSecretHint')}
              </FieldDescription>
            )}
          </Field>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t('connections.form.appOwner')}</legend>
            <Controller
              control={form.control}
              name="appOwner"
              render={({ field }) => (
                <RadioGroup
                  value={field.value}
                  onValueChange={field.onChange}
                  className="flex flex-wrap gap-4"
                >
                  {OWNERS.map((owner) => (
                    <div key={owner.value} className="flex items-center gap-2">
                      <RadioGroupItem value={owner.value} id={`connection-owner-${owner.value}`} />
                      <Label htmlFor={`connection-owner-${owner.value}`} className="font-normal">
                        {t(`connections.form.${owner.labelKey}`)}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              )}
            />
          </fieldset>
        </FieldGroup>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending && (
              <LoaderCircleIcon
                aria-hidden
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            )}
            {t('connections.form.submit')}
          </Button>
          <Button asChild variant="outline">
            <Link href="/connections">{t('connections.form.cancel')}</Link>
          </Button>
        </div>
      </form>

      <section aria-labelledby="connection-checks-title" className="flex flex-col gap-2">
        <h2 id="connection-checks-title" className="text-base font-semibold">
          {t('connections.form.checksTitle')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('connections.form.checksDescription')}</p>
        <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">
          {CHECK_REASONS.map((reason) => (
            <li key={reason}>{t(`connections.reasons.${reason}`)}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
