'use client';

import { Alert, AlertDescription, AlertTitle } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { InfoIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

/**
 * Feedback: the inverted toast with Undo, the error toast on the destructive surface, and the
 * notice (muted text with an "i" icon, never cyan, spec 0025 AC-10). The toasts use the app's own
 * `Toaster`, so they are the real ones.
 */
export function FeedbackSamples() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() =>
            toast(t('design.feedback.toastText'), {
              action: { label: t('design.feedback.undo'), onClick: () => undefined },
            })
          }
        >
          {t('design.feedback.showToast')}
        </Button>
        <Button variant="outline" onClick={() => toast.error(t('design.feedback.errorToastText'))}>
          {t('design.feedback.showErrorToast')}
        </Button>
      </div>
      <Alert>
        <InfoIcon aria-hidden className="text-muted-foreground" />
        <AlertTitle>{t('design.feedback.noticeTitle')}</AlertTitle>
        <AlertDescription>{t('design.feedback.noticeBody')}</AlertDescription>
      </Alert>
    </div>
  );
}
