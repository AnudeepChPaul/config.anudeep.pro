/**
 * Why a write was refused, in a form the product page can show.
 *
 * `ProductWriteOperations` already computes `ValidationError[]`. The console used to render only
 * `detail` ("configuration is invalid"), so promote and save failures had no field reason.
 * Notices stay server-rendered — never free text from the URL. Messages are schema wording
 * (key + constraint), never submitted values.
 */
import type { PageNotice } from '@config/src/views/page-frame.js';

export interface FieldProblem {
  readonly key: string;
  readonly message: string;
}

export interface WriteFailure {
  readonly detail: string;
  readonly errors?: readonly FieldProblem[];
}

export interface PresentedWriteFailure {
  readonly notice: PageNotice;
  readonly byKey: Readonly<Record<string, string>>;
}

export function presentWriteFailure(failure: WriteFailure): PresentedWriteFailure {
  const errors = failure.errors ?? [];
  const byKey: Record<string, string> = {};
  for (const error of errors) {
    byKey[error.key] = byKey[error.key] ? `${byKey[error.key]}; ${error.message}` : error.message;
  }
  const noticeText =
    errors.length === 0
      ? failure.detail
      : `${failure.detail}: ${errors.map((error) => error.message).join('; ')}`;
  return { notice: { tone: 'problem', text: noticeText }, byKey };
}
