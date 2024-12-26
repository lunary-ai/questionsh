import { createServer, createHttpServer } from "./server";
import { testDatabaseConnection } from "./database";

import OpenAI from "openai";
import { fetchAndCacheModelList } from "./clientSession";

console.log("Initializing question.sh server...");

const sshServer = createServer();
const httpServer = createHttpServer();

await testDatabaseConnection();

// Initialize OpenAI SDK with OpenRouter configuration
export const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "Question.sh", // Replace with your actual site URL
    "X-Title": "Question.sh", // Replace with your app name
  },
});

process.on("SIGINT", () => {
  console.log("\nShutting down servers...");
  sshServer.close();
  httpServer.close();
  process.exit(0);
});

fetchAndCacheModelList();
