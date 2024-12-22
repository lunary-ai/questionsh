import postgres from "postgres";

const sql = postgres({
  database: process.env.DATABASE_URL,
});

export default sql;
