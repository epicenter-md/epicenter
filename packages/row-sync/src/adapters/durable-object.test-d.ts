import { createDurableObjectSqliteAdapter } from './durable-object.js';

declare const storage: DurableObjectStorage;

createDurableObjectSqliteAdapter(storage);
