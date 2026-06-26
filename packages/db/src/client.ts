import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL 未设置");

export const sql = postgres(url);
export const db = drizzle(sql, { schema });
export type DB = typeof db;
