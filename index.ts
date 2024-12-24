import SSH2 from "ssh2";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";

import { v4 as uuidv4 } from "uuid";
import cron from "node-cron";
import sql from "./db";
import {
  Message,
  ClientSession as IClientSession,
  Room as IRoom,
  Agent,
} from "./types";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

console.log("Initializing question.sh server...");

const sessions = new Map();
let sessionCounter = 0;

class Room implements IRoom {
  id: string;
  name: string;
  members: Set<IClientSession>;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
    this.members = new Set();
    console.log(`Room created: ${name} (${id})`);
  }

  addMember(session: IClientSession) {
    this.members.add(session);
    console.log(
      `User ${session.username || session.id} joined room ${this.name}`
    );
  }

  removeMember(session: IClientSession) {
    this.members.delete(session);
    console.log(
      `User ${session.username || session.id} left room ${this.name}`
    );
  }

  async addMessage(
    content: string,
    userId: string | null,
    isSystemMessage: boolean = false
  ) {
    try {
      await sql`
        INSERT INTO messages (id, room_id, user_id, content, is_system_message)
        VALUES (${uuidv4()}, ${
        this.id
      }, ${userId}, ${content}, ${isSystemMessage})
      `;
      console.log(
        `Message added to room ${this.name}: ${content.substring(0, 50)}${
          content.length > 50 ? "..." : ""
        }`
      );
    } catch (error) {
      console.error(`Failed to add message to room ${this.name}:`, error);
    }
  }

  async broadcast(message: string, sender: IClientSession) {
    await this.addMessage(message, sender.userId);
    this.members.forEach((member) => {
      if (member !== sender) {
        member.writeToStream(
          `\r\n[${this.name}] ${sender.username || sender.id}: ${message}\r\n> `
        );
      }
    });
  }

  async getRecentMessages(limit: number = 20) {
    try {
      const messages = await sql`
        SELECT m.content, m.created_at, m.is_system_message, a.username
        FROM messages m
        LEFT JOIN accounts a ON m.user_id = a.id
        WHERE m.room_id = ${this.id}
        ORDER BY m.created_at DESC
        LIMIT ${limit}
      `;
      return messages.reverse();
    } catch (error) {
      console.error(`Failed to get recent messages: ${error.message}`);
      return [];
    }
  }
}

const rooms = new Map<string, Room>();

interface AutoLoginInfo {
  username: string;
  userId: string;
  credits: number;
}

class ClientSession implements IClientSession {
  id: string;
  buffer = "";
  lastRequest = 0;
  requestCount = 0;
  conversation: Message[] = [];
  startTime = Date.now();
  model = "claude-3-5-sonnet-20240620";
  systemPrompt =
    "You are a helpful AI assistant accessed through SSH. Keep responses concise and use simple formatting.";
  temperature = 1.0;
  userId: string | null = null;
  username: string | null = null;
  credits = 10;
  currentRoom: Room | null = null;
  stream: any;
  currentAgent: Agent | null = null;

  constructor(
    id: string,
    stream: any,
    autoLoginInfo: AutoLoginInfo | null = null
  ) {
    this.id = id;
    this.stream = stream;
    console.log(`New client session created: ${id}`);

    if (autoLoginInfo) {
      this.username = autoLoginInfo.username;
      this.userId = autoLoginInfo.userId;
      this.credits = autoLoginInfo.credits;
      console.log(`Auto-logged in user: ${autoLoginInfo.username}`);
    }
  }

  writeToStream(message: string, addPrompt: boolean = true) {
    this.stream.write(message.replace(/\n/g, "\r\n"));
    if (addPrompt) {
      const roomName = this.currentRoom ? `${this.currentRoom.name} ` : "";
      this.stream.write(`\r\n\x1b[36m${roomName}(${this.credits})>\x1b[0m `);
    }
  }

  writeCommandOutput(message: string) {
    const trimmedMessage = message.trim().replace(/\n/g, "\r\n");
    const roomName = this.currentRoom ? `${this.currentRoom.name} ` : "";
    this.stream.write(
      "\r\n" +
        trimmedMessage +
        `\r\n\x1b[36m${roomName}(${this.credits})>\x1b[0m `
    );
  }

