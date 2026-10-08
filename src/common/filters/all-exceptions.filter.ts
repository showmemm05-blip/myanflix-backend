import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ApiErrorResponse } from '../dto/api-response.dto';
import { CodedHttpException } from '../errors/coded-http.exception';

function extractMessage(exceptionResponse: unknown, fallback: string): string {
  if (typeof exceptionResponse === 'string') return exceptionResponse;

  if (exceptionResponse && typeof exceptionResponse === 'object') {
    const message = (exceptionResponse as { message?: string | string[] })
      .message;
    if (Array.isArray(message)) return message.join(', ');
    if (typeof message === 'string') return message;
  }

  return fallback;
}

/**
 * An error raised by Express's own body parsing (body-parser / raw-body): a
 * plain Error carrying a 4xx `statusCode` and one of the `type` tags below.
 * It never extends HttpException, so without this it would be answered 500
 * with its stack logged. The one that matters for M-18 is 413
 * "request entity too large", the parser refusing a body over the route's
 * limit (config/body-limits.ts).
 *
 * Malformed JSON never gets this far: body-parser throws a SyntaxError for
 * it, and Nest's own error layer (RoutesResolver.mapExternalException) turns
 * any SyntaxError into BadRequestException(parser message) BEFORE this filter
 * runs — so malformed JSON is, and was before M-18, a 400 with the parser's
 * wording. 'entity.parse.failed' stays in the list only so a parse error
 * that is not a SyntaxError (none exists in body-parser 2.3) would get the
 * same 400 instead of a 500.
 *
 * Only these known tags qualify. Any other error that merely carries a 4xx
 * `statusCode` — a future dependency, say — stays a bare, logged 500, so
 * its raw message is never echoed to a client unseen.
 */
interface ClientHttpError extends Error {
  statusCode: number;
  type: string;
}

/** body-parser's and raw-body's error `type` values, verbatim from their source. */
export const BODY_PARSER_ERROR_TYPES: ReadonlySet<string> = new Set([
  'charset.unsupported',
  'encoding.unsupported',
  'entity.parse.failed',
  'entity.too.large',
  'entity.verify.failed',
  'parameters.too.many',
  'querystring.parse.rangeError',
  'request.aborted',
  'request.size.invalid',
  'stream.encoding.set',
  'stream.not.readable',
]);

function asClientHttpError(exception: unknown): ClientHttpError | null {
  if (!(exception instanceof Error)) return null;
  const { statusCode, type } = exception as Partial<ClientHttpError>;
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode > 499)
    return null;
  if (typeof type !== 'string' || !BODY_PARSER_ERROR_TYPES.has(type))
    return null;
  return exception as ClientHttpError;
}

/**
 * The message for a parser error a client caused: a fixed one for 413 (the
 * parser's own says "request entity too large" plus the limit, which nobody
 * needs), the parser's own short wording for the rest — the same wording
 * Nest's mapping already gives malformed JSON.
 */
function clientHttpErrorMessage(error: ClientHttpError): string {
  return error.statusCode === 413 ? 'Request body too large' : error.message;
}

/**
 * Normalizes every thrown error (validation failures, NestJS HttpExceptions,
 * Express body-parser errors and unexpected runtime errors alike) into the
 * platform-wide `{ success: false, message }` envelope. A CodedHttpException also carries
 * its stable `code` and its extra fields (`{ success: false, message, code,
 * ...extra }`), so a client can branch on the code instead of the wording.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const isHttpException = exception instanceof HttpException;
    const clientError = isHttpException ? null : asClientHttpError(exception);
    const status = isHttpException
      ? exception.getStatus()
      : (clientError?.statusCode ?? HttpStatus.INTERNAL_SERVER_ERROR);
    const message = isHttpException
      ? extractMessage(exception.getResponse(), exception.message)
      : clientError
        ? clientHttpErrorMessage(clientError)
        : 'Internal server error';

    if (!isHttpException && !clientError) {
      this.logger.error(
        exception instanceof Error ? exception.stack : exception,
      );
    }

    const body: ApiErrorResponse =
      exception instanceof CodedHttpException
        ? { ...exception.extra, success: false, message, code: exception.code }
        : { success: false, message };
    response.status(status).json(body);
  }
}
