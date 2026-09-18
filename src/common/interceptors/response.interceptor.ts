import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { ApiSuccessResponse } from '../dto/api-response.dto';

/**
 * Wraps every successful controller return value in the platform-wide
 * `{ success: true, data }` envelope. Errors are handled separately by
 * `AllExceptionsFilter` so they can produce `{ success: false, message }`
 * without this interceptor getting in the way.
 *
 * A `StreamableFile` (the bank-screenshot routes) passes through untouched:
 * it is raw bytes with its own content type, and wrapping it in JSON would
 * serialise the stream object instead of piping it.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<T> | StreamableFile
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<T> | StreamableFile> {
    return next
      .handle()
      .pipe(
        map((data) =>
          data instanceof StreamableFile ? data : { success: true, data },
        ),
      );
  }
}
