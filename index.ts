import { createServer, createHttpServer } from "./server";
import { testDatabaseConnection, resetCredits } from "./database";
import cron from "node-cron";

console.log("Initializing question.sh server...");

const sshServer = createServer();
const httpServer = createHttpServer();

await testDatabaseConnection();

cron.schedule("0 0 * * *", async () => {
  console.log("Running daily credit reset");
  await resetCredits();
});

process.on("SIGINT", () => {
  console.log("\nShutting down servers...");
  sshServer.close();
  httpServer.close();
  process.exit(0);
});
