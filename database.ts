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

export async function resetCredits() {
  try {
    await sql`
      UPDATE accounts SET credits = 30 WHERE credits < 30;
      UPDATE accounts SET credits = 10 WHERE credits < 10 AND email IS NULL;
    `;
    console.log("Credits reset completed");
  } catch (error) {
    console.error("Error resetting credits:", error);
  }
}

export { sql };
