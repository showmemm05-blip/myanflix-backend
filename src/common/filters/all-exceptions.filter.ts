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

function extractMessage(exceptionResponse: unknown, fallback: string): string {
  if (typeof exceptionResponse === 'string') return exceptionResponse;

  if (exceptionResponse && typeof exceptionResponse === 'object') {
    const message = (exceptionResponse as { message?: string | string[] }).message;
    if (Array.isArray(message)) return message.join(', ');
    if (typeof message === 'string') return message;
  }

  return fallback;
}

/**
 * Normalizes every thrown error (validation failures, NestJS HttpExceptions,
 * and unexpected runtime errors alike) into the platform-wide
 * `{ success: false, message }` envelope.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = isHttpException
      ? extractMessage(exception.getResponse(), exception.message)
      : 'Internal server error';

    if (!isHttpException) {
      this.logger.error(exception instanceof Error ? exception.stack : exception);
    }

    const body: ApiErrorResponse = { success: false, message };
    response.status(status).json(body);
  }
}
