import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST_CONTEXT, type RequestContextSnapshot } from '@nestjs/core';

/**
 * Request-scoped provider that receives the snapshot of the current request
 * through the {@link REQUEST_CONTEXT} token exported by
 * `RequestContextModule`. Used to prove the DI-based access path (as opposed
 * to the `@RequestContext()` parameter decorator) gives every request its
 * own instance bound to its own snapshot.
 */
@Injectable({ scope: Scope.REQUEST })
export class RequestContextConsumer {
  constructor(
    @Inject(REQUEST_CONTEXT)
    private readonly context: RequestContextSnapshot | undefined,
  ) {}

  public isAttached(): boolean {
    return this.context !== undefined;
  }

  public getContextId(): string | null {
    return this.context?.id ?? null;
  }

  public isFrozen(): boolean {
    return this.context?.isFrozen() ?? false;
  }

  public writeEchoValue(value: string): void {
    this.context?.set('echoValue', value);
  }

  public readEchoValue(): string | null {
    return this.context?.get<string>('echoValue') ?? null;
  }
}
