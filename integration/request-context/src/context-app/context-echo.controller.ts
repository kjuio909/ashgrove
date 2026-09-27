import { Controller, Get, Query, Scope } from '@nestjs/common';
import { RequestContextConsumer } from './request-context.consumer.js';

/**
 * Request-scoped controller exercising the {@link REQUEST_CONTEXT} token via
 * a request-scoped provider (the DI counterpart of the `@RequestContext()`
 * parameter decorator).
 */
@Controller({ scope: Scope.REQUEST })
export class ContextEchoController {
  constructor(private readonly consumer: RequestContextConsumer) {}

  @Get('context-echo')
  public echo(@Query('value') value?: string) {
    if (!this.consumer.isAttached()) {
      return { attached: false as const };
    }
    if (value !== undefined) {
      this.consumer.writeEchoValue(value);
    }
    return {
      attached: true as const,
      contextId: this.consumer.getContextId(),
      frozen: this.consumer.isFrozen(),
      echoValue: this.consumer.readEchoValue(),
    };
  }
}
