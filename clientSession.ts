import { v4 as uuidv4 } from "uuid";
import { sql } from "./database";
import {
  ClientSession as IClientSession,
  Message,
  Character,
  AutoLoginInfo,
} from "./types";
import { Stream } from "ssh2";
import bcrypt from "bcrypt";
import { guestCredits } from "./server";
import { openai } from "./index";
import { handleAdventure, handleAdventureMessage } from "./adventureMode";
import { generateHelpMessage } from "./utils";

// Add this new global variable
let cachedModelList: any[] = [];

// Add this new function to fetch and cache the model list
export async function fetchAndCacheModelList() {
  try {
    const response = await openai.models.list();
    cachedModelList = response.data;
    console.log("Model list cached successfully");
  } catch (error) {
    console.error("Error caching model list:", error);
  }
}

// Add a constant for the profit rate
const PROFIT_RATE = 1.5; // 50% profit

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
  credits = 0.1; // Default credits for unlogged users (in USD)
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
      this.stream.write(`\r\n\x1b[36m>\x1b[0m `);
      this.cursorPos = 0;
    }
  }

  writeCommandOutput(message: string, addPrompt: boolean = true) {
    const trimmedMessage = message.trim().replace(/\n/g, "\r\n");
    this.stream.write("\r\n" + trimmedMessage);
    if (addPrompt) {
      this.stream.write("\r\n");
      this.stream.write(`\x1b[36m>\x1b[0m `);
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

      case "/balance":
        this.writeCommandOutput(
          `Your current balance is $${this.credits.toFixed(4)} credits.`
        );
        return true;

      default:
        return false;
    }
  }

  async streamResponse(userMessage: string): Promise<void> {
    if (this.credits <= 0) {
      this.writeCommandOutput(
        "You have run out of credits. Please add more credits to continue."
      );
      return;
    }

    try {
      console.log(
        `[${this.id}] Starting stream response for model: ${this.model}`
      );
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
      let usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      } | null = null;

      // Move the cursor to the beginning of the line and clear it
      this.writeToStream("\r\x1b[K", false);

      for await (const chunk of stream) {
        if (chunk.choices[0]?.delta?.content) {
          const content = chunk.choices[0].delta.content;
          fullResponse += content;

          if (isFirstChunk) {
            // For the first chunk, ensure we start on a new line
            this.writeToStream("\n", false);
            isFirstChunk = false;
          }

          this.writeToStream(content, false);
        }

        // Check if this is the last chunk with usage information
        if (chunk.usage) {
          usage = chunk.usage;
          console.log(
            `[${this.id}] Received usage data:`,
            JSON.stringify(usage)
          );
        }
      }

      this.writeToStream("\n");
      this.conversation.push({ role: "user", content: userMessage });
      this.conversation.push({
        role: "assistant",
        content: fullResponse.trim(),
      });

      if (usage) {
        // Calculate the cost of the request using the accurate usage data
        const cost = this.calculateRequestCost(usage);
        this.credits -= cost;

        // Update credits in the database or guest credits map
        await this.updateCredits();

        // console.log(
        //   `[${this.id}] Request cost: $${cost.toFixed(
        //     4
        //   )}, Remaining credits: $${this.credits.toFixed(4)}`
        // );
        // this.writeCommandOutput(
        //   `Request cost: $${cost.toFixed(
        //     4
        //   )}. Remaining credits: $${this.credits.toFixed(4)}`
        // );
      } else {
        console.error(`[${this.id}] Usage data not received from the API`);
        this.writeCommandOutput(
          "Unable to calculate request cost due to missing usage data."
        );
      }
    } catch (error) {
      console.error(`[${this.id}] Error querying model:`, error);
      let errorMessage = "Error, use /model to try another model.";
      if (error instanceof Error) {
        errorMessage += ` ${error.name}: ${error.message}`;
        if ("code" in error) {
          errorMessage += ` (${(error as any).code})`;
        }
      }
      this.writeCommandOutput(`\x1b[31m${errorMessage}\x1b[0m`);
    }
  }

  private calculateRequestCost(usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }): number {
    console.log(
      `[${this.id}] Calculating request cost for model: ${this.model}`
    );
    const modelPricing = cachedModelList.find(
      (m) => m.id === this.model
    )?.pricing;
    if (!modelPricing) {
      console.error(`[${this.id}] Pricing not found for model: ${this.model}`);
      return 0;
    }

    console.log(`[${this.id}] Model pricing:`, JSON.stringify(modelPricing));
    const promptCost = parseFloat(modelPricing.prompt) * usage.prompt_tokens;
    const completionCost =
      parseFloat(modelPricing.completion) * usage.completion_tokens;
    const totalCost = (promptCost + completionCost) * PROFIT_RATE;

    console.log(
      `[${this.id}] Cost breakdown - Prompt: $${promptCost.toFixed(
        6
      )}, Completion: $${completionCost.toFixed(
        6
      )}, Total (with profit): $${totalCost.toFixed(6)}`
    );
    return totalCost;
  }

  private async updateCredits(): Promise<void> {
    if (this.username && this.username !== "guest") {
      await sql`
        UPDATE accounts
        SET credits = ${this.credits}
        WHERE username = ${this.username}
      `;
    } else {
      guestCredits.set(this.clientIP, this.credits);
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

  private async handleInteractiveAuth(mode: "login" | "register") {
    const stream = this.stream;

    // Function to validate input
    const validateInput = (
      input: string,
      type: "username" | "password" | "email"
    ): string | null => {
      if (input.length < 3) {
        return `${type} must be at least 3 characters long.`;
      }
      if (input.length > 50) {
        return `${type} must be less than 50 characters long.`;
      }
      if (type === "email" && !input.includes("@")) {
        return "Invalid email format.";
      }
      if (type === "username" && !/^[a-zA-Z0-9]+$/.test(input)) {
        return "Username must contain only alphanumeric characters.";
      }
      return null;
    };

    // Function to get input with validation
    const getInput = async (
      prompt: string,
      type: "username" | "password" | "email"
    ): Promise<string | null> => {
      while (true) {
        this.writeCommandOutput(prompt, false);
        stream.write(" ");

        const input = await new Promise<string | null>((resolve) => {
          let inputBuffer = "";
          const handler = (data: Buffer) => {
            const char = data.toString();
            if (char === "\x03") {
              // Ctrl+C
              stream.write("^C\n");
              resolve(null);
            } else if (char === "\r") {
              stream.write("\n");
              stream.removeListener("data", handler);
              resolve(inputBuffer.trim());
            } else if (char === "\x7f") {
              // Backspace
              if (inputBuffer.length > 0) {
                inputBuffer = inputBuffer.slice(0, -1);
                stream.write("\b \b");
              }
            } else {
              inputBuffer += char;
              stream.write(type === "password" ? "*" : char);
            }
          };
          this.inputHandler = handler;
        });

        if (input === null) {
          return null; // User pressed Ctrl+C
        }

        const validationError = validateInput(input, type);
        if (validationError) {
          this.writeCommandOutput(validationError);
        } else {
          return input;
        }
      }
    };

    const username = await getInput("Username:", "username");
    if (username === null) {
      this.writeCommandOutput("Signup cancelled.");
      this.resetInputHandler();
      return;
    }

    const password = await getInput("Password:", "password");
    if (password === null) {
      this.writeCommandOutput("Signup cancelled.");
      this.resetInputHandler();
      return;
    }

    let email: string | null = "";
    if (mode === "register") {
      email = await getInput("Email:", "email");
      if (email === null) {
        this.writeCommandOutput("Signup cancelled.");
        this.resetInputHandler();
        return;
      }
    }

    this.inputHandler = null; // Clear the handler when done

    // Handle the auth based on mode
    if (mode === "register") {
      try {
        const [existingUser] = await sql`
          SELECT id FROM accounts WHERE username = ${username} OR email = ${email}
        `;
        if (existingUser) {
          this.writeCommandOutput(`Username or email is already taken.`);
          return;
        }

        const password_hash = await bcrypt.hash(password, 10);
        const result = await sql`
          INSERT INTO accounts (id, username, email, credits, password_hash)
          VALUES (${uuidv4()}, ${username}, ${email}, 0.3, ${password_hash})
          RETURNING id, credits
        `;
        this.userId = result[0].id;
        this.username = username;
        this.credits = result[0].credits;
        this.writeCommandOutput(
          `Registered successfully. Welcome, ${username}! You have $${this.credits.toFixed(
            4
          )} credits.`
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
          `Logged in successfully. Welcome back, ${username}! You have $${this.credits.toFixed(
            4
          )} credits.`
        );
      } catch (error) {
        this.writeCommandOutput(`Login failed. Please try again.`);
      }
    }
  }

  private resetInputHandler(): void {
    this.inputHandler = null;
    this.setInputHandler(); // Re-initialize the input handler
    this.writeCommandOutput(""); // Write a new prompt
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
      const modelList = cachedModelList
        .sort((a, b) => b.created - a.created)
        .slice(0, 50)
        .map((model) => model.id)
        .map((modelId) => {
          const isSelected = modelId === this.model;
          return isSelected
            ? `\x1b[1m\x1b[35m${modelId} (current)\x1b[0m`
            : modelId;
        })
        .join("\n");
      this.writeCommandOutput(`Available models:\n${modelList}`);
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
    const prompt = `\r\x1b[36m>\x1b[0m `;
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
    this.stream.removeAllListeners();
    // Add any other necessary cleanup tasks here
  }
}
