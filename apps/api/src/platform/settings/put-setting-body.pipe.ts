import { UnprocessableEntityException, type PipeTransform } from '@nestjs/common';
import { PutSettingBody } from '@ssdashboard/contracts';

/**
 * Validates the body of `PUT /api/settings/:key` with the contract schema and answers with the
 * settings codes (spec 0009, AC-3): a bad `value`, including one nested deeper than 16 levels
 * (refused before the recursive JSON check, security review S3), is 422 `SETTING_INVALID`; a
 * reason over 500 characters is 422 `REASON_TOO_LONG`; any other malformed body is 422
 * `VALIDATION_FAILED`. Every issue lists its field and message, never the value sent.
 */
export class PutSettingBodyPipe implements PipeTransform<unknown, PutSettingBody> {
  /** Returns the parsed body, or throws the 422 answer above. */
  transform(body: unknown): PutSettingBody {
    const result = PutSettingBody.safeParse(body ?? {});
    if (result.success) return result.data;
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
      field: issue.path[0],
      code: issue.code,
    }));
    const listed = (only: typeof issues) => only.map(({ path, message }) => ({ path, message }));
    const value = issues.filter((issue) => issue.field === 'value');
    if (value.length) {
      throw new UnprocessableEntityException({
        code: 'SETTING_INVALID',
        message: 'The value is not valid for this setting',
        issues: listed(value),
      });
    }
    if (issues.some((issue) => issue.field === 'reason' && issue.code === 'too_big')) {
      throw new UnprocessableEntityException({
        code: 'REASON_TOO_LONG',
        message: 'A reason can be at most 500 characters',
      });
    }
    throw new UnprocessableEntityException({
      code: 'VALIDATION_FAILED',
      message: 'Some fields are not valid',
      issues: listed(issues),
    });
  }
}
