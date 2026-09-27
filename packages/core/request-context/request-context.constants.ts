/**
 * Symbol used to attach the {@link RequestContextSnapshot} of a request to the
 * platform-specific request object. Stored as a symbol so it never collides
 * with framework or application properties and is not enumerable.
 */
export const REQUEST_CONTEXT_SNAPSHOT: unique symbol = Symbol(
  'RequestContextSnapshot',
);

/**
 * Dependency-injection token for the {@link RequestContextSnapshot} bound to
 * the currently processed request. Injecting it makes the consumer
 * request-scoped; prefer the `@RequestContext()` parameter decorator to keep
 * controllers and providers singletons.
 */
export const REQUEST_CONTEXT = 'REQUEST_CONTEXT';
