import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { ApiSuccessResponse } from '../dto/api-response.dto';

/**
 * Wraps every successful controller return value in the platform-wide
 * `{ success: true, data }` envelope. Errors are handled separately by
 * `AllExceptionsFilter` so they can produce `{ success: false, message }`
 * without this interceptor getting in the way.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessResponse<T>> {
    return next.handle().pipe(map((data) => ({ success: true, data })));
  }
}
