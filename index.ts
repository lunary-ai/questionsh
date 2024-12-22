import SSH2 from "ssh2";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";

import { v4 as uuidv4 } from "uuid";
import cron from "node-cron";
import sql from;'./db.ts'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const sessions = new Map();
let sessionCounter = 0;

class ClientSession {
  buffer = "";
  lastRequest = 0;
  requestCount = 0;
  conversation = [];
  startTime = Date.now();
  model = "claude-3-sonnet-20240620";
  systemPrompt =
    "You are a helpful AI assistant accessed through SSH. Keep responses concise and use simple formatting.";
  temperature = 1.0;
  userId: string | null = null;
  email: string | null = null;
  credits = 10;

  constructor(id: string) {
    this.id = id;
  }

  async handleCommand(cmd: string, stream: any) {
    const [command, ...args] = cmd.trim().toLowerCase().split(" ");

    switch (command) {
      case "/reset":
        this.conversation = [];
        stream.write("Conversation history cleared.\r\n> ");
        return true;

      case "/history":
        if (this.conversation.length === 0) {
          stream.write("No conversation history.\r\n> ");
          return true;
        }
        stream.write("\r\nConversation History:\r\n");
        this.conversation.forEach((msg, i) => {
          const role = msg.role === "user" ? "You" : "Claude";
          stream.write(`\r\n${role}: ${msg.content}\r\n`);
        });
        stream.write("\r\n> ");
        return true;

      case "/stats":
        const runtime = Math.floor((Date.now() - this.startTime) / 1000);
        const messages = this.conversation.length;
        stream.write(`\r\nSession Statistics:\r\n`);
        stream.write(`- Runtime: ${runtime} seconds\r\n`);
        stream.write(`- Messages: ${messages}\r\n`);
        stream.write(`- Current model: ${this.model}\r\n`);
        stream.write(`- Temperature: ${this.temperature}\r\n`);
        stream.write("\r\n> ");
        return true;

      case "/clear":
        stream.write("\x1B[2J\x1B[H");
        stream.write("> ");
        return true;

      case "/model":
        const validModels = [
          "claude-3-opus-20240229",
          "claude-3-sonnet-20240229",
          "claude-3-haiku-20240307",
        ];
        if (args[0] && validModels.includes(args[0])) {
          this.model = args[0];
          stream.write(`Model switched to ${this.model}\r\n> `);
        } else {
          stream.write("Available models:\r\n");
          validModels.forEach((model) => {
            const current = model === this.model ? "(current) " : "";
            stream.write(`- ${model} ${current}\r\n`);
          });
          stream.write("\r\n> ");
        }
        return true;

      case "/system":
        if (args.length > 0) {
          this.systemPrompt = args.join(" ");
          stream.write(`System prompt updated.\r\n> `);
        } else {
          stream.write(`Current system prompt: ${this.systemPrompt}\r\n> `);
        }
        return true;

      case "/retry":
        if (this.conversation.length < 2) {
          stream.write("No previous message to retry.\r\n> ");
          return true;
        }

        // Parse temperature if provided
        if (args[0]) {
          const temp = parseFloat(args[0]);
          if (!isNaN(temp) && temp >= 0 && temp <= 2) {
            this.temperature = temp;
          }
        }

        // Remove last exchange
        this.conversation.pop(); // Remove assistant's response
        const lastUserMessage = this.conversation[this.conversation.length - 1];

        stream.write(
          `\r\nRetrying last message with temperature: ${this.temperature}\r\n\r\n`
        );

        // Reprocess the last message
        await this.streamResponse(lastUserMessage.content, stream);
        return true;

      case "/register":
        if (args.length !== 1) {
          stream.write("Usage: /register <email>\r\n> ");
          return true;
        }
        const email = args[0];
        try {
          const result = await sql`
            INSERT INTO accounts (id, email, credits)
            VALUES (${uuidv4()}, ${email}, 30)
            RETURNING id
          `;
          this.userId = result[0].id;
          this.email = email;
          this.credits = 30;
          stream.write(`Registered successfully. You have 30 credits.\r\n> `);
        } catch (error) {
          stream.write(
            `Registration failed. Email might already be in use.\r\n> `
          );
        }
        return true;

      case "/login":
        if (args.length !== 1) {
          stream.write("Usage: /login <email>\r\n> ");
          return true;
        }
        const loginEmail = args[0];
        try {
          const result = await sql`
            SELECT id, credits FROM accounts
            WHERE email = ${loginEmail}
          `;
          if (result.length === 0) {
            stream.write(`No account found with this email.\r\n> `);
          } else {
            this.userId = result[0].id;
            this.email = loginEmail;
            this.credits = result[0].credits;
            stream.write(
              `Logged in successfully. You have ${this.credits} credits.\r\n> `
            );
          }
        } catch (error) {
          stream.write(`Login failed. Please try again.\r\n> `);
        }
        return true;

      case "/help":
        stream.write("\r\nAvailable Commands:\r\n");
        stream.write("  /reset   - Clear conversation history\r\n");
        stream.write("  /history - Show conversation history\r\n");
        stream.write("  /stats   - Show session statistics\r\n");
        stream.write("  /model   - Switch between models\r\n");
        stream.write("  /system  - Set system prompt\r\n");
        stream.write("  /clear   - Clear screen\r\n");
        stream.write(
          "  /retry   - Retry last message with optional temperature:\r\n"
        );
        stream.write("             /retry 0.8\r\n");
        stream.write("  /register <email> - Register a new account\r\n");
        stream.write("  /login <email>    - Login to an existing account\r\n");
        stream.write("  /help    - Show this help message\r\n");
        stream.write("  exit     - Exit the session\r\n");
        stream.write("\r\n> ");
        return true;

      default:
        return false;
    }
  }

