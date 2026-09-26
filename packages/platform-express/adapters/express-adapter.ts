import {
  BadRequestException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  type RequestMethod,
  StreamableFile,
  VERSION_NEUTRAL,
  type VersioningOptions,
  VersioningType,
} from '@nestjs/common';
import cors from 'cors';
import express from 'express';
import type { Server } from 'http';
import * as http from 'http';
import * as https from 'https';
import { pathToRegexp } from 'path-to-regexp';
import { Duplex, Writable } from 'stream';
import {
  NestExpressBodyParserOptionsFor,
  NestExpressBodyParserType,
} from '../interfaces/nest-express-body-parser.interface.js';
import { ServeStaticOptions } from '../interfaces/serve-static-options.interface.js';
import { getBodyParserOptions } from './utils/get-body-parser-options.util.js';
import {
  type CorsOptions,
  type CorsOptionsDelegate,
  type VersionValue,
  addLeadingSlash,
  isFunction,
  isNil,
  isObject,
  isString,
  isUndefined,
  stripEndSlash,
} from '@nestjs/common/internal';
import type { NestApplicationOptions } from '@nestjs/common';
import { AbstractHttpAdapter } from '@nestjs/core';
import {
  RouterMethodFactory,
  LegacyRouteConverter,
} from '@nestjs/core/internal';

type VersionedRoute = <
  TRequest extends Record<string, any> = any,
  TResponse = any,
>(
  req: TRequest,
  res: TResponse,
  next: () => void,
) => any;

/**
 * Marks the route handlers created by "applyVersionFilter" for the CUSTOM
 * versioning type, so they can be correlated with the routes they were
 * registered for when inspecting the Express router.
 */
const CUSTOM_VERSION_FILTER = Symbol('CUSTOM_VERSION_FILTER');

/**
 * Tracks, per request, the group of versioned route handlers (same HTTP
 * method and path) that already produced a response, so that no two handlers
 * of the same route can write to the response of a single request.
 */
const CUSTOM_VERSION_HANDLER_SELECTED = Symbol(
  'CUSTOM_VERSION_HANDLER_SELECTED',
);

/**
 * Compares two version strings segment by segment. Numeric segments are
 * compared numerically (so that "10" is higher than "2"), any other segments
 * are compared lexicographically.
 */
