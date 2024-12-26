import { v4 as uuidv4 } from "uuid";
import { sql } from "./database";
import {
  ClientSession as IClientSession,
  Message,
  Room,
  Character,
  AutoLoginInfo,
} from "./types";
import { Room as RoomImpl } from "./room";
import {
  handleAdventure,
  handleAdventureMessage,
  saveGameProgress,
} from "./adventureMode";
import { generateHelpMessage } from "./utils";
import { Stream } from "ssh2";
import bcrypt from "bcrypt";
import { guestCredits } from "./server";
import { openai } from "./index";

export class ClientSession implements IClientSession {
  id: string;
  buffer = "";
  lastRequest = 0;
  requestCount = 0;
  conversation: Message[] = [];
  startTime = Date.now();
  model = "google/gemini-2.0-flash-thinking-exp:free";
  systemPrompt =
    "You are a helpful AI assistant accessed through a SSH service called question.sh. Keep responses concise and use simple formatting.";
  temperature = 1.0;
  userId: string | null = null;
  username: string | null = null;
  credits = 10;
  currentRoom: Room | null = null;
  stream: Stream;
  currentCharacter: Character | null = null;
  isInAdventure: boolean = false;
  adventureConversation: Message[] = [];
  clientIP: string;
  public inputHandler: ((data: Buffer) => void) | null = null;
  cursorPos: number = 0;
  clientPublicKey: string | null = null;
  private inputBuffer: string = "";

  constructor(
    id: string,
    stream: Stream,
    autoLoginInfo: AutoLoginInfo | null = null,
    clientIP: string
  ) {
    this.id = id;
    this.stream = stream;
    console.log(`New client session created: ${id}`);

    if (autoLoginInfo) {
      this.username = autoLoginInfo.username;
      this.userId = autoLoginInfo.userId;
      this.credits = autoLoginInfo.credits;
      console.log(`Auto-logged in user: ${autoLoginInfo.username}`);
      this.loadSelectedModel();
    }

    this.clientIP = clientIP;
    this.setInputHandler();
  }

  writeToStream(message: string, addPrompt: boolean = true) {
    this.stream.write(message.replace(/\n/g, "\r\n"));
    if (addPrompt) {
      const roomName = this.currentRoom ? `${this.currentRoom.name} ` : "";
      this.stream.write(`\r\n\x1b[36m${roomName}>\x1b[0m `);
      this.cursorPos = 0;
    }
  }

  writeCommandOutput(message: string, addPrompt: boolean = true) {
    const trimmedMessage = message.trim().replace(/\n/g, "\r\n");
    const roomName = this.currentRoom ? `${this.currentRoom.name} ` : "";
    this.stream.write("\r\n" + trimmedMessage);
    if (addPrompt) {
      this.stream.write("\r\n");
      this.stream.write(`\x1b[36m${roomName}>\x1b[0m `);
    }
  }

