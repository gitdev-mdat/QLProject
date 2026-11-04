import 'dotenv/config';
import pg from 'pg';
import { assertDatabaseEnvironment, connectionOptions, poolMax } from './environment.js';

const { Pool } = pg;
assertDatabaseEnvironment(process.env.DATABASE_URL);
export const pool = new Pool({ ...connectionOptions(process.env.DATABASE_URL!), max: poolMax(10), connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
pool.on('error', (err) => console.error('Unexpected idle database connection error:', err.message));