  async handleCommand(cmd: string) {
    const [command, ...args] = cmd.trim().toLowerCase().split(" ");
    console.log(`Command received: ${command}`);

    switch (command) {
      case "/reset":
        this.conversation = [];
        this.writeCommandOutput("Conversation history cleared.");
        return true;

      case "/history":
        if (this.conversation.length === 0) {
          this.writeCommandOutput("No conversation history.");
          return true;
        }
        this.writeCommandOutput("\r\nConversation History:\r\n");
        this.conversation.forEach((msg, i) => {
          const role = msg.role === "user" ? "You" : "Claude";
          this.writeCommandOutput(`${role}: ${msg.content}\r\n`);
        });
        return true;

      case "/stats":
        const runtime = Math.floor((Date.now() - this.startTime) / 1000);
        const messages = this.conversation.length;
        this.writeCommandOutput(`\r\nSession Statistics:\r\n`);
        this.writeCommandOutput(`- Runtime: ${runtime} seconds\r\n`);
        this.writeCommandOutput(`- Messages: ${messages}\r\n`);
        this.writeCommandOutput(`- Current model: ${this.model}\r\n`);
        this.writeCommandOutput(`- Temperature: ${this.temperature}\r\n`);
        return true;

      case "/clear":
        this.writeCommandOutput("\x1B[2J\x1B[H");
        return true;

      case "/system":
        if (args.length > 0) {
          this.systemPrompt = args.join(" ");
          this.writeCommandOutput("System prompt updated.");
        } else {
          this.writeCommandOutput(
            `Current system prompt: ${this.systemPrompt}`
          );
        }
        return true;

      case "/retry":
        if (this.conversation.length < 2) {
          this.writeCommandOutput("No previous message to retry.");
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

        this.writeCommandOutput(
          `\r\nRetrying last message with temperature: ${this.temperature}\r\n\r\n`
        );

        // Reprocess the last message
        await this.streamResponse(lastUserMessage.content);
        return true;

      case "/register":
        if (args.length !== 1) {
          this.writeCommandOutput("Usage: /register <username>");
          return true;
        }
        const username = args[0];
        try {
          const [existingUser] = await sql`
            SELECT id FROM accounts WHERE username = ${username}
          `;
          if (existingUser) {
            console.log(
              `Registration failed: Username "${username}" already exists`
            );
            this.writeCommandOutput(`Username "${username}" is already taken.`);
            return true;
          }

          const result = await sql`
            INSERT INTO accounts (id, username, credits)
            VALUES (${uuidv4()}, ${username}, 30)
            RETURNING id, credits
          `;
          this.userId = result[0].id;
          this.username = username;
          this.credits = result[0].credits;
          console.log(`User registered: ${username} (ID: ${this.userId})`);
          this.writeCommandOutput(
            `Registered successfully. Welcome, ${username}! You have ${this.credits} credits.`
          );
        } catch (error) {
          console.error("Registration error:", error);
          this.writeCommandOutput(
            `Registration failed. Error: ${(error as Error).message}`
          );
        }
        return true;

      case "/login":
        if (args.length !== 1) {
          this.writeCommandOutput("Usage: /login <username>");
          return true;
        }
        const loginUsername = args[0];
        try {
          const result = await sql`
            SELECT id, credits FROM accounts
            WHERE username = ${loginUsername}
          `;
          if (result.length === 0) {
            this.writeCommandOutput(`No account found with this username.`);
          } else {
            this.userId = result[0].id;
            this.username = loginUsername;
            this.credits = result[0].credits;
            this.writeCommandOutput(
              `Logged in successfully. Welcome back, ${loginUsername}! You have ${this.credits} credits.`
            );
          }
        } catch (error) {
          this.writeCommandOutput(`Login failed. Please try again.`);
        }
        return true;

      case "/join": {
        if (!this.userId) {
          this.writeCommandOutput(
            "You need to be logged in to join a room. Please use /register or /login first."
          );
          return true;
        }
        if (args.length < 1) {
          this.writeCommandOutput("Usage: /join <room_name>");
          return true;
        }
        const joinRoomName = args.join(" ");
        try {
          const [roomToJoin] = await sql`
            SELECT id, name FROM rooms WHERE name = ${joinRoomName}
          `;
          if (!roomToJoin) {
            this.writeCommandOutput(`Room "${joinRoomName}" not found.`);
            return true;
          }
          if (this.currentRoom) {
            await this.leaveRoom();
          }
          await sql`
            INSERT INTO room_members (room_id, user_id)
            VALUES (${roomToJoin.id}, ${this.userId})
            ON CONFLICT (room_id, user_id) DO NOTHING
          `;
          this.currentRoom =
            rooms.get(roomToJoin.id) ||
            new Room(roomToJoin.id, roomToJoin.name);
          this.currentRoom.addMember(this);
          rooms.set(roomToJoin.id, this.currentRoom);

          // Fetch recent messages
          const recentMessages = await this.currentRoom.getRecentMessages();
          if (recentMessages.length > 0) {
            this.writeCommandOutput("Recent messages:");
            recentMessages.forEach((msg) => {
              const sender = msg.is_system_message
                ? "System"
                : msg.username || "Anonymous";
              this.writeCommandOutput(
                `[${msg.created_at}] ${sender}: ${msg.content}`
              );
            });
          }

          this.writeCommandOutput(`Joined room "${roomToJoin.name}".`);
          await this.currentRoom.addMessage(
            `${this.username || this.id} has joined the room.`,
            null,
            true
          );
          this.currentRoom.broadcast(
            `${this.username || this.id} has joined the room.`,
            this
          );
        } catch (error) {
          this.writeCommandOutput(`Failed to join room. ${error.message}`);
        }
        return true;
      }

      case "/leave": {
        if (!this.userId) {
          this.writeCommandOutput(
            "You need to be logged in to leave a room. Please use /register or /login first."
          );
          return true;
        }
        if (!this.currentRoom) {
          this.writeCommandOutput("You are not in any room.");
          return true;
        }
        const leftRoomName = this.currentRoom.name;
        await this.leaveRoom();
        this.writeCommandOutput(`Left room "${leftRoomName}".`);
        return true;
      }

      case "/rooms":
        if (!this.userId) {
          this.writeCommandOutput(
            "You need to be logged in to list rooms. Please use /register or /login first."
          );
          return true;
        }
        try {
          const dbRooms = await sql`
            SELECT r.id, r.name, COUNT(rm.user_id) as member_count
            FROM rooms r
            LEFT JOIN room_members rm ON r.id = rm.room_id
            GROUP BY r.id, r.name
            ORDER BY r.name
          `;
          if (dbRooms.length === 0) {
            this.writeCommandOutput("No rooms available.");
          } else {
            let roomList = "Available rooms:\r\n";
            dbRooms.forEach((room) => {
              roomList += `- ${room.name} (${room.member_count} members)\r\n`;
            });
            this.writeCommandOutput(roomList.trim());
          }
        } catch (error) {
          this.writeCommandOutput(`Failed to list rooms. ${error.message}`);
        }
        return true;

      case "/createagent":
        if (!this.userId) {
          this.writeCommandOutput(
            "You need to be logged in to create an agent. Please use /register or /login first."
          );
          return true;
        }
        if (args.length < 2) {
          this.writeCommandOutput("Usage: /createagent <name> <system_prompt>");
          return true;
        }
        const [agentName, ...promptParts] = args;
        const systemPrompt = promptParts.join(" ");

        try {
          const result = await sql`
            INSERT INTO agents (id, owner_id, name, system_prompt)
            VALUES (${uuidv4()}, ${this.userId}, ${agentName}, ${systemPrompt})
            RETURNING id
          `;
          this.writeCommandOutput(`Agent "${agentName}" created successfully.`);
        } catch (error) {
          console.error("Failed to create agent:", error);
          this.writeCommandOutput(
            `Failed to create agent. ${(error as Error).message}`
          );
        }
        return true;

      case "/modifyagent":
        if (!this.userId) {
          this.writeCommandOutput(
            "You need to be logged in to modify an agent. Please use /register or /login first."
          );
          return true;
        }
        if (args.length < 2) {
          this.writeCommandOutput("Usage: /modifyagent <name> <system_prompt>");
          return true;
        }
        const [modifyAgentName, ...newPromptParts] = args;
        const newSystemPrompt = newPromptParts.join(" ");

        try {
          const result = await sql`
            UPDATE agents
            SET system_prompt = ${newSystemPrompt}
            WHERE owner_id = ${this.userId} AND name = ${modifyAgentName}
          `;
          if (result.count > 0) {
            this.writeCommandOutput(
              `Agent "${modifyAgentName}" updated successfully.`
            );
          } else {
            this.writeCommandOutput(`Agent "${modifyAgentName}" not found.`);
          }
        } catch (error) {
          console.error("Failed to update agent:", error);
          this.writeCommandOutput(
            `Failed to update agent. ${(error as Error).message}`
          );
        }
        return true;

      case "/listagents":
        if (!this.userId) {
          this.writeCommandOutput(
            "You need to be logged in to list agents. Please use /register or /login first."
          );
          return true;
        }
        try {
          const agents = await sql`
            SELECT name, system_prompt
            FROM agents
            WHERE owner_id = ${this.userId}
          `;
          if (agents.length === 0) {
            this.writeCommandOutput("You don't have any agents yet.");
          } else {
            let agentList = "Your agents:\n";
            agents.forEach((agent) => {
              agentList += `- ${agent.name}: ${agent.system_prompt}\n`;
            });
            this.writeCommandOutput(agentList);
          }
        } catch (error) {
          console.error("Failed to list agents:", error);
          this.writeCommandOutput(
            `Failed to list agents. ${(error as Error).message}`
          );
        }
        return true;

      case "/setagent":
        if (!this.userId) {
          this.writeCommandOutput(
            "You need to be logged in to set an agent. Please use /register or /login first."
          );
          return true;
        }
        if (args.length !== 1) {
          this.writeCommandOutput("Usage: /setagent <agent_name>");
          return true;
        }
        const setAgentName = args[0];
        try {
          const [agent] = await sql<Agent[]>`
            SELECT id, name, system_prompt
            FROM agents
            WHERE owner_id = ${this.userId} AND name = ${setAgentName}
          `;
          if (agent) {
            this.currentAgent = agent;
            this.writeCommandOutput(`Now using agent "${agent.name}".`);
          } else {
            this.writeCommandOutput(`Agent "${setAgentName}" not found.`);
          }
        } catch (error) {
          console.error("Failed to set agent:", error);
          this.writeCommandOutput(
            `Failed to set agent. ${(error as Error).message}`
          );
        }
        return true;

      case "/clearagent":
        this.currentAgent = null;
        this.writeCommandOutput(
          "Cleared current agent. Using default settings."
        );
        return true;

      case "/help":
        const helpMessage = `
Available Commands:
  /reset   - Clear conversation history
  /history - Show conversation history
  /stats   - Show session statistics
  /system  - Set system prompt
  /clear   - Clear screen
  /retry   - Retry last message with optional temperature:
             /retry 0.8
  /register <username> - Register a new account
  /login <username>    - Login to an existing account
  /join <room_name>    - Join a room (requires login)
  /leave               - Leave the current room (requires login)
  /rooms               - List all available rooms (requires login)
  /createagent <name> <system_prompt> - Create a new agent (requires login)
  /modifyagent <name> <system_prompt> - Modify an existing agent (requires login)
  /listagents          - List all your agents (requires login)
  /setagent <agent_name> - Set the current agent (requires login)
  /clearagent          - Clear the current agent and use default settings (requires login)
  exit     - Exit the session`;
        this.writeCommandOutput(helpMessage);
        return true;

      default:
        return false;
    }
  }

  async streamResponse(message: string) {
    try {
      if (this.credits <= 0) {
        this.writeCommandOutput(
          "You've run out of credits. Please register or login to continue."
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

      let agent = this.currentAgent;
      if (!agent && message.includes("@")) {
        const mentionedAgentName = message.match(/@(\w+)/)?.[1];
        if (mentionedAgentName) {
          const [mentionedAgent] = await sql<Agent[]>`
            SELECT id, name, system_prompt
            FROM agents
            WHERE owner_id = ${this.userId} AND name = ${mentionedAgentName}
          `;
          if (mentionedAgent) {
            agent = mentionedAgent;
            message = message.replace(`@${mentionedAgentName}`, "").trim();
          }
        }
      }

      console.log(`Streaming response for user ${this.username || this.id}`);
      let fullResponse = "";
      const messageStream = await anthropic.messages.stream({
        model: this.model,
        max_tokens: 1024,
        temperature: this.temperature,
        messages: this.conversation,
        system: agent ? agent.system_prompt : this.systemPrompt,
      });

      this.writeToStream("\r\n", false); // Start the response on a new line

      for await (const chunk of messageStream) {
        if (chunk.type === "content_block_delta") {
          const text = chunk.delta.text;
          fullResponse += text;
          this.writeToStream(
            "\x1b[33m" + text.replace(/\n/g, "\r\n") + "\x1b[0m",
            false
          );
        }
      }

      this.conversation.push({
        role: "assistant",
        content: fullResponse,
      });

      this.writeToStream("\r\n", false); // Add a newline after the response
      this.writeToStream("", true); // Display the prompt
      console.log(`Response completed for user ${this.username || this.id}`);
      return true;
    } catch (error) {
      console.error(
        `Error in streamResponse for user ${this.username || this.id}:`,
        error
      );
      this.writeCommandOutput(
        `\x1b[31mError: ${(error as Error).message}\x1b[0m`
      );
      return false;
    }
  }

  async handleMessage(message: string) {
    const trimmedMessage = message.trim();

    if (!trimmedMessage) {
      this.writeToStream("> ");
      return;
    }

    const now = Date.now();
    if (now - this.lastRequest < 3000 && this.lastRequest !== 0) {
      this.writeCommandOutput(
        "Please wait a few seconds before sending another message."
      );
      return;
    }

    // Check if it's a command
    if (trimmedMessage.startsWith("/")) {
      const handled = await this.handleCommand(trimmedMessage);
      if (handled) return;
    }

    // If in a room, broadcast the message
    if (this.currentRoom) {
      await this.currentRoom.broadcast(trimmedMessage, this);
      this.writeToStream("> ");
      return;
    }

    const success = await this.streamResponse(trimmedMessage);
    if (success) {
      this.lastRequest = now;
      this.requestCount++;
    }
  }

  async leaveRoom() {
    if (this.currentRoom && this.userId) {
      try {
        await sql`
          DELETE FROM room_members
          WHERE room_id = ${this.currentRoom.id} AND user_id = ${this.userId}
        `;
        this.currentRoom.removeMember(this);
        await this.currentRoom.addMessage(
          `${this.username || this.id} has left the room.`,
          null,
          true
        );
        this.currentRoom.broadcast(
          `${this.username || this.id} has left the room.`,
          this
        );
        this.currentRoom = null;
      } catch (error) {
        console.error(`Failed to leave room: ${error.message}`);
      }
    }
  }
}
const HOST_KEY_PATH = "./host.key";
// Modify the server startup code
const PORT = process.env.PORT ?? 2222;

console.log("Initializing server on port", PORT);

const server = new SSH2.Server(
  {
    hostKeys: [readFileSync(HOST_KEY_PATH)],
    bind: {
      port: PORT,
      host: "0.0.0.0",
      family: 4, // Force IPv4
    },
  },
  async (client) => {
    console.log("Client connected");

    const sessionId = `session_${++sessionCounter}`;
    let autoLoginUsername: string | null = null;

    const handleStream = async (stream) => {
      console.log(`Stream opened for session ${sessionId}`);
      let autoLoginInfo: AutoLoginInfo | null = null;

      if (autoLoginUsername) {
        try {
          const [userInfo] = await sql<[{ id: string; credits: number }]>`
            SELECT id, credits FROM accounts
            WHERE username = ${autoLoginUsername}
          `;
          if (userInfo) {
            autoLoginInfo = {
              username: autoLoginUsername,
              userId: userInfo.id,
              credits: userInfo.credits,
            };
          }
        } catch (error) {
          console.error("Error fetching user info for auto-login:", error);
        }
      }

      const session = new ClientSession(sessionId, stream, autoLoginInfo);
      sessions.set(sessionId, session);

      // Welcome message with badass ASCII art
      const welcomeMessage = `
\x1b[35m
                           __   _                         __  
____ _ __  __ ___   _____ / /_ (_)____   ____      _____ / /_ 
/ __ \`// / / // _ \ / ___// __// // __ \ / __ \    / ___// __ \\
/ /_/ // /_/ //  __/(__  )/ /_ / // /_/ // / / /_  (__  )/ / / /
\__, / \__,_/ \___//____/ \__//_/ \____//_/ /_/(_)/____//_/ /_/ 
/_/                                                            
\x1b[0m
🤖 Welcome to \x1b[1mquestion.sh\x1b[0m - Your AI-powered SSH interface!
Create shared rooms and reusable agents.
${
  autoLoginInfo
    ? `\x1b[32mYou are logged in as ${autoLoginInfo.username}. You have ${autoLoginInfo.credits} credits.\x1b[0m`
    : "You are not logged in. Use /register or /login to access all features."
}
Type your message and press Enter. Commands:
- Type "exit" to quit
- Type "/help" for available commands`;

      session.writeCommandOutput(welcomeMessage);

      // If auto-login was successful, notify the user
      if (autoLoginUsername) {
        session.writeCommandOutput(
          `Automatically logged in as ${autoLoginUsername}.`
        );
      }

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

          const trimmedBuffer = session.buffer.trim();
          if (trimmedBuffer.toLowerCase() === "exit") {
            stream.write("Goodbye! 👋\r\n");
            sessions.delete(sessionId);
            stream.end();
            return;
          }

          if (trimmedBuffer) {
            await session.handleMessage(trimmedBuffer);
          } else {
            // If the buffer is empty or only contains whitespace, just show the prompt
            session.writeToStream("", true);
          }

          session.buffer = "";
          return;
        }

        // Regular character input
        session.buffer += input;
        stream.write(input);
      });

      stream.on("error", (err) => {
        console.error(`Stream error for session ${sessionId}:`, err);
        sessions.delete(sessionId);
      });

      stream.on("close", () => {
        console.log(`Stream closed for session ${sessionId}`);
        sessions.delete(sessionId);
      });
    };

    client.on("authentication", async (ctx) => {
      if (ctx.method === "password" && ctx.username) {
        try {
          const result = await sql`
            SELECT id, credits FROM accounts
            WHERE username = ${ctx.username}
          `;
          if (result.length > 0) {
            autoLoginUsername = ctx.username;
            console.log(`Auto-login successful for user: ${ctx.username}`);
          } else {
            console.log(`Auto-login failed: User ${ctx.username} not found`);
          }
        } catch (error) {
          console.error("Auto-login error:", error);
        }
      }
      ctx.accept();
    });

    client.on("ready", () => {
      console.log(`Client authenticated! (Session: ${sessionId})`);
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept) => accept());
        session.on("shell", (accept) => {
          const stream = accept();
          handleStream(stream);

          // If auto-login was successful, update the session
          if (autoLoginUsername) {
            const clientSession = sessions.get(sessionId);
            if (clientSession) {
              sql`
                SELECT id, credits FROM accounts
                WHERE username = ${autoLoginUsername}
              `
                .then(([result]) => {
                  clientSession.userId = result.id;
                  clientSession.username = autoLoginUsername;
                  clientSession.credits = result.credits;
                })
                .catch((error) => {
                  console.error(
                    "Error updating session after auto-login:",
                    error
                  );
                });
            }
          }
        });
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

// Add this function near the end of the file, before server.listen()
async function testDatabaseConnection() {
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

// Add error event listener before calling listen
server.on("error", (err) => {
  console.error("Server error:", {
    code: err.code,
    message: err.message,
    stack: err.stack,
  });
});

server.on("listening", () => {
  const address = server.address();
  console.log("Server listening on:", address);
});

server.listen(PORT);

await testDatabaseConnection();

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
