import {
  BadRequestException,
  type VersioningOptions,
  type VersionValue,
  VersioningType,
} from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';

describe('ExpressAdapter', () => {
  afterEach(() => vi.restoreAllMocks());
  let expressAdapter: ExpressAdapter;

  beforeEach(() => {
    expressAdapter = new ExpressAdapter();
  });

  describe('setErrorHandler', () => {
    it.each([
      { prefix: 'api', path: '/api' },
      { prefix: '/api', path: '/api' },
      { prefix: 'api/', path: '/api' },
      { prefix: '/api/', path: '/api' },
      { prefix: 'api/v1/', path: '/api/v1' },
    ])(
      'should mount the error handler at $path and the root for prefix $prefix',
      ({ prefix, path }) => {
        const expressInstance = expressAdapter.getInstance();
        const useSpy = vi.spyOn(expressInstance, 'use');
        const handler = vi.fn();

        expressAdapter.setErrorHandler(handler, prefix);

        expect(useSpy).toHaveBeenCalledTimes(2);
        expect(useSpy).toHaveBeenCalledWith(path, expect.any(Function));
        expect(useSpy).toHaveBeenCalledWith(handler);
      },
    );

    it.each([undefined, '', '/'])(
      'should mount only the root error handler for prefix %j',
      prefix => {
        const useSpy = vi.spyOn(expressAdapter.getInstance(), 'use');
        const handler = vi.fn();

        expressAdapter.setErrorHandler(handler, prefix);

        expect(useSpy).toHaveBeenCalledExactlyOnceWith(handler);
      },
    );
  });

  describe('setNotFoundHandler', () => {
    it.each([
      { prefix: 'api', path: '/api' },
      { prefix: '/api', path: '/api' },
      { prefix: 'api/', path: '/api' },
      { prefix: '/api/', path: '/api' },
      { prefix: 'api/v1/', path: '/api/v1' },
    ])(
      'should mount the not-found handler at $path for prefix $prefix',
      ({ prefix, path }) => {
        const expressInstance = expressAdapter.getInstance();
        const useSpy = vi.spyOn(expressInstance, 'use');

        expressAdapter.setNotFoundHandler(vi.fn(), prefix);

        expect(useSpy).toHaveBeenCalledExactlyOnceWith(
          path,
          expect.any(Function),
        );
      },
    );

    it.each([undefined, '', '/'])(
      'should mount only the root not-found handler for prefix %j',
      prefix => {
        const useSpy = vi.spyOn(expressAdapter.getInstance(), 'use');

        expressAdapter.setNotFoundHandler(vi.fn(), prefix);

        expect(useSpy).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
      },
    );
  });

  describe('registerParserMiddleware', () => {
    it('should register the express built-in parsers for json and urlencoded payloads', () => {
      const expressInstance = express();
      const jsonParserInstance = express.json();
      const urlencodedInstance = express.urlencoded();
      const jsonParserSpy = vi
        .spyOn(express, 'json')
        .mockReturnValue(jsonParserInstance as any);
      const urlencodedParserSpy = vi
        .spyOn(express, 'urlencoded')
        .mockReturnValue(urlencodedInstance as any);
      const useSpy = vi.spyOn(expressInstance, 'use');
      const expressAdapter = new ExpressAdapter(expressInstance);
      useSpy.mockClear();

      expressAdapter.registerParserMiddleware();

      expect(useSpy).toHaveBeenCalledTimes(2);
      expect(useSpy).toHaveBeenCalledWith(jsonParserInstance);
      expect(useSpy).toHaveBeenCalledWith(urlencodedInstance);
      expect(jsonParserSpy).toHaveBeenCalledWith({});
      expect(urlencodedParserSpy).toHaveBeenCalledWith({ extended: true });
    });

    it('should not register default parsers if custom parsers have already been registered', () => {
      const expressInstance = express();
      expressInstance.use(function jsonParser() {});
      expressInstance.use(function urlencodedParser() {});
      const useSpy = vi.spyOn(expressInstance, 'use');
      const expressAdapter = new ExpressAdapter(expressInstance);
      useSpy.mockClear();

      expressAdapter.registerParserMiddleware();

      expect(useSpy).not.toHaveBeenCalled();
    });
  });

  describe('reply', () => {
    const createResponse = () => ({
      status: vi.fn(),
      send: vi.fn(),
      json: vi.fn(),
      getHeader: vi.fn(),
      setHeader: vi.fn(),
    });

    it('should apply the given status code', () => {
      const response = createResponse();

      expressAdapter.reply(response, { message: 'Oops' }, 404);

      expect(response.status).toHaveBeenCalledWith(404);
    });

    it('should not apply any status code when it is omitted', () => {
      const response = createResponse();

      expressAdapter.reply(response, { message: 'Hello' });

      expect(response.status).not.toHaveBeenCalled();
    });

    it('should apply falsy status codes instead of dropping them', () => {
      // "0" and "NaN" are falsy, but they were still passed in. Forwarding them
      // lets express reject the value, whereas skipping the call leaves the
      // status that was set before the handler ran (200/201), so an error would
      // be sent with a successful status code.
      for (const statusCode of [0, NaN]) {
        const response = createResponse();

        expressAdapter.reply(response, { message: 'Oops' }, statusCode);

        expect(response.status).toHaveBeenCalledWith(statusCode);
      }
    });
  });

  describe('mapException', () => {
    it('should map URIError with status code to BadRequestException', () => {
      const error = new URIError();
      const result = expressAdapter.mapException(error) as BadRequestException;
      expect(result).toBeInstanceOf(BadRequestException);
    });

    it('should map SyntaxError with status code to BadRequestException', () => {
      const error = new SyntaxError();
      const result = expressAdapter.mapException(error) as BadRequestException;
      expect(result).toBeInstanceOf(BadRequestException);
    });

    it('should return error if it is not handler Error', () => {
      const error = new Error('Test error');
      const result = expressAdapter.mapException(error);
      expect(result).toBe(error);
    });
  });

  describe('applyVersionFilter', () => {
    describe('when the versioning type is CUSTOM', () => {
      const createVersioningOptions = (
        extractedVersion: string | string[],
      ): VersioningOptions => ({
        type: VersioningType.CUSTOM,
        extractor: () => extractedVersion,
      });

      const registerVersionedRoute = (
        adapter: ExpressAdapter,
        versioningOptions: VersioningOptions,
        version: VersionValue,
        handler = vi.fn(),
      ) => {
        const route = adapter.applyVersionFilter(
          handler,
          version,
          versioningOptions,
        );
        adapter.get('/test', route);
        return { route, handler };
      };

      const createRequest = (): { req: any; res: any; next: any } => ({
        req: { method: 'GET', path: '/test' },
        res: {},
        next: vi.fn(),
      });

      it('should run the handler when the extracted version matches', () => {
        const versioningOptions = createVersioningOptions('1');
        const { route, handler } = registerVersionedRoute(
          expressAdapter,
          versioningOptions,
          '1',
        );
        const { req, res, next } = createRequest();

        route(req, res, next);

        expect(handler).toHaveBeenCalledExactlyOnceWith(req, res, next);
        expect(next).not.toHaveBeenCalled();
      });

      it('should call "next" when the extracted version does not match', () => {
        const versioningOptions = createVersioningOptions('2');
        const { route, handler } = registerVersionedRoute(
          expressAdapter,
          versioningOptions,
          '1',
        );
        const { req, res, next } = createRequest();

        route(req, res, next);

        expect(handler).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledExactlyOnceWith();
      });

      it('should elect the highest registered version among the candidates, regardless of their order', () => {
        const versioningOptions = createVersioningOptions(['2', '1']);
        const { handler: handlerV2 } = registerVersionedRoute(
          expressAdapter,
          versioningOptions,
          '2',
        );
        const { route: routeV1, handler: handlerV1 } = registerVersionedRoute(
          expressAdapter,
          versioningOptions,
          '1',
        );
        const { req, res, next } = createRequest();

        // The v1 filter runs first (registration order), yet the v2 handler
        // must be elected.
        routeV1(req, res, next);

        expect(handlerV2).toHaveBeenCalledExactlyOnceWith(req, res, next);
        expect(handlerV1).not.toHaveBeenCalled();
      });

      it('should elect the highest registered version when candidates also contain unregistered versions', () => {
        const versioningOptions = createVersioningOptions(['3', '1']);
        const { route: routeV1, handler: handlerV1 } = registerVersionedRoute(
          expressAdapter,
          versioningOptions,
          '1',
        );
        registerVersionedRoute(expressAdapter, versioningOptions, '2');
        const { req, res, next } = createRequest();

        routeV1(req, res, next);

        expect(handlerV1).toHaveBeenCalledExactlyOnceWith(req, res, next);
      });

      it('should elect the handler only once when the request passes through multiple version filters', () => {
        const versioningOptions = createVersioningOptions(['1', '2']);
        const { route: routeV1, handler: handlerV1 } = registerVersionedRoute(
          expressAdapter,
          versioningOptions,
          '1',
        );
        const { route: routeV2, handler: handlerV2 } = registerVersionedRoute(
          expressAdapter,
          versioningOptions,
          '2',
        );
        const { req, res, next } = createRequest();

        routeV1(req, res, next);
        // Simulate the request falling through to the next versioned route
        // (e.g. when the elected handler calls "next").
        routeV2(req, res, next);

        expect(handlerV2).toHaveBeenCalledTimes(1);
        expect(handlerV1).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledExactlyOnceWith();
      });

      it('should elect a handler that declares multiple versions', () => {
        const versioningOptions = createVersioningOptions(['2']);
        const { route, handler } = registerVersionedRoute(
          expressAdapter,
          versioningOptions,
          ['1', '2'],
        );
        const { req, res, next } = createRequest();

        route(req, res, next);

        expect(handler).toHaveBeenCalledExactlyOnceWith(req, res, next);
      });

      it('should call "next" when the extractor returns no candidates', () => {
        const versioningOptions = createVersioningOptions([]);
        const { route, handler } = registerVersionedRoute(
          expressAdapter,
          versioningOptions,
          '1',
        );
        const { req, res, next } = createRequest();

        route(req, res, next);

        expect(handler).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledExactlyOnceWith();
      });

      it('should call the extractor only once per request', () => {
        const extractor = vi.fn().mockReturnValue(['1', '2']);
        const versioningOptions: VersioningOptions = {
          type: VersioningType.CUSTOM,
          extractor,
        };
        const { route: routeV1 } = registerVersionedRoute(
          expressAdapter,
          versioningOptions,
          '1',
        );
        const { route: routeV2 } = registerVersionedRoute(
          expressAdapter,
          versioningOptions,
          '2',
        );
        const { req, res, next } = createRequest();

        routeV1(req, res, next);
        routeV2(req, res, next);

        expect(extractor).toHaveBeenCalledTimes(1);
      });

      it('should fall back to per-handler matching for routes registered through "use"', () => {
        const versioningOptions = createVersioningOptions('2');
        const handler = vi.fn();
        const route = expressAdapter.applyVersionFilter(
          handler,
          '2',
          versioningOptions,
        );
        expressAdapter.use('/test', route as any);
        const { req, res, next } = createRequest();

        route(req, res, next);

        expect(handler).toHaveBeenCalledExactlyOnceWith(req, res, next);
      });

      it('should fall back to per-handler matching when no tracked route matches the request path', () => {
        const versioningOptions = createVersioningOptions('2');
        // A tracked route for another path
        expressAdapter.get(
          '/other',
          expressAdapter.applyVersionFilter(vi.fn(), '1', versioningOptions),
        );
        // An untracked route (registered through "use") for the request path
        const handler = vi.fn();
        const route = expressAdapter.applyVersionFilter(
          handler,
          '2',
          versioningOptions,
        );
        expressAdapter.use('/test', route as any);
        const { req, res, next } = createRequest();

        route(req, res, next);

        expect(handler).toHaveBeenCalledExactlyOnceWith(req, res, next);
      });
    });
  });
});
