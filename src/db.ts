
import {parse} from 'url';
import {PostgresAdapter} from './adapters/postgres';

export function getAdapterFromUrl(url: string) {
    const dialect = parse(url).protocol;
    switch (dialect) {
        case 'postgres': return new PostgresAdapter(url, require(process.cwd() + '/node_modules/pg'));
        default: throw new Error('Unssuported dialect ' + dialect);
    }
}
