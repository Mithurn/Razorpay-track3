import pg from "pg";

export type Db = pg.Pool;

// BIGINT arrives as a string by default; every bigint column here is paise and fits in a Number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}
