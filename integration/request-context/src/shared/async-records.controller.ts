import { Controller, Get } from '@nestjs/common';
import { ASYNC_RECORDS_ROUTE } from './routes.js';
import { AsyncRecordsStore } from './async-records.store.js';

/**
 * Read-only readback of continuation records. Registered in both the
 * context-enabled and the module-less applications (against independent
 * store instances), so the same route can prove that an application without
 * the request-context module never produces a record.
 */
@Controller()
export class AsyncRecordsController {
  constructor(private readonly records: AsyncRecordsStore) {}

  @Get(ASYNC_RECORDS_ROUTE)
  public list() {
    return { records: this.records.getAll() };
  }
}