  async streamResponse(message: string, stream: any) {
    try {
      if (this.credits <= 0) {
        stream.write(
          "You've run out of credits. Please register or login to continue.\r\n> "
        );
        return false;
      }

      this.credits--;
      if (this.userId) {
        await sql`UPDATE accounts SET credits = credits - 1 WHERE id = ${this.userId}`;
      }

      this.conversation.push({
        role: "user",
        content: message,
      });

      let fullResponse = "";
      const messageStream = await anthropic.messages.stream({
        model: this.model,
        max_tokens: 1024,
        temperature: this.temperature,
        messages: this.conversation,
        system: this.systemPrompt,
      });

      for await (const chunk of messageStream) {
        if (chunk.type === "content_block_delta") {
          const text = chunk.delta.text;
          fullResponse += text;
          stream.write(text.replace(/\n/g, "\r\n"));
        }
      }

      this.conversation.push({
        role: "assistant",
        content: fullResponse,
      });

      stream.write("\r\n\n> ");
      stream.write(`\r\nRemaining credits: ${this.credits}\r\n\n> `);
      return true;
    } catch (error) {
      stream.write(`\r\nError: ${(error as Error).message}\r\n\n> `);
      return false;
    }
  }

  async handleMessage(message: string, stream: any) {
    const now = Date.now();
    if (now - this.lastRequest < 3000 && this.lastRequest !== 0) {
      stream.write(
        "Please wait a few seconds before sending another message.\r\n> "
      );
      return;
    }

    if (!message.trim()) {
      stream.write("> ");
      return;
    }

    // Check if it's a command
    if (message.startsWith("/")) {
      const handled = await this.handleCommand(message, stream);
      if (handled) return;
    }

    stream.write("\r\n");

    const success = await this.streamResponse(message, stream);
    if (success) {
      this.lastRequest = now;
      this.requestCount++;
    }
  }
}

const server = new SSH2.Server(
  {
    hostKeys: [readFileSync("host.key")],
  },
  async (client) => {
    console.log("Client connected!");

    const sessionId = `session_${++sessionCounter}`;

    const handleStream = (stream) => {
      const session = new ClientSession(sessionId);
      sessions.set(sessionId, session);

      // Welcome message
      stream.write("\r\n🤖 Welcome to the Claude SSH Interface!\r\n");
      stream.write("Type your message and press Enter. Commands:\r\n");
      stream.write('  - Type "exit" to quit\r\n');
      stream.write('  - Type "/help" for available commands\r\n\n');
      stream.write("> ");

      stream.on("data", async (data) => {
        const input = data.toString();

        // Handle backspace
        if (input === "\x7f") {
          if (session.buffer.length > 0) {
            session.buffer = session.buffer.slice(0, -1);
            stream.write("\b \b");
          }
          return;
        }

        // Handle enter key
        if (input === "\r") {
          stream.write("\n");

          if (session.buffer.trim().toLowerCase() === "exit") {
            stream.write("Goodbye! 👋\r\n");
            sessions.delete(sessionId);
            stream.end();
            return;
          }

          await session.handleMessage(session.buffer, stream);
          session.buffer = "";
          return;
        }

        // Regular character input
        session.buffer += input;
        stream.write(input);
      });

      stream.on("error", (err) => {
        console.error("Stream error:", err);
        sessions.delete(sessionId);
      });

      stream.on("close", () => {
        console.log(`Session ${sessionId} closed`);
        sessions.delete(sessionId);
      });
    };

    client.on("authentication", (ctx) => ctx.accept());

    client.on("ready", () => {
      console.log(`Client authenticated! (Session: ${sessionId})`);
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept) => accept());
        session.on("shell", (accept) => handleStream(accept()));
      });
    });

    client.on("error", (err) => {
      console.error("Client error:", err);
      sessions.delete(sessionId);
    });

    client.on("close", () => {
      console.log(`Client disconnected (Session: ${sessionId})`);
      sessions.delete(sessionId);
    });
  }
);

const PORT = process.env.PORT ?? 2222;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`SSH server running on port ${PORT}`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down server...");
  server.close();
  process.exit(0);
});

// Replace the setInterval with a cron job
// This will run the resetCredits function every day at midnight
cron.schedule("0 0 * * *", async () => {
  console.log("Running daily credit reset");
  await resetCredits();
});

// Update the resetCredits function
async function resetCredits() {
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