  async handleCommand(cmd: string): Promise<boolean> {
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
          const role = msg.role === "user" ? "You" : "Assistant";
          this.writeCommandOutput(`${role}: ${msg.content}\r\n`);
        });
        return true;

      case "/stats":
        const runtime = Math.floor((Date.now() - this.startTime) / 1000);
        const messages = this.conversation.length;
        const statsMessage = `Session Statistics:
- Runtime: ${runtime} seconds
- Messages: ${messages}
- Current model: ${this.model}
- Temperature: ${this.temperature}`;
        this.writeCommandOutput(statsMessage);
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
        if (args.length > 0) {
          this.writeCommandOutput("Usage: /register");
          return true;
        }
        await this.handleInteractiveAuth("register");
        return true;

      case "/login":
        if (args.length > 0) {
          this.writeCommandOutput("Usage: /login");
          return true;
        }
        await this.handleInteractiveAuth("login");
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
          this.currentRoom = new RoomImpl(roomToJoin.id, roomToJoin.name);
          this.currentRoom.addMember(this);

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

      case "/char":
        if (!this.userId) {
          this.writeCommandOutput(
            "You need to be logged in to manage characters. Please use /register or /login first."
          );
          return true;
        }

        if (args.length === 0) {
          this.writeCommandOutput(
            "Usage:\n" +
              "  /char list                    - List your characters\n" +
              "  /char new <name> <prompt>     - Create a new character\n" +
              "  /char edit <name> <prompt>    - Modify a character\n" +
              "  /char use <name>             - Set active character\n" +
              "  /char clear                  - Clear active character"
          );
          return true;
        }

        const [subcommand, ...subargs] = args;

        switch (subcommand) {
          case "new":
            if (subargs.length < 2) {
              this.writeCommandOutput(
                "Usage: /char new <name> <system_prompt>"
              );
              return true;
            }
            const [characterName, ...promptParts] = subargs;
            const systemPrompt = promptParts.join(" ");

            try {
              await sql`
                INSERT INTO characters (id, owner_id, name, system_prompt)
                VALUES (${uuidv4()}, ${
                this.userId
              }, ${characterName}, ${systemPrompt})
                RETURNING id
              `;
              this.writeCommandOutput(
                `Character "${characterName}" created successfully.`
              );
            } catch (error) {
              console.error("Failed to create character:", error);
              this.writeCommandOutput(
                `Failed to create character. ${(error as Error).message}`
              );
            }
            return true;

          case "edit":
            if (subargs.length < 2) {
              this.writeCommandOutput(
                "Usage: /char edit <name> <system_prompt>"
              );
              return true;
            }
            const [editName, ...newPromptParts] = subargs;
            const newSystemPrompt = newPromptParts.join(" ");

            try {
              const result = await sql`
                UPDATE characters
                SET system_prompt = ${newSystemPrompt}
                WHERE owner_id = ${this.userId} AND name = ${editName}
              `;
              if (result.count > 0) {
                this.writeCommandOutput(
                  `Character "${editName}" updated successfully.`
                );
              } else {
                this.writeCommandOutput(`Character "${editName}" not found.`);
              }
            } catch (error) {
              console.error("Failed to update character:", error);
              this.writeCommandOutput(
                `Failed to update character. ${(error as Error).message}`
              );
            }
            return true;

          case "list":
            try {
              const characters = await sql`
                SELECT name, system_prompt
                FROM characters
                WHERE owner_id = ${this.userId}
              `;
              if (characters.length === 0) {
                this.writeCommandOutput("You don't have any characters yet.");
              } else {
                let characterList = "Your characters:\n";
                characters.forEach((character) => {
                  characterList += `- ${character.name}: ${character.system_prompt}\n`;
                });
                this.writeCommandOutput(characterList);
              }
            } catch (error) {
              console.error("Failed to list characters:", error);
              this.writeCommandOutput(
                `Failed to list characters. ${(error as Error).message}`
              );
            }
            return true;

          case "use":
            if (subargs.length !== 1) {
              this.writeCommandOutput("Usage: /char use <character_name>");
              return true;
            }
            const useName = subargs[0];
            try {
              const [character] = await sql<Character[]>`
                SELECT id, name, system_prompt
                FROM characters
                WHERE owner_id = ${this.userId} AND name = ${useName}
              `;
              if (character) {
                this.currentCharacter = character;
                this.writeCommandOutput(
                  `Now using character "${character.name}".`
                );
              } else {
                this.writeCommandOutput(`Character "${useName}" not found.`);
              }
            } catch (error) {
              console.error("Failed to set character:", error);
              this.writeCommandOutput(
                `Failed to set character. ${(error as Error).message}`
              );
            }
            return true;

          case "clear":
            this.currentCharacter = null;
            this.writeCommandOutput(
              "Cleared current character. Using default settings."
            );
            return true;

          default:
            this.writeCommandOutput(
              "Unknown subcommand. Use /char for usage help."
            );
            return true;
        }

      case "/adventure":
        if (this.isInAdventure) {
          this.writeCommandOutput(
            "You are already in an adventure. Type 'exit' to leave the adventure mode."
          );
        } else {
          await handleAdventure(this, "start");
        }
        return true;

      case "/help":
        const helpMessage = generateHelpMessage();
        this.writeCommandOutput(helpMessage);
        return true;

      case "/model":
        if (args.length === 0) {
          await this.listModels();
        } else {
          const modelName = args.join(" ");
          await this.selectModel(modelName);
        }
        return true;

      default:
        return false;
    }
  }

  async streamResponse(userMessage: string): Promise<void> {
    if (this.credits <= 0) {
      this.writeCommandOutput(
        "You have run out of credits. Please contact the administrator."
      );
      return;
    }

    this.credits--;
    if (this.username && this.username !== "guest") {
      await sql`
        UPDATE accounts
        SET credits = credits - 1
        WHERE username = ${this.username}
      `;
    } else {
      guestCredits.set(this.clientIP, this.credits);
    }

    try {
      const stream = await openai.chat.completions.create({
        model:
          this.model === "anthropic/claude-3.5-sonnet"
            ? "anthropic/claude-3.5-sonnet"
            : this.model,
        messages: [
          { role: "system", content: this.systemPrompt },
          ...this.conversation.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          { role: "user", content: userMessage },
        ],
        stream: true,
      });

      let fullResponse = "";
      let isFirstChunk = true;

      // Move the cursor to the beginning of the line and clear it
      this.writeToStream("\r\x1b[K", false);

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        fullResponse += content;

        if (isFirstChunk) {
          // For the first chunk, ensure we start on a new line
          this.writeToStream("\n", false);
          isFirstChunk = false;
        }

        this.writeToStream(content, false);
      }

      this.writeToStream("\n");
      this.conversation.push({ role: "user", content: userMessage });
      this.conversation.push({
        role: "assistant",
        content: fullResponse.trim(),
      });
    } catch (error) {
      console.error("Error querying model:", error);
      this.writeCommandOutput(
        "An error occurred while processing your query. Please try again."
      );
    }
  }

  async handleMessage(message: string): Promise<void> {
    if (message.trim().toLowerCase() === "exit") {
      this.terminateSession();
      return;
    }

    if (this.isInAdventure) {
      await handleAdventureMessage(this, message);
      return;
    }

    if (message.startsWith("/")) {
      const handled = await this.handleCommand(message);
      if (handled) return;
    }

    await this.streamResponse(message);
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

  private async handleInteractiveAuth(mode: "login" | "register") {
    const stream = this.stream;

    // Ask for username without prompt
    this.writeCommandOutput("Username:", false);
    stream.write(" "); // Add a space after the colon

    const username = await new Promise<string>((resolve) => {
      let input = "";
      const handler = (data: Buffer) => {
        const char = data.toString();
        if (char === "\r") {
          stream.write("\n");
          stream.removeListener("data", handler);
          resolve(input.trim());
        } else if (char === "\x7f") {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            stream.write("\b \b");
          }
        } else {
          input += char;
          stream.write(char);
        }
      };
      this.inputHandler = handler;
    });

    // Ask for password without prompt
    this.writeCommandOutput("Password:", false);
    stream.write(" "); // Add a space after the colon

    const password = await new Promise<string>((resolve) => {
      let input = "";
      const handler = (data: Buffer) => {
        const char = data.toString();
        if (char === "\r") {
          stream.write("\n");
          stream.removeListener("data", handler);
          resolve(input.trim());
        } else if (char === "\x7f") {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
        } else {
          input += char;
          stream.write("*");
        }
      };
      this.inputHandler = handler;
    });

    this.inputHandler = null; // Clear the handler when done

    // Handle the auth based on mode
    if (mode === "register") {
      try {
        const [existingUser] = await sql`
          SELECT id FROM accounts WHERE username = ${username}
        `;
        if (existingUser) {
          this.writeCommandOutput(`Username "${username}" is already taken.`);
          return;
        }

        const password_hash = await bcrypt.hash(password, 10);
        const result = await sql`
          INSERT INTO accounts (id, username, credits, password_hash)
          VALUES (${uuidv4()}, ${username}, 30, ${password_hash})
          RETURNING id, credits
        `;
        this.userId = result[0].id;
        this.username = username;
        this.credits = result[0].credits;
        this.writeCommandOutput(
          `Registered successfully. Welcome, ${username}! You have ${this.credits} credits.`
        );
      } catch (error) {
        console.error("Registration error:", error);
        this.writeCommandOutput(
          `Registration failed. Error: ${(error as Error).message}`
        );
      }
    } else {
      try {
        const [user] = await sql`
          SELECT id, credits, password_hash FROM accounts
          WHERE username = ${username}
        `;
        if (!user) {
          this.writeCommandOutput(`No account found with this username.`);
          return;
        }

        const passwordMatch = await bcrypt.compare(
          password,
          user.password_hash
        );
        if (!passwordMatch) {
          this.writeCommandOutput(`Invalid password.`);
          return;
        }

        this.userId = user.id;
        this.username = username;
        this.credits = user.credits;
        this.writeCommandOutput(
          `Logged in successfully. Welcome back, ${username}! You have ${this.credits} credits.`
        );
      } catch (error) {
        this.writeCommandOutput(`Login failed. Please try again.`);
      }
    }
  }

  async loadSelectedModel() {
    if (this.username && this.username !== "guest") {
      try {
        const [userInfo] = await sql<[{ selected_model: string }]>`
          SELECT selected_model FROM accounts
          WHERE username = ${this.username}
        `;
        if (userInfo && userInfo.selected_model) {
          this.model = userInfo.selected_model;
        }
      } catch (error) {
        console.error("Error loading selected model:", error);
      }
    }
  }

  async listModels() {
    try {
      const response = await openai.models.list();
      const sortedModels = response.data.sort((a, b) => b.created - a.created);
      const topModels = sortedModels.slice(0, 30);
      const modelList = topModels
        .map((model) => {
          const isSelected = model.id === this.model;
          return isSelected
            ? `\x1b[1m\x1b[35m${model.id} (current)\x1b[0m`
            : model.id;
        })
        .join("\n");
      this.writeCommandOutput(`Available models (top 30):\n${modelList}`);
    } catch (error) {
      console.error("Error listing models:", error);
      this.writeCommandOutput("Error listing models. Please try again later.");
    }
  }

  async selectModel(modelId: string) {
    try {
      this.model = modelId;
      if (this.username && this.username !== "guest") {
        await sql`
          UPDATE accounts
          SET selected_model = ${modelId}
          WHERE username = ${this.username}
        `;
      }
      this.writeCommandOutput(`Model selected: ${modelId}`);
    } catch (error) {
      console.error("Error selecting model:", error);
      this.writeCommandOutput("Error selecting model. Please try again.");
    }
  }

  public setInputHandler(): void {
    this.inputHandler = (data: Buffer) => {
      const input = data.toString();

      // Handle Ctrl+C
      if (input === "\x03") {
        this.terminateSession();
        return;
      }

      // Handle arrow keys
      if (input === "\x1b[C") {
        // Right arrow
        if (this.cursorPos < this.inputBuffer.length) {
          this.cursorPos++;
          this.redrawInputLine();
        }
        return;
      }
      if (input === "\x1b[D") {
        // Left arrow
        if (this.cursorPos > 0) {
          this.cursorPos--;
          this.redrawInputLine();
        }
        return;
      }

      // Ignore other escape sequences
      if (input.startsWith("\x1b")) {
        return;
      }

      // Handle regular input
      if (input === "\r") {
        // Enter key pressed
        this.stream.write("\r\n");
        const command = this.inputBuffer.trim();
        this.inputBuffer = "";
        this.cursorPos = 0;
        this.handleMessage(command);
      } else if (input === "\x7f") {
        // Backspace
        if (this.cursorPos > 0) {
          this.inputBuffer =
            this.inputBuffer.slice(0, this.cursorPos - 1) +
            this.inputBuffer.slice(this.cursorPos);
          this.cursorPos--;
          this.redrawInputLine();
        }
      } else {
        // Regular character input
        this.inputBuffer =
          this.inputBuffer.slice(0, this.cursorPos) +
          input +
          this.inputBuffer.slice(this.cursorPos);
        this.cursorPos += input.length;
        this.redrawInputLine();
      }
    };
  }

  private redrawInputLine(): void {
    const roomName = this.currentRoom ? `${this.currentRoom.name} ` : "";
    const prompt = `\r\x1b[36m${roomName}>\x1b[0m `;
    const inputLine = this.inputBuffer;

    // Clear the current line and move cursor to the beginning
    this.stream.write("\r\x1b[K");

    // Write the prompt and input buffer
    this.stream.write(prompt + inputLine);

    // Move the cursor to the correct position
    const cursorOffset = inputLine.length - this.cursorPos;
    if (cursorOffset > 0) {
      this.stream.write(`\x1b[${cursorOffset}D`);
    }
  }

  private handlePastedContent(data: Buffer): void {
    const pastedContent = data.toString().trim();
    this.inputBuffer =
      this.inputBuffer.slice(0, this.cursorPos) +
      pastedContent +
      this.inputBuffer.slice(this.cursorPos);
    this.cursorPos += pastedContent.length;
    this.redrawInputLine();
  }

  private terminateSession(): void {
    this.writeCommandOutput("\r\nSession terminated. Goodbye!");
    this.stream.end();
    this.cleanup();
  }

  private cleanup(): void {
    if (this.currentRoom) {
      this.leaveRoom();
    }
    this.stream.removeAllListeners();
    // Add any other necessary cleanup tasks here
  }
}
