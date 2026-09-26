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
  type CustomVersioningOptions,
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

const VERSIONED_ROUTE_METADATA = Symbol('VERSIONED_ROUTE_METADATA');
const CUSTOM_VERSIONING_REQUEST_STATE = Symbol(
  'CUSTOM_VERSIONING_REQUEST_STATE',
);

/**
 * Metadata attached to routes wrapped by the custom versioning filter, so the
 * adapter can track every versioned handler it registers for a given route.
 */
interface VersionedRouteMetadata {
  version: VersionValue;
  handler: VersionedRoute;
}

/**
 * All versioned handlers registered for a single route path and HTTP method.
 */
interface CustomVersionedRoute {
  method: string;
  path: string;
  regexp: RegExp;
  handlersByVersion: Map<string, VersionedRoute>;
}

/**
 * Per-request state shared by every custom versioning filter the request
 * passes through, so the version extractor runs once and at most one handler
 * is elected per request.
 */
interface CustomVersioningRequestState {
  extractedVersion: string | Array<string>;
  elected: boolean;
}

const isNumericVersion = (version: string) =>
  version.trim() !== '' && !Number.isNaN(Number(version));

/**
 * Compares two version strings numerically when both look like plain numbers,
 * and falls back to a numeric-aware, deterministic string comparison
 * otherwise. The result must not depend on registration or candidate order.
 */
