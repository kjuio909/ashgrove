import { Controller, Get, Inject, Query, Scope } from '@nestjs/common';
import { REQUEST_CONTEXT, type RequestContextSnapshot } from '@nestjs/core';

/**
 * Request-scoped controller exercising the {@link REQUEST_CONTEXT} injection
 * token (the DI counterpart of the `@RequestContext()` parameter decorator).
 */
@Controller({ scope: Scope.REQUEST })
export class ContextEchoController {
  constructor(
    @Inject(REQUEST_CONTEXT)
    private readonly context: RequestContextSnapshot | undefined,
  ) {}

  @Get('context-echo')
  public echo(@Query('value') value?: string) {
    if (!this.context) {
      return { attached: false as const };
    }
    if (value !== undefined) {
      this.context.set('echoValue', value);
    }
    return {
      attached: true as const,
      contextId: this.context.id,
      frozen: this.context.isFrozen(),
      echoValue: this.context.get<string>('echoValue') ?? null,
    };
  }
}
