import { v4 as uuidv4 } from "uuid";
import Anthropic from "@anthropic-ai/sdk";
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

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export class ClientSession implements IClientSession {
  id: string;
  buffer = "";
  lastRequest = 0;
  requestCount = 0;
  conversation: Message[] = [];
  startTime = Date.now();
  model = "claude-3-5-sonnet-20240620";
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
    }

    this.clientIP = clientIP;
  }

  writeToStream(message: string, addPrompt: boolean = true) {
    this.stream.write(message.replace(/\n/g, "\r\n"));
    if (addPrompt) {
      const roomName = this.currentRoom ? `${this.currentRoom.name} ` : "";
      this.stream.write(`\r\n\x1b[36m${roomName}>\x1b[0m `);
    }
  }

  writeCommandOutput(message: string) {
    const trimmedMessage = message.trim().replace(/\n/g, "\r\n");
    const roomName = this.currentRoom ? `${this.currentRoom.name} ` : "";
    this.stream.write("\r\n" + trimmedMessage + "\r\n");
    this.stream.write(`\x1b[36m${roomName}>\x1b[0m `);
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
        if (args.length !== 2) {
          this.writeCommandOutput("Usage: /register <username> <password>");
          return true;
        }
        const [username, password] = args;
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

          const password_hash = await bcrypt.hash(password, 10);
          const result = await sql`
            INSERT INTO accounts (id, username, credits, password_hash)
            VALUES (${uuidv4()}, ${username}, 30, ${password_hash})
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
        if (args.length !== 2) {
          this.writeCommandOutput("Usage: /login <username> <password>");
          return true;
        }
        const [loginUsername, loginPassword] = args;
        try {
          const [user] = await sql`
            SELECT id, credits, password_hash FROM accounts
            WHERE username = ${loginUsername}
          `;
          if (!user) {
            this.writeCommandOutput(`No account found with this username.`);
            return true;
          }

          const passwordMatch = await bcrypt.compare(
            loginPassword,
            user.password_hash
          );
          if (!passwordMatch) {
            this.writeCommandOutput(`Invalid password.`);
            return true;
          }

          this.userId = user.id;
          this.username = loginUsername;
          this.credits = user.credits;
          this.writeCommandOutput(
            `Logged in successfully. Welcome back, ${loginUsername}! You have ${this.credits} credits.`
          );
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
      } else {
        const currentCredits = guestCredits.get(this.clientIP) || 0;
        guestCredits.set(this.clientIP, currentCredits - 1);
      }

      this.conversation.push({
        role: "user",
        content: message,
      });

      let character = this.currentCharacter;
      if (!character && message.includes("@")) {
        const mentionedCharacterName = message.match(/@(\w+)/)?.[1];
        if (mentionedCharacterName) {
          const [mentionedCharacter] = await sql<Character[]>`
            SELECT id, name, system_prompt
            FROM characters
            WHERE owner_id = ${this.userId} AND name = ${mentionedCharacterName}
          `;
          if (mentionedCharacter) {
            character = mentionedCharacter;
            message = message.replace(`@${mentionedCharacterName}`, "").trim();
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
        system: character ? character.system_prompt : this.systemPrompt,
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

    // If in adventure mode, handle adventure messages
    if (this.isInAdventure) {
      if (trimmedMessage.toLowerCase() === "exit") {
        this.isInAdventure = false;
        this.writeCommandOutput("You have exited the adventure mode.");
        this.writeToStream("> ");
      } else {
        await handleAdventureMessage(this, trimmedMessage);
      }
      return;
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
