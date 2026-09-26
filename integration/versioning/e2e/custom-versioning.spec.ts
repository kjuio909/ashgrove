import {
  Controller,
  Get,
  INestApplication,
  Module,
  Version,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Request } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

describe('Custom Versioning', () => {
  const extractor = (request: Request): string | string[] => {
    const versions = request
      .header('Accept')
      ?.split(',')
      .map(header => header.match(/v(\d+\.?\d*)\+json$/))
      .filter(match => match && match.length)
      .map(matchArray => matchArray![1])
      .sort()
      .reverse();

    return versions!;
  };
  let app: INestApplication;

  // ======================================================================== //
  describe('without global default version', () => {
    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleRef.createNestApplication();
      app.enableVersioning({
        type: VersioningType.CUSTOM,
        extractor,
      });
      await app.init();
    });

    describe('GET /', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Hello World V1!');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Hello World V2!');
      });

      it('V2, if two versions are requested, select the highest version', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept: 'application/foo.v1+json, application/foo.v2+json',
          })
          .expect(200)
          .expect('Hello World V2!');
      });

      it('V2, if a non-existent version is requested, select the highest supported version', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept:
              'application/foo.v1+json, application/foo.v2+json, application/foo.v3+json',
          })
          .expect(200)
          .expect('Hello World V2!');
      });

      it('V3', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept: 'application/foo.v3+json',
          })
          .expect(404);
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept: 'application/json',
          })
          .expect(404);
      });

      it('No Header', () => {
        return request(app.getHttpServer()).get('/').expect(404);
      });
    });

    describe('GET /:param', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/param/hello')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Parameter V1!');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/param/hello')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Parameter V2!');
      });

      it('V2, if two versions are requested, select the highest version', () => {
        return request(app.getHttpServer())
          .get('/param/hello')
          .set({
            Accept: 'application/foo.v1+json, application/foo.v2+json',
          })
          .expect(200)
          .expect('Parameter V2!');
      });

      it('V3', () => {
        return request(app.getHttpServer())
          .get('/param/hello')
          .set({
            Accept: 'application/foo.v3+json',
          })
          .expect(404);
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/param/hello')
          .set({
            Accept: '',
          })
          .expect(404);
      });

      it('No Header', () => {
        return request(app.getHttpServer()).get('/').expect(404);
      });
    });

    describe('GET /multiple', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/multiple')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Multiple Versions 1 or 2');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/multiple')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Multiple Versions 1 or 2');
      });

      it('V2, if an unsupported version is specified, select the lower supported version', () => {
        return request(app.getHttpServer())
          .get('/multiple')
          .set({
            Accept: 'application/foo.v2+json, application/foo.v3+json',
          })
          .expect(200)
          .expect('Multiple Versions 1 or 2');
      });

      it('V3', () => {
        return request(app.getHttpServer())
          .get('/multiple')
          .set({
            Accept: 'application/foo.v3+json',
          })
          .expect(404);
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/multiple')
          .set({
            Accept: 'application/json',
          })
          .expect(404);
      });

      it('No Header', () => {
        return request(app.getHttpServer()).get('/multiple').expect(404);
      });
    });

    describe('GET /neutral', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/neutral')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Neutral');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/neutral')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Neutral');
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/neutral')
          .set({
            Accept: 'application/json',
          })
          .expect(200)
          .expect('Neutral');
      });

      it('No Header', () => {
        return request(app.getHttpServer())
          .get('/neutral')
          .expect(200)
          .expect('Neutral');
      });
    });

    describe('GET /override', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/override')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Override Version 1');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/override')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Override Version 2');
      });

      it('V2, if two versions are requested, select the highest version', () => {
        return request(app.getHttpServer())
          .get('/override')
          .set({
            Accept: 'application/foo.v1+json, application/foo.v2+json',
          })
          .expect(200)
          .expect('Override Version 2');
      });

      it('V3', () => {
        return request(app.getHttpServer())
          .get('/override')
          .set({
            Accept: 'application/foo.v3+json',
          })
          .expect(404);
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/override')
          .set({
            Accept: 'application/json',
          })
          .expect(404);
      });

      it('No Header', () => {
        return request(app.getHttpServer()).get('/override').expect(404);
      });
    });

    describe('GET /override-partial', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/override-partial')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Override Partial Version 1');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/override-partial')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Override Partial Version 2');
      });

      it('V3', () => {
        return request(app.getHttpServer())
          .get('/override-partial')
          .set({
            Accept: 'application/foo.v3+json',
          })
          .expect(404);
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/override-partial')
          .set({
            Accept: 'application/json',
          })
          .expect(404);
      });

      it('No Header', () => {
        return request(app.getHttpServer())
          .get('/override-partial')
          .expect(404);
      });
    });

    describe('GET /foo/bar', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/foo/bar')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Hello FooBar!');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/foo/bar')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Hello FooBar!');
      });

      it('V3', () => {
        return request(app.getHttpServer())
          .get('/foo/bar')
          .set({
            Accept: 'application/foo.v3+json',
          })
          .expect(200)
          .expect('Hello FooBar!');
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/foo/bar')
          .set({
            Accept: 'application/json',
          })
          .expect(200)
          .expect('Hello FooBar!');
      });

      it('No Header', () => {
        return request(app.getHttpServer())
          .get('/foo/bar')
          .expect(200)
          .expect('Hello FooBar!');
      });
    });

    afterAll(async () => {
      await app.close();
    });
  });

  // ======================================================================== //
  describe('with the global default version: "1"', () => {
    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleRef.createNestApplication();
      app.enableVersioning({
        type: VersioningType.CUSTOM,
        extractor,
        defaultVersion: '1',
      });
      await app.init();
    });

    describe('GET /', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Hello World V1!');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Hello World V2!');
      });

      it('V3', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept: 'application/foo.v3+json',
          })
          .expect(404);
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept: 'application/json',
          })
          .expect(404);
      });

      it('No Header', () => {
        return request(app.getHttpServer()).get('/').expect(404);
      });
    });

    describe('GET /:param', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/param/hello')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Parameter V1!');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/param/hello')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Parameter V2!');
      });

      it('V3', () => {
        return request(app.getHttpServer())
          .get('/param/hello')
          .set({
            Accept: 'application/foo.v3+json',
          })
          .expect(404);
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/param/hello')
          .set({
            Accept: '',
          })
          .expect(404);
      });

      it('No Header', () => {
        return request(app.getHttpServer()).get('/').expect(404);
      });
    });

    describe('GET /multiple', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/multiple')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Multiple Versions 1 or 2');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/multiple')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Multiple Versions 1 or 2');
      });

      it('V3', () => {
        return request(app.getHttpServer())
          .get('/multiple')
          .set({
            Accept: 'application/foo.v3+json',
          })
          .expect(404);
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/multiple')
          .set({
            Accept: 'application/json',
          })
          .expect(404);
      });

      it('No Header', () => {
        return request(app.getHttpServer()).get('/multiple').expect(404);
      });
    });

    describe('GET /neutral', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/neutral')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Neutral');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/neutral')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Neutral');
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/neutral')
          .set({
            Accept: 'application/json',
          })
          .expect(200)
          .expect('Neutral');
      });

      it('No Header', () => {
        return request(app.getHttpServer())
          .get('/neutral')
          .expect(200)
          .expect('Neutral');
      });
    });

    describe('GET /override', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/override')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Override Version 1');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/override')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Override Version 2');
      });

      it('V3', () => {
        return request(app.getHttpServer())
          .get('/override')
          .set({
            Accept: 'application/foo.v3+json',
          })
          .expect(404);
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/override')
          .set({
            Accept: 'application/json',
          })
          .expect(404);
      });

      it('No Header', () => {
        return request(app.getHttpServer()).get('/override').expect(404);
      });
    });

    describe('GET /override-partial', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/override-partial')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Override Partial Version 1');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/override-partial')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(200)
          .expect('Override Partial Version 2');
      });

      it('V3', () => {
        return request(app.getHttpServer())
          .get('/override-partial')
          .set({
            Accept: 'application/foo.v3+json',
          })
          .expect(404);
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/override-partial')
          .set({
            Accept: 'application/json',
          })
          .expect(404);
      });

      it('No Header', () => {
        return request(app.getHttpServer())
          .get('/override-partial')
          .expect(404);
      });
    });

    describe('GET /foo/bar', () => {
      it('V1', () => {
        return request(app.getHttpServer())
          .get('/foo/bar')
          .set({
            Accept: 'application/foo.v1+json',
          })
          .expect(200)
          .expect('Hello FooBar!');
      });

      it('V2', () => {
        return request(app.getHttpServer())
          .get('/foo/bar')
          .set({
            Accept: 'application/foo.v2+json',
          })
          .expect(404);
      });

      it('V3', () => {
        return request(app.getHttpServer())
          .get('/foo/bar')
          .set({
            Accept: 'application/foo.v3+json',
          })
          .expect(404);
      });

      it('No Version', () => {
        return request(app.getHttpServer())
          .get('/foo/bar')
          .set({
            Accept: 'application/json',
          })
          .expect(404);
      });

      it('No Header', () => {
        return request(app.getHttpServer()).get('/foo/bar').expect(404);
      });
    });

    afterAll(async () => {
      await app.close();
    });
  });

  // ======================================================================== //
  describe('with an extractor that preserves the request version order', () => {
    // The order of the extracted versions only reflects the order in which
    // the request supplied them - it must not affect the version selection
    const orderPreservingExtractor = (request: Request): string | string[] => {
      const versions = request
        .header('Accept')
        ?.split(',')
        .map(header => header.match(/v(\d+\.?\d*)\+json$/))
        .filter(match => match && match.length)
        .map(matchArray => matchArray![1]);

      return versions!;
    };

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleRef.createNestApplication();
      app.enableVersioning({
        type: VersioningType.CUSTOM,
        extractor: orderPreservingExtractor,
      });
      await app.init();
    });

    describe('GET /', () => {
      it('V2, if two versions are requested in ascending order', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept: 'application/foo.v1+json, application/foo.v2+json',
          })
          .expect(200)
          .expect('Hello World V2!');
      });

      it('V2, if two versions are requested in descending order', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept: 'application/foo.v2+json, application/foo.v1+json',
          })
          .expect(200)
          .expect('Hello World V2!');
      });

      it('V2, if versions are requested multiple times', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept:
              'application/foo.v2+json, application/foo.v2+json, application/foo.v1+json',
          })
          .expect(200)
          .expect('Hello World V2!');
      });

      it('V1, if a higher unsupported version is requested first', () => {
        return request(app.getHttpServer())
          .get('/')
          .set({
            Accept: 'application/foo.v3+json, application/foo.v1+json',
          })
          .expect(200)
          .expect('Hello World V1!');
      });
    });

    describe('GET /override', () => {
      it('V2, if two versions are requested in descending order', () => {
        return request(app.getHttpServer())
          .get('/override')
          .set({
            Accept: 'application/foo.v2+json, application/foo.v1+json',
          })
          .expect(200)
          .expect('Override Version 2');
      });
    });

    afterAll(async () => {
      await app.close();
    });
  });

  // ======================================================================== //
  describe('with the higher version handler registered first', () => {
    let v1Executions = 0;
    let v2Executions = 0;

    @Controller()
    class V2FirstController {
      @Version('2')
      @Get('/reversed')
      handleV2() {
        v2Executions++;
        return 'Reversed V2';
      }
    }

    @Controller()
    class V1SecondController {
      @Version('1')
      @Get('/reversed')
      handleV1() {
        v1Executions++;
        return 'Reversed V1';
      }
    }

    @Module({
      controllers: [V2FirstController, V1SecondController],
    })
    class ReversedRegistrationModule {}

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ReversedRegistrationModule],
      }).compile();

      app = moduleRef.createNestApplication();
      app.enableVersioning({
        type: VersioningType.CUSTOM,
        extractor,
      });
      await app.init();
    });

    describe('GET /reversed', () => {
      it('selects the highest version independently of the registration order', async () => {
        await request(app.getHttpServer())
          .get('/reversed')
          .set({
            Accept: 'application/foo.v1+json, application/foo.v2+json',
          })
          .expect(200)
          .expect('Reversed V2');

        // Only the selected handler may run - exactly once
        expect(v1Executions).toBe(0);
        expect(v2Executions).toBe(1);
      });

      it('keeps selecting the same handler for repeated requests', async () => {
        await request(app.getHttpServer())
          .get('/reversed')
          .set({
            Accept: 'application/foo.v1+json, application/foo.v2+json',
          })
          .expect(200)
          .expect('Reversed V2');

        expect(v1Executions).toBe(0);
        expect(v2Executions).toBe(2);
      });
    });

    afterAll(async () => {
      await app.close();
    });
  });
});
