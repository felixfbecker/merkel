import {createAdapterFromUrl, InvalidConnectionError, UnsupportedDialectError} from '../adapter';
import * as assert from 'assert';
import {PostgresAdapter} from '../adapters/postgres';

describe('Adapter', () => {
    describe('createAdapterFromUrl', () => {
        it('should return a postgres adapter for a postgres url', async () => {
            const adapter = createAdapterFromUrl('postgres://postgres@localhost/db');
            assert(adapter instanceof PostgresAdapter, 'adapter is no postgres adapter');
        });
        it('should throw for invalid connection urls', async () => {
            try {
                createAdapterFromUrl('');
                throw new assert.AssertionError({
                    message: 'it did not throw for an invalid connection url'
                });
            } catch (err) {
                if (!(err instanceof InvalidConnectionError)) {
                    throw err;
                }
            }
        });
        it('should throw for unsupported db dialects', async () => {
            try {
                createAdapterFromUrl('mysql://user@localhost/test');
                throw new assert.AssertionError({
                    message: 'it did not throw for an unsupported db dialect'
                });
            } catch (err) {
                if (!(err instanceof UnsupportedDialectError)) {
                    throw err;
                }
            }
        });
    });
});
