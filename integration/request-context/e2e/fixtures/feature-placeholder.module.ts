import { Module } from '@nestjs/common';

/**
 * Unrelated feature module imported before `RequestContextModule` in the
 * registration-order fixture, proving that hook installation order relative
 * to ordinary modules does not change request-context behavior.
 */
@Module({})
export class FeaturePlaceholderModule {}
