import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * Application-scoped singleton used to prove that applications keep ordinary
 * singleton semantics: one instance (one stable id) for the whole lifetime of
 * an application, a fresh id for a recreated application.
 */
@Injectable()
export class SingletonProbeService {
  public readonly id = randomUUID();
}
