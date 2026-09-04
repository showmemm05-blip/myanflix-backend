import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/** Same ceiling for both fields: a Google ID token or an authorization code. */
const TOKEN_MAX_LENGTH = 4096;

export const EXACTLY_ONE_MESSAGE = 'Send exactly one of credential or code';

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * `undefined`/`null` pass (the field may be omitted); anything else must be
 * a string of 1..4096 characters. Written as one custom validator instead of
 * `@IsOptional() @IsString() …` because `@IsOptional` (like `@ValidateIf`)
 * skips EVERY validator on the property when it is absent — which would also
 * skip the exactly-one rule below.
 */
function IsOptionalTokenString(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isOptionalTokenString',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return (
            isAbsent(value) ||
            (typeof value === 'string' &&
              value.length >= 1 &&
              value.length <= TOKEN_MAX_LENGTH)
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a string of 1 to ${TOKEN_MAX_LENGTH} characters`;
        },
      },
    });
}

/** Fails when both or neither of this property and `other` are present. */
function ExactlyOneWith(other: string, options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'exactlyOneWith',
      target: target.constructor,
      propertyName,
      options,
      constraints: [other],
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const body = args.object as Record<string, unknown>;
          return isAbsent(value) !== isAbsent(body[other]);
        },
        defaultMessage() {
          return EXACTLY_ONE_MESSAGE;
        },
      },
    });
}

/**
 * Body of POST /auth/google — EXACTLY ONE of:
 *  - `credential`: the Google ID token exactly as Google Identity Services
 *    handed it to the browser (the original path, unchanged);
 *  - `code`: the one-time authorization code from the popup auth-code flow,
 *    which the backend exchanges server-side (needs GOOGLE_CLIENT_SECRET).
 * Nothing else is accepted from the client — email, name and the Google
 * account id all come from the verified token, never from the request.
 * Neither or both → 400 "Send exactly one of credential or code".
 */
export class GoogleLoginDto {
  @ExactlyOneWith('code')
  @IsOptionalTokenString()
  credential?: string;

  @IsOptionalTokenString()
  code?: string;
}
