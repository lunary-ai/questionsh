import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

export async function testDatabaseConnection() {
  try {
    const result = await sql`SELECT 1 as connection_test`;
    if (result[0].connection_test === 1) {
      console.log("Database connection successful");
    } else {
      throw new Error("Unexpected result from database");
    }
  } catch (error) {
    console.error("Database connection failed:", error);
    process.exit(1);
  }
}

export { sql };
