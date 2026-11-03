import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

type FastUri = {
  equal(left: string, right: string): boolean;
  normalize(uri: string): string;
  resolve(baseUri: string, relativeUri: string): string;
};

type Consumer = {
  name: string;
  fastUriVersion: string;
  fastUri: FastUri;
};

const appRequire = createRequire(import.meta.url);

function loadConsumer(
  name: string,
  packagePath: string,
  resolveFastUri: (packagePath: string) => string,
): Consumer {
  const fastUriPackagePath = resolveFastUri(packagePath);
  const fastUriRequire = createRequire(fastUriPackagePath);
  const fastUriMetadata = fastUriRequire(fastUriPackagePath) as { version: string };
  const fastUriModule = fastUriRequire(fastUriRequire.resolve('.')) as FastUri;

  return {
    name,
    fastUriVersion: fastUriMetadata.version,
    fastUri: fastUriModule,
  };
}

const ajvPackagePath = appRequire.resolve('ajv/package.json');
const ajv = loadConsumer('AJV', ajvPackagePath, (packagePath) => {
  const ajvRequire = createRequire(packagePath);
  return ajvRequire.resolve('fast-uri/package.json');
});

const fastifyPackagePath = appRequire.resolve('fastify/package.json');
const fastify = loadConsumer('Fastify serializer', fastifyPackagePath, (packagePath) => {
  const fastifyRequire = createRequire(packagePath);
  const serializerPackagePath = fastifyRequire.resolve('fast-json-stringify/package.json');
  const serializerRequire = createRequire(serializerPackagePath);
  return serializerRequire.resolve('fast-uri/package.json');
});

const consumers = [ajv, fastify];

describe('transitive fast-uri consumers', () => {
  it('keeps each consumer on its compatible fast-uri major', () => {
    expect(ajv.fastUriVersion).toMatch(/^3\./);
    expect(fastify.fastUriVersion).toMatch(/^4\./);
  });

  for (const consumer of consumers) {
    describe(consumer.name, () => {
      it('does not decode or equate percent-encoded javascript/http schemes', () => {
        const encodedJavascript = '%6Aavascript:alert(1)';
        const encodedHttp = '%68%74%74%70://example.test/resource';

        expect(consumer.fastUri.normalize(encodedJavascript)).toBe(encodedJavascript);
        expect(consumer.fastUri.equal(encodedJavascript, 'javascript:alert(1)')).toBe(false);
        expect(consumer.fastUri.normalize(encodedHttp)).toBe(encodedHttp);
        expect(consumer.fastUri.equal(encodedHttp, 'http://example.test/resource')).toBe(false);
      });

      it('preserves leading dot segments in relative-reference normalization', () => {
        const baseUri = 'http://example.test/a/b';
        const relativeUri = '../c';

        expect(consumer.fastUri.normalize(relativeUri)).toBe(relativeUri);
        expect(consumer.fastUri.resolve(baseUri, relativeUri)).toBe('http://example.test/c');
        expect(consumer.fastUri.resolve(baseUri, consumer.fastUri.normalize(relativeUri))).toBe(
          'http://example.test/c',
        );
      });

      it('retains ordinary URI controls', () => {
        expect(consumer.fastUri.equal('HTTP://EXAMPLE.TEST/a', 'http://example.test/a')).toBe(true);
        expect(consumer.fastUri.normalize('http://example.test/a/../b')).toBe(
          'http://example.test/b',
        );
        expect(consumer.fastUri.equal('javascript:alert(1)', 'javascript:alert(1)')).toBe(true);
      });
    });
  }
});
