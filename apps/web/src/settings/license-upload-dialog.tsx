'use client';

import {
  LICENSE_ENVELOPE_MAX_BYTES,
  LicenseCheckOutcome,
  type LicenseCheckOutcome as Outcome,
} from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ssdashboard/ui/components/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { useReturnFocus } from '@/shared/use-return-focus';
import { licenseKeys, uploadLicense } from './license-api';
import { settingsKeys } from './settings-api';

/** The sentence of each refusal outcome a license upload can come back with. */
const REFUSAL_KEYS = {
  bad_format: 'settings.license.upload.errors.bad_format',
  bad_signature: 'settings.license.upload.errors.bad_signature',
  unknown_key: 'settings.license.upload.errors.unknown_key',
  dev_key_in_production: 'settings.license.upload.errors.dev_key_in_production',
  wrong_install: 'settings.license.upload.errors.wrong_install',
  // The outcomes of a file check on the server never refuse an upload; if one ever does, the
  // person still hears that it was refused and that nothing changed.
  valid: 'settings.license.upload.errors.refused',
  already_recorded: 'settings.license.upload.errors.refused',
  none_configured: 'settings.license.upload.errors.refused',
  file_missing: 'settings.license.upload.errors.refused',
  file_unreadable: 'settings.license.upload.errors.refused',
} as const satisfies Record<Outcome, MessageKey>;

/** The sentence for a refused upload: the outcome's own when the api named one we know. */
function refusalKey(outcome: string | undefined): MessageKey {
  const known = LicenseCheckOutcome.safeParse(outcome);
  return known.success ? REFUSAL_KEYS[known.data] : 'settings.license.upload.errors.refused';
}

/** Props of `LicenseUploadDialog`. */
interface LicenseUploadDialogProps {
  onClose: () => void;
}

/**
 * The dialog that uploads a license file (spec 0009, AC-20): a file input for the `.json` file,
 * read as text in the browser and refused above 16 KB before anything is sent, and the answer
 * in words: recorded, nothing changed (a license that adds nothing new), or the sentence of the
 * refusal outcome. It never judges a license: the api verifies it. There is no reason field, the
 * contract takes the file only.
 */
export function LicenseUploadDialog({ onClose }: LicenseUploadDialogProps) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const base = useId();
  const fileId = `${base}-file`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<MessageKey | null>(null);
  const [failure, setFailure] = useState<MessageKey | null>(null);
  // True from the click until the file is read and the request starts: a second click waits.
  const [reading, setReading] = useState(false);
  const readingNow = useRef(false);

  /** Shows a sentence on the file field and puts focus there. */
  function refuseFile(key: MessageKey) {
    setFileError(key);
    setFailure(null);
    inputRef.current?.focus();
  }

  const mutation = useMutation({
    mutationFn: (envelope: string) => uploadLicense(envelope),
    onSuccess: async (answer) => {
      queryClient.setQueryData(licenseKeys.all, answer.summary);
      // A newly licensed plan changes which settings entries are enabled.
      await queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      toast.success(
        answer.changed
          ? t('settings.license.upload.recorded')
          : t('settings.license.upload.unchanged'),
      );
      onClose();
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : 'generic';
      if (code === 'LICENSE_INVALID' && error instanceof ApiError) {
        refuseFile(refusalKey(error.body.outcome));
      } else if (code === 'LICENSE_TOO_LARGE') {
        refuseFile('settings.license.upload.errors.tooLarge');
      } else if (code === 'VALIDATION_FAILED') {
        refuseFile('settings.license.upload.errors.notLicense');
      } else {
        setFailure(
          code === 'FORBIDDEN'
            ? 'settings.license.upload.errors.FORBIDDEN'
            : 'settings.license.upload.errors.generic',
        );
      }
    },
  });

  function choose(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setFileError(null);
    setFailure(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mutation.isPending || readingNow.current) return;
    setFailure(null);
    if (file === null) return refuseFile('settings.license.upload.errors.fileRequired');
    if (file.size > LICENSE_ENVELOPE_MAX_BYTES) {
      return refuseFile('settings.license.upload.errors.tooLarge');
    }
    readingNow.current = true;
    setReading(true);
    let text: string;
    try {
      // A byte order mark is not part of the license text the api verifies.
      text = (await file.text()).replace(/^\uFEFF/, '');
    } catch {
      return refuseFile('settings.license.upload.errors.unreadable');
    } finally {
      readingNow.current = false;
      setReading(false);
    }
    if (text.trim() === '') return refuseFile('settings.license.upload.errors.notLicense');
    // The api measures bytes of the text it receives, so measure the same.
    if (new TextEncoder().encode(text).byteLength > LICENSE_ENVELOPE_MAX_BYTES) {
      return refuseFile('settings.license.upload.errors.tooLarge');
    }
    setFileError(null);
    mutation.mutate(text);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && !reading && onClose()}>
      <DialogContent
        closeLabel={t('settings.license.upload.close')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-lg"
      >
        <form noValidate className="grid gap-6" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{t('settings.license.upload.title')}</DialogTitle>
            <DialogDescription>{t('settings.license.upload.description')}</DialogDescription>
          </DialogHeader>

          {failure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t(failure)}</AlertDescription>
            </Alert>
          )}

          <Field data-invalid={fileError !== null}>
            <FieldLabel htmlFor={fileId}>{t('settings.license.upload.fileLabel')}</FieldLabel>
            <Input
              id={fileId}
              ref={inputRef}
              type="file"
              accept=".json,application/json"
              aria-invalid={fileError !== null}
              aria-describedby={fileError ? `${fileId}-error` : `${fileId}-hint`}
              onChange={choose}
            />
            {fileError ? (
              <FieldError id={`${fileId}-error`}>{t(fileError)}</FieldError>
            ) : (
              <FieldDescription id={`${fileId}-hint`}>
                {t('settings.license.upload.fileHint')}
              </FieldDescription>
            )}
            {file && (
              <p className="text-sm text-muted-foreground">
                {t('settings.license.upload.chosen')} <LtrText>{file.name}</LtrText>
              </p>
            )}
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending || reading}
              onClick={onClose}
            >
              {t('settings.license.upload.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || reading}
              aria-busy={mutation.isPending || reading}
            >
              {(mutation.isPending || reading) && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('settings.license.upload.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
