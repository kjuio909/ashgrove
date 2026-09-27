import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import {
  REQUEST_SNAPSHOT_HOST,
  RequestContextRegistry,
} from './request-context.registry.js';

/**
 * Another consumer of the same request's context: it writes a value before
 * the response terminates, so post-response callbacks must observe the value
 * in the frozen snapshot.
 */
@Injectable()
export class SnapshotConsumerInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    req[REQUEST_SNAPSHOT_HOST]?.setValue('interceptor', 'saw-request');
    return next.handle().pipe(map(data => data));
  }
}
