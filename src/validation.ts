import { badUserInputError, InvalidParam } from "./errors";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mirrors CreateMessageRequest/UpdateMessageRequest's Bean Validation constraints
// (@NotBlank / @Size) from the old Java API - collects every violation instead of
// failing on the first one, matching GlobalExceptionHandler's `invalidParams` array.
export function requireNonBlank(
  value: string | undefined | null,
  field: string,
  maxLength: number,
  errors: InvalidParam[],
): string {
  if (value === undefined || value === null || value.trim().length === 0) {
    errors.push({ name: field, reason: `${field} is required and cannot be blank` });
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    errors.push({ name: field, reason: `${field} cannot exceed ${maxLength} characters` });
  }
  return trimmed;
}

export function optionalSized(
  value: string | undefined | null,
  field: string,
  maxLength: number,
  errors: InvalidParam[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    errors.push({ name: field, reason: `${field} cannot exceed ${maxLength} characters` });
  }
  return trimmed;
}

export function requireEmail(
  value: string | undefined | null,
  field: string,
  maxLength: number,
  errors: InvalidParam[],
): string {
  const trimmed = requireNonBlank(value, field, maxLength, errors);
  if (trimmed && !EMAIL_RE.test(trimmed)) {
    errors.push({ name: field, reason: `${field} must be a valid email address` });
  }
  return trimmed;
}

export function optionalEmail(
  value: string | undefined | null,
  field: string,
  maxLength: number,
  errors: InvalidParam[],
): string | undefined {
  const trimmed = optionalSized(value, field, maxLength, errors);
  if (trimmed && !EMAIL_RE.test(trimmed)) {
    errors.push({ name: field, reason: `${field} must be a valid email address` });
  }
  return trimmed;
}

export function throwIfInvalid(errors: InvalidParam[]): void {
  if (errors.length > 0) {
    throw badUserInputError(
      "The request content was invalid or failed validation constraints.",
      errors,
    );
  }
}
