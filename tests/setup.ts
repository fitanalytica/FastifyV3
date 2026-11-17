import { assertTestDatabase } from './helpers/testDb.js';

// Runs before every test file.
assertTestDatabase({ PG_WRITER_URL: process.env.PG_WRITER_URL, PG_READER_URL: process.env.PG_READER_URL });