function compareVersionStrings(a: string, b: string): number {
  const aSegments = a.split('.');
  const bSegments = b.split('.');
  const segmentCount = Math.max(aSegments.length, bSegments.length);
  for (let i = 0; i < segmentCount; i++) {
    const aSegment = aSegments[i] ?? '0';
    const bSegment = bSegments[i] ?? '0';
    const aNumber = Number(aSegment);
    const bNumber = Number(bSegment);
    const comparison =
      !Number.isNaN(aNumber) && !Number.isNaN(bNumber)
        ? aNumber - bNumber
        : aSegment < bSegment
          ? -1
          : aSegment > bSegment
            ? 1
            : 0;
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

/**
 * @publicApi
 */
export class ExpressAdapter extends AbstractHttpAdapter<
  http.Server | https.Server
> {
  private readonly routerMethodFactory = new RouterMethodFactory();
  private readonly logger = new Logger(ExpressAdapter.name);
  private readonly openConnections = new Set<Duplex>();
  private readonly registeredPrefixes = new Set<string>();
  private isShuttingDown = false;
  private onRequestHook?: (
    req: express.Request,
    res: express.Response,
    done: () => void,
  ) => Promise<void> | void;
  private onResponseHook?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<void> | void;
  private customVersioningFilterCache?: {
    routerStackSize: number;
    versionsByFilter: WeakMap<Function, ReadonlySet<string>>;
  };

  constructor(instance?: any) {
    super(instance || express());
    this.instance!.use((req, res, next) => {
      if (this.onResponseHook) {
        res.on('finish', () => {
          void this.onResponseHook!.apply(this, [req, res]);
        });
      }

      if (this.onRequestHook) {
        void this.onRequestHook.apply(this, [req, res, next]);
      } else {
        next();
      }
    });
  }

  public setOnRequestHook(
    onRequestHook: (
      req: express.Request,
      res: express.Response,
      done: () => void,
    ) => Promise<void> | void,
  ) {
    this.onRequestHook = onRequestHook;
  }

  public setOnResponseHook(
    onResponseHook: (
      req: express.Request,
      res: express.Response,
    ) => Promise<void> | void,
  ) {
    this.onResponseHook = onResponseHook;
  }

  public reply(response: any, body: any, statusCode?: number) {
    if (!isNil(statusCode)) {
      response.status(statusCode);
    }
    if (isNil(body)) {
      return response.send();
    }
    if (body instanceof StreamableFile) {
      this.applyStreamHeaders(response, body);
      const stream = body.getStream();
      stream.once('error', err => {
        body.errorHandler(err, response);
      });
      return stream
        .pipe<Writable>(response)
        .on('error', (err: Error) => body.errorLogger(err));
    }
    const responseContentType = response.getHeader('Content-Type');
    if (
      typeof responseContentType === 'string' &&
      !responseContentType.startsWith('application/json') &&
      body?.statusCode >= HttpStatus.BAD_REQUEST
    ) {
      this.logger.warn(
        "Content-Type doesn't match Reply body, you might need a custom ExceptionFilter for non-JSON responses",
      );
      response.setHeader('Content-Type', 'application/json');
    }
    return isObject(body) ? response.json(body) : response.send(String(body));
  }

  public status(response: any, statusCode: number) {
    return response.status(statusCode);
  }

  public end(response: any, message?: string) {
    return response.end(message);
  }

  public render(response: any, view: string, options: any) {
    return response.render(view, options);
  }

  public redirect(response: any, statusCode: number, url: string) {
    return response.redirect(statusCode, url);
  }

  public setErrorHandler(handler: Function, prefix?: string) {
    const normalizedPrefix = this.normalizePrefix(prefix);
    if (normalizedPrefix) {
      const router = express.Router();
      router.use(handler as any);
      this.use(normalizedPrefix, router);
    }
    // Always mount the error handler at the root as well, so routes living
    // outside the global prefix (e.g. "setGlobalPrefix" exclusions or
    // root-mounted routes) still pass through the exception layer.
    return this.use(handler);
  }

  public setNotFoundHandler(handler: Function, prefix?: string) {
    const normalizedPrefix = this.normalizePrefix(prefix);
    if (normalizedPrefix) {
      this.registeredPrefixes.add(normalizedPrefix);
      const router = express.Router();
      router.all('*path', handler as any);
      return this.use(normalizedPrefix, router);
    }
    return this.use(
      (
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        // When multiple apps share this adapter, a non-prefixed app's 404
        // handler may be registered before a prefixed app's routes. Skip
        // requests whose path belongs to another app's prefix so they can
        // reach the correct route handlers further in the stack.
        const path = req.originalUrl.split(/[?#]/)[0];
        for (const registeredPrefix of this.registeredPrefixes) {
          // Match on full path segments only, so a prefix of "/api" does not
          // swallow unrelated paths such as "/apiary".
          if (
            path === registeredPrefix ||
            path.startsWith(`${registeredPrefix}/`)
          ) {
            return next();
          }
        }
        return (handler as any)(req, res, next);
      },
    );
  }

  public isHeadersSent(response: any): boolean {
    return response.headersSent;
  }

  public getHeader(response: any, name: string) {
    return response.get(name);
  }

  public setHeader(response: any, name: string, value: string) {
    return response.set(name, value);
  }

  public appendHeader(response: any, name: string, value: string) {
    return response.append(name, value);
  }

  public normalizePath(path: string): string {
    try {
      const convertedPath = LegacyRouteConverter.tryConvert(path);
      // Call "pathToRegexp" to trigger a TypeError if the path is invalid
      pathToRegexp(convertedPath);
      return convertedPath;
    } catch (e) {
      if (e instanceof TypeError) {
        LegacyRouteConverter.printError(path);
      }
      throw e;
    }
  }

  public listen(port: string | number, callback?: () => void): Server;
  public listen(
    port: string | number,
    hostname: string,
    callback?: () => void,
  ): Server;
  public listen(port: any, ...args: any[]): Server {
    return this.httpServer.listen(port, ...args);
  }

  public beforeClose() {
    this.isShuttingDown = true;
  }

  public close() {
    this.isShuttingDown = true;
    this.closeOpenConnections();

    if (!this.httpServer) {
      return undefined;
    }
    return new Promise(resolve => this.httpServer.close(resolve));
  }

  public set(...args: any[]) {
    return this.instance.set(...args);
  }

  public enable(...args: any[]) {
    return this.instance.enable(...args);
  }

  public disable(...args: any[]) {
    return this.instance.disable(...args);
  }

  public engine(...args: any[]) {
    return this.instance.engine(...args);
  }

  public useStaticAssets(path: string, options: ServeStaticOptions) {
    if (options && options.prefix) {
      return this.use(options.prefix, express.static(path, options));
    }
    return this.use(express.static(path, options));
  }

  public setBaseViewsDir(path: string | string[]) {
    return this.set('views', path);
  }

  public setViewEngine(engine: string) {
    return this.set('view engine', engine);
  }

  public getRequestHostname(request: any): string {
    return request.hostname;
  }

  public getRequestMethod(request: any): string {
    return request.method;
  }

  public getRequestUrl(request: any): string {
    return request.originalUrl;
  }

  public enableCors(options: CorsOptions | CorsOptionsDelegate<any>) {
    return this.use(cors(options as any));
  }

  public createMiddlewareFactory(
    requestMethod: RequestMethod,
  ): (path: string, callback: Function) => any {
    return (path: string, callback: Function) => {
      try {
        const convertedPath = LegacyRouteConverter.tryConvert(path);
        return this.routerMethodFactory
          .get(this.instance, requestMethod)
          .call(this.instance, convertedPath, callback);
      } catch (e) {
        if (e instanceof TypeError) {
          LegacyRouteConverter.printError(path);
        }
        throw e;
      }
    };
  }

  public initHttpServer(options: NestApplicationOptions) {
    const isHttpsEnabled = options && options.httpsOptions;
    if (isHttpsEnabled) {
      this.httpServer = https.createServer(
        options.httpsOptions!,
        this.getInstance(),
      );
    } else {
      this.httpServer = http.createServer(this.getInstance());
    }

    if (options?.return503OnClosing) {
      this.instance.use((req: any, res: any, next: any) => {
        if (this.isShuttingDown) {
          res.set('Connection', 'close');
          res.status(503).send('Service Unavailable');
        } else {
          next();
        }
      });
    }

    if (options?.forceCloseConnections) {
      this.trackOpenConnections();
    }
  }

  public registerParserMiddleware(prefix?: string, rawBody?: boolean) {
    const bodyParserJsonOptions = getBodyParserOptions('json', rawBody!);
    const bodyParserUrlencodedOptions = getBodyParserOptions(
      'urlencoded',
      rawBody!,
      { extended: true },
    );

    const parserMiddleware = {
      jsonParser: express.json(bodyParserJsonOptions),
      urlencodedParser: express.urlencoded(bodyParserUrlencodedOptions),
    };
    Object.keys(parserMiddleware)
      .filter(parser => !this.isMiddlewareApplied(parser))
      .forEach(parserKey => this.use(parserMiddleware[parserKey]));
  }

  public useBodyParser<ParserType extends NestExpressBodyParserType>(
    type: ParserType,
    rawBody: boolean,
    options?: NestExpressBodyParserOptionsFor<ParserType>,
  ): this {
    const parserOptions = getBodyParserOptions(type, rawBody, options);
    const parser = express[type](parserOptions);

    this.use(parser);

    return this;
  }

  public setLocal(key: string, value: any) {
    this.instance.locals[key] = value;
    return this;
  }

  public getType(): string {
    return 'express';
  }

  public isRouteOrderSensitive(): boolean {
    return true;
  }

  public applyVersionFilter(
    handler: Function,
    version: VersionValue,
    versioningOptions: VersioningOptions,
  ): VersionedRoute {
    const callNextHandler: VersionedRoute = (req, res, next) => {
      if (!next) {
        throw new InternalServerErrorException(
          'HTTP adapter does not support filtering on version',
        );
      }
      return next();
    };

    if (
      version === VERSION_NEUTRAL ||
      // URL Versioning is done via the path, so the filter continues forward
      versioningOptions.type === VersioningType.URI
    ) {
      const handlerForNoVersioning: VersionedRoute = (req, res, next) =>
        handler(req, res, next);

      return handlerForNoVersioning;
    }

    // Custom Extractor Versioning Handler
    if (versioningOptions.type === VersioningType.CUSTOM) {
      const handlerForCustomVersioning: VersionedRoute = (req, res, next) => {
        const extractedVersion = versioningOptions.extractor(req);
        const extractedVersions = Array.isArray(extractedVersion)
          ? extractedVersion
          : [extractedVersion];

        // All handlers registered for the same route (same HTTP method and
        // path, possibly across separate controllers) are evaluated as a
        // group, so that only the handler of the highest requested version is
        // executed - no matter in which order the handlers were registered or
        // the versions were supplied by the request.
        const routeVersions = this.getCustomVersioningFilterVersions().get(
          handlerForCustomVersioning,
        );
        if (routeVersions) {
          let highestMatchingVersion: string | undefined;
          for (const routeVersion of routeVersions) {
            if (
              extractedVersions.includes(routeVersion) &&
              (isUndefined(highestMatchingVersion) ||
                compareVersionStrings(routeVersion, highestMatchingVersion) > 0)
            ) {
              highestMatchingVersion = routeVersion;
            }
          }

          const handlerVersions = Array.isArray(version) ? version : [version];
          if (
            !isUndefined(highestMatchingVersion) &&
            handlerVersions.includes(highestMatchingVersion) &&
            (req as any)[CUSTOM_VERSION_HANDLER_SELECTED] !== routeVersions
          ) {
            // Ensure that only one handler of this route writes to the
            // response, even if several handlers declare the highest
            // matching version
            (req as any)[CUSTOM_VERSION_HANDLER_SELECTED] = routeVersions;
            return handler(req, res, next);
          }

          return callNextHandler(req, res, next);
        }

        // Fallback for handlers that cannot be correlated with the underlying
        // router (e.g. handlers wrapped before registration): match on the
        // version of this handler only
        if (Array.isArray(version)) {
          if (
            Array.isArray(extractedVersion) &&
            version.filter(v => extractedVersion.includes(v as string)).length
          ) {
            return handler(req, res, next);
          }

          if (
            isString(extractedVersion) &&
            version.includes(extractedVersion)
          ) {
            return handler(req, res, next);
          }
        } else if (isString(version)) {
          if (
            Array.isArray(extractedVersion) &&
            extractedVersion.includes(version)
          ) {
            return handler(req, res, next);
          }

          if (isString(extractedVersion) && version === extractedVersion) {
            return handler(req, res, next);
          }
        }

        return callNextHandler(req, res, next);
      };

      // Tag the filter so it can be correlated with the route it is
      // registered for when inspecting the Express router
      (handlerForCustomVersioning as any)[CUSTOM_VERSION_FILTER] = version;

      return handlerForCustomVersioning;
    }

    // Media Type (Accept Header) Versioning Handler
    if (versioningOptions.type === VersioningType.MEDIA_TYPE) {
      const handlerForMediaTypeVersioning: VersionedRoute = (
        req,
        res,
        next,
      ) => {
        const MEDIA_TYPE_HEADER = 'Accept';
        const acceptHeaderValue: string | undefined =
          req.headers?.[MEDIA_TYPE_HEADER] ||
          req.headers?.[MEDIA_TYPE_HEADER.toLowerCase()];

        const acceptHeaderVersionParameter = acceptHeaderValue
          ? acceptHeaderValue.split(';')[1]
          : undefined;

        // No version was supplied
        if (isUndefined(acceptHeaderVersionParameter)) {
          if (Array.isArray(version)) {
            if (version.includes(VERSION_NEUTRAL)) {
              return handler(req, res, next);
            }
          }
        } else {
          const headerVersion = acceptHeaderVersionParameter.split(
            versioningOptions.key,
          )[1];

          if (Array.isArray(version)) {
            if (version.includes(headerVersion)) {
              return handler(req, res, next);
            }
          } else if (isString(version)) {
            if (version === headerVersion) {
              return handler(req, res, next);
            }
          }
        }

        return callNextHandler(req, res, next);
      };

      return handlerForMediaTypeVersioning;
    }

    // Header Versioning Handler
    if (versioningOptions.type === VersioningType.HEADER) {
      const handlerForHeaderVersioning: VersionedRoute = (req, res, next) => {
        const customHeaderVersionParameter: string | undefined =
          req.headers?.[versioningOptions.header] ||
          req.headers?.[versioningOptions.header.toLowerCase()];

        // No version was supplied
        if (isUndefined(customHeaderVersionParameter)) {
          if (Array.isArray(version)) {
            if (version.includes(VERSION_NEUTRAL)) {
              return handler(req, res, next);
            }
          }
        } else {
          if (Array.isArray(version)) {
            if (version.includes(customHeaderVersionParameter)) {
              return handler(req, res, next);
            }
          } else if (isString(version)) {
            if (version === customHeaderVersionParameter) {
              return handler(req, res, next);
            }
          }
        }

        return callNextHandler(req, res, next);
      };

      return handlerForHeaderVersioning;
    }

    throw new Error('Unsupported versioning options');
  }

  public mapException(error: unknown): unknown {
    switch (true) {
      // SyntaxError is thrown by Express body-parser when given invalid JSON (#422, #430)
      // URIError is thrown by Express when given a path parameter with an invalid percentage
      // encoding, e.g. '%FF' (#8915)
      case error instanceof SyntaxError || error instanceof URIError:
        return new BadRequestException(error.message);
      default:
        return error;
    }
  }

  /**
   * Maps every custom-versioning route handler registered on the Express
   * instance to the set of versions registered for the same route (same HTTP
   * method and path), across all handlers and controllers. This allows every
   * handler to determine whether its own version is the highest one a request
   * asks for, independently of the route registration order.
   */
  private getCustomVersioningFilterVersions(): WeakMap<
    Function,
    ReadonlySet<string>
  > {
    const routerStack: any[] = this.instance?.router?.stack ?? [];
    if (
      this.customVersioningFilterCache &&
      this.customVersioningFilterCache.routerStackSize === routerStack.length
    ) {
      return this.customVersioningFilterCache.versionsByFilter;
    }

    const versionsByRoute = new Map<string, Set<string>>();
    const routeKeysByFilter = new Map<Function, string[]>();

    for (const layer of routerStack) {
      const route = layer?.route;
      if (!route) {
        continue;
      }
      const routeKeys = Object.keys(route.methods ?? {}).map(
        method => `${method} ${JSON.stringify(route.path)}`,
      );
      for (const routeLayer of route.stack ?? []) {
        const handle = routeLayer?.handle as
          (Function & { [CUSTOM_VERSION_FILTER]?: VersionValue }) | undefined;
        const version = handle?.[CUSTOM_VERSION_FILTER];
        if (!handle || isUndefined(version)) {
          continue;
        }
        const versions = (Array.isArray(version) ? version : [version]).filter(
          (v): v is string => isString(v),
        );
        routeKeysByFilter.set(handle, routeKeys);
        for (const routeKey of routeKeys) {
          let routeVersions = versionsByRoute.get(routeKey);
          if (!routeVersions) {
            routeVersions = new Set<string>();
            versionsByRoute.set(routeKey, routeVersions);
          }
          versions.forEach(v => routeVersions!.add(v));
        }
      }
    }

    const versionsByFilter = new WeakMap<Function, ReadonlySet<string>>();
    for (const [handle, routeKeys] of routeKeysByFilter) {
      if (routeKeys.length === 1) {
        // Handlers of the same route share the same set instance, so it can
        // be used to detect that one of them already produced a response
        versionsByFilter.set(handle, versionsByRoute.get(routeKeys[0])!);
        continue;
      }
      const versions = new Set<string>();
      for (const routeKey of routeKeys) {
        versionsByRoute
          .get(routeKey)
          ?.forEach(version => versions.add(version));
      }
      versionsByFilter.set(handle, versions);
    }

    this.customVersioningFilterCache = {
      routerStackSize: routerStack.length,
      versionsByFilter,
    };
    return versionsByFilter;
  }

  private normalizePrefix(prefix?: string): string {
    return stripEndSlash(addLeadingSlash(prefix));
  }

  private trackOpenConnections() {
    this.httpServer.on('connection', (socket: Duplex) => {
      this.openConnections.add(socket);

      socket.on('close', () => this.openConnections.delete(socket));
    });
  }

  private closeOpenConnections() {
    for (const socket of this.openConnections) {
      socket.destroy();
      this.openConnections.delete(socket);
    }
  }

  private isMiddlewareApplied(name: string): boolean {
    const app = this.getInstance();
    return (
      !!app.router &&
      !!app.router.stack &&
      isFunction(app.router.stack.filter) &&
      app.router.stack.some(
        (layer: any) => layer && layer.handle && layer.handle.name === name,
      )
    );
  }

  private setHeaderIfNotExists(
    response: any,
    name: string,
    value?: string | string[] | number,
  ) {
    if (value !== undefined && response.getHeader(name) === undefined) {
      const headerValue = Array.isArray(value) ? value.join(',') : value;
      response.setHeader(name, headerValue);
    }
  }

  private applyStreamHeaders(response: any, streamable: StreamableFile) {
    const headers = streamable.getHeaders();

    this.setHeaderIfNotExists(response, 'Content-Type', headers.type);
    this.setHeaderIfNotExists(
      response,
      'Content-Disposition',
      headers.disposition,
    );
    this.setHeaderIfNotExists(response, 'Content-Length', headers.length);
  }
}
