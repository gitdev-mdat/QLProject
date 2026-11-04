import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000 });
pool.on('error', (err) => console.error('Unexpected idle database connection error:', err.message));
