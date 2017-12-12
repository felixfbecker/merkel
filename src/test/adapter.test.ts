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
            assert.throws(() => {
                createAdapterFromUrl('');
            }, InvalidConnectionError);
        });
        it('should throw for unsupported db dialects', async () => {
            assert.throws(() => {
                createAdapterFromUrl('mysql://user@localhost/test');
            }, UnsupportedDialectError);
        });
    });
});
