import postgres from "postgres";
import { DatabaseMessage } from "./types";

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

export async function getRecentMessages(
  roomId: string,
  limit: number = 20
): Promise<DatabaseMessage[]> {
  try {
    const messages = await sql<DatabaseMessage[]>`
      SELECT m.content, m.created_at, m.is_system_message, a.username
      FROM messages m
      LEFT JOIN accounts a ON m.user_id = a.id
      WHERE m.room_id = ${roomId}
      ORDER BY m.created_at DESC
      LIMIT ${limit}
    `;
    return messages.reverse();
  } catch (error) {
    console.error(`Failed to get recent messages: ${error.message}`);
    return [];
  }
}

export { sql };
