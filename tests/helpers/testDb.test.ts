import { describe, test, expect } from 'vitest';
import { assertTestDatabase } from './testDb.js';

const url = (db: string) => `postgres://api_writer:dev@localhost:5432/${db}`;

describe('the tests only run in a *_test database', () => {
  test('a test database is accepted, writer and reader', () => {
    expect(() => assertTestDatabase({ PG_WRITER_URL: url('fitanalytica_test'), PG_READER_URL: url('fitanalytica_test') })).not.toThrow();
  });
  test('the development database, the one with the real imported users, is refused, and the message says how to make the right one', () => {
    expect(() => assertTestDatabase({ PG_WRITER_URL: url('fitanalytica_dev'), PG_READER_URL: url('fitanalytica_dev') })).toThrow(/fitanalytica_dev.*must be named \*_test/s);
    expect(() => assertTestDatabase({ PG_WRITER_URL: url('fitanalytica_dev') })).toThrow(/reset\.sh/);
  });
  test('either url alone pointing at the wrong database is enough to refuse', () => {
    expect(() => assertTestDatabase({ PG_WRITER_URL: url('fitanalytica_test'), PG_READER_URL: url('fitanalytica_dev') })).toThrow(/PG_READER_URL/);
    expect(() => assertTestDatabase({ PG_WRITER_URL: url('fitanalytica_dev'), PG_READER_URL: url('fitanalytica_test') })).toThrow(/PG_WRITER_URL/);
  });
  test('names that merely contain or resemble "test" are not enough', () => {
    for (const db of ['test', 'testing', 'fitanalytica_testing', 'fitanalytica_test_old', 'fitanalytica']) {
      expect(() => assertTestDatabase({ PG_WRITER_URL: url(db) }), db).toThrow(/must be named/);
    }
  });
  test('a missing url is refused and says to use .env.test', () => {
    expect(() => assertTestDatabase({ PG_WRITER_URL: undefined })).toThrow(/\.env\.test/);
    expect(() => assertTestDatabase({ PG_WRITER_URL: '' })).toThrow(/\.env\.test/);
  });
});