function compareVersions(a: string, b: string): number {
  if (isNumericVersion(a) && isNumericVersion(b)) {
    return Number(a) - Number(b);
  }
  return a.localeCompare(b, undefined, { numeric: true });
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
  private versioningOptions?: VersioningOptions;
  private readonly customVersionedRoutes: CustomVersionedRoute[] = [];
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

  public get(...args: any[]) {
    return this.registerRoute('get', args);
  }

  public post(...args: any[]) {
    return this.registerRoute('post', args);
  }

  public put(...args: any[]) {
    return this.registerRoute('put', args);
  }

  public delete(...args: any[]) {
    return this.registerRoute('delete', args);
  }

  public patch(...args: any[]) {
    return this.registerRoute('patch', args);
  }

  public options(...args: any[]) {
    return this.registerRoute('options', args);
  }

  public head(...args: any[]) {
    return this.registerRoute('head', args);
  }

  public all(...args: any[]) {
    return this.registerRoute('all', args);
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
      if (!this.versioningOptions) {
        this.versioningOptions = versioningOptions;
      }
      // The same handler may be bound to several paths; in that case the
      // version filter is applied only once and reused for every path.
      if ((handler as any)[VERSIONED_ROUTE_METADATA]) {
        return handler as VersionedRoute;
      }

      const handlerForCustomVersioning: VersionedRoute = (req, res, next) => {
        const trackedRoutes =
          this.versioningOptions?.type === VersioningType.CUSTOM
            ? this.getCustomVersionedRoutes(req.method)
            : undefined;

        let extractedVersion: string | Array<string>;
        if (trackedRoutes) {
          // Every versioned handler for this HTTP method is tracked, so a
          // single handler can be elected per request: the one whose
          // version is the highest version both registered for the matched
          // route and present in the extracted candidates. The order in
          // which candidates are carried by the request does not affect
          // the election, and no other versioned handler for the route
          // runs once the election happened.
          const state = this.getCustomVersioningRequestState(
            req,
            versioningOptions,
          );
          extractedVersion = state.extractedVersion;
          if (state.elected) {
            return callNextHandler(req, res, next);
          }

          const electedHandler = this.electCustomVersionedHandler(
            trackedRoutes,
            req,
            extractedVersion,
          );
          if (electedHandler) {
            state.elected = true;
            return electedHandler(req, res, next);
          }
          if (this.matchesCustomVersionedRoute(trackedRoutes, req.path)) {
            // A tracked route matches the request path, so the election is
            // authoritative: no candidate has a registered handler.
            state.elected = true;
            return callNextHandler(req, res, next);
          }
          // No tracked route matches the request path: this route was
          // registered outside of the adapter routing methods (e.g.
          // through "use"); fall back to per-handler matching below.
        } else {
          // Routes registered outside of the adapter routing methods (e.g.
          // through "use") are not tracked: plain per-handler matching.
          extractedVersion = versioningOptions.extractor(req);
        }

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

      (handlerForCustomVersioning as any)[VERSIONED_ROUTE_METADATA] = {
        version,
        handler: handler as VersionedRoute,
      } satisfies VersionedRouteMetadata;

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

  private registerRoute(method: string, args: any[]) {
    if (this.versioningOptions?.type === VersioningType.CUSTOM) {
      for (const arg of args) {
        const metadata = arg?.[VERSIONED_ROUTE_METADATA] as
          VersionedRouteMetadata | undefined;
        if (metadata) {
          this.trackCustomVersionedRoute(
            method.toUpperCase(),
            args[0],
            metadata,
          );
        }
      }
    }
    return this.instance[method](...args);
  }

  /**
   * Tracks a versioned handler so the custom versioning election can later
   * pick the highest registered version among the request candidates.
   */
  private trackCustomVersionedRoute(
    method: string,
    path: unknown,
    metadata: VersionedRouteMetadata,
  ) {
    if (!isString(path)) {
      return;
    }
    const versions = (
      Array.isArray(metadata.version) ? metadata.version : [metadata.version]
    ).filter(isString);
    if (!versions.length) {
      return;
    }
    let route = this.customVersionedRoutes.find(
      entry => entry.method === method && entry.path === path,
    );
    if (!route) {
      route = {
        method,
        path,
        regexp: this.pathToRouteRegexp(path),
        handlersByVersion: new Map(),
      };
      this.customVersionedRoutes.push(route);
    }
    for (const version of versions) {
      // Keep the first handler registered for a version, mirroring the
      // first-match-wins behavior of the underlying router.
      if (!route.handlersByVersion.has(version)) {
        route.handlersByVersion.set(version, metadata.handler);
      }
    }
  }

  /**
   * Compiles a route path to a regular expression using the same matching
   * semantics ("case sensitive routing" / "strict routing") as the underlying
   * Express application.
   */
  private pathToRouteRegexp(path: string): RegExp {
    return pathToRegexp(path, {
      sensitive: !!this.instance?.get?.('case sensitive routing'),
      trailing: !this.instance?.get?.('strict routing'),
    }).regexp;
  }

  /**
   * Returns the tracked routes the request can reach, in registration order:
   * routes for the request method interleaved with "all" routes, plus the
   * GET routes Express falls back to for HEAD requests.
   */
  private getCustomVersionedRoutes(
    method: string,
  ): CustomVersionedRoute[] | undefined {
    const routes = this.customVersionedRoutes.filter(
      route =>
        route.method === method ||
        route.method === 'ALL' ||
        (method === 'HEAD' && route.method === 'GET'),
    );
    return routes.length ? routes : undefined;
  }

  private getCustomVersioningRequestState(
    req: Record<string | symbol, any>,
    versioningOptions: CustomVersioningOptions,
  ): CustomVersioningRequestState {
    let state = req[CUSTOM_VERSIONING_REQUEST_STATE] as
      CustomVersioningRequestState | undefined;
    if (!state) {
      state = {
        extractedVersion: versioningOptions.extractor(req),
        elected: false,
      };
      req[CUSTOM_VERSIONING_REQUEST_STATE] = state;
    }
    return state;
  }

  private matchesCustomVersionedRoute(
    routes: CustomVersionedRoute[],
    path: string,
  ): boolean {
    return routes.some(route => route.regexp.test(path));
  }

  /**
   * Elects the handler whose version is the highest version both registered
   * for the matched route and present in the extracted candidates, or
   * undefined when no candidate has a registered handler.
   */
  private electCustomVersionedHandler(
    routes: CustomVersionedRoute[],
    req: Record<string, any>,
    extractedVersion: string | Array<string>,
  ): VersionedRoute | undefined {
    const candidates = (
      Array.isArray(extractedVersion) ? extractedVersion : [extractedVersion]
    ).filter(isString);
    if (!candidates.length) {
      return undefined;
    }
    const path: string = req.path;
    let electedHandler: VersionedRoute | undefined;
    let electedVersion: string | undefined;
    for (const route of routes) {
      if (!route.regexp.test(path)) {
        continue;
      }
      for (const candidate of candidates) {
        const handler = route.handlersByVersion.get(candidate);
        if (
          handler &&
          (isUndefined(electedVersion) ||
            compareVersions(candidate, electedVersion) > 0)
        ) {
          electedHandler = handler;
          electedVersion = candidate;
        }
      }
    }
    return electedHandler;
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
