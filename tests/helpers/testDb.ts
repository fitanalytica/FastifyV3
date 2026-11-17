/**
 * The tests write to the database and delete from it, and a test that checks a rule by breaking it (a mutation) runs the broken code for real.
 * So they only ever run in a database made for them: its name must end in `_test`. Anything else, the development database with the real
 * imported users above all, is refused before a single test starts.
 */
export function assertTestDatabase(urls: Record<string, string | undefined>): void {
  for (const [name, url] of Object.entries(urls)) {
    if (!url) {
      throw new Error(`${name} is not set: the tests need .env.test (npm test loads it)`);
    }
    const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    if (!/_test$/.test(database)) {
      throw new Error(
        `Refusing to run the tests: ${name} points at "${database}", and a test database must be named *_test (fitanalytica_test). ` +
          'The tests change and delete data. Create it with: DB=fitanalytica_test sh docs/data/dev-db/reset.sh',
      );
    }
  }
}
