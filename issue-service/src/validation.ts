import { badUserInputError, InvalidParam } from "./errors";

// Collects every violation instead of failing on the first one, so callers can
// throw a single BAD_USER_INPUT error with the full set of invalidParams.
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

export function throwIfInvalid(errors: InvalidParam[]): void {
  if (errors.length > 0) {
    throw badUserInputError(
      "The request content was invalid or failed validation constraints.",
      errors,
    );
  }
}
