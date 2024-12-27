import { readFileSync } from "fs";
import { v4 as uuidv4 } from "uuid";
import { openai } from "./index";
import { sql } from "./database";
import { ClientSession, Message } from "./types";

const ADVENTURE_MODEL = "anthropic/claude-3.5-sonnet";
const ADVENTURE_SYSTEM_PROMPT = readFileSync("game_prompt.txt", "utf-8");

const COLORS = {
  GREEN: "\x1b[32m",
  RED: "\x1b[31m",
  CYAN: "\x1b[36m",
  RESET: "\x1b[0m",
};

// Add these ASCII arts at the top
const WIN_ART = `
    ⭐️ VICTORY ⭐️
    
    \\\\╔═══════════════╗//
     ║  SYSTEM CLEAR  ║
    //╚═══════════════╝\\\\
    
   Reality Restored
   The Merge Reversed
`;

const LOSE_ART = `
     SYSTEM FAILURE     
    ╔═══════════════╗
    ║ PROCESS ENDED ║
    ╚═══════════════╝
    
    ░█▀▀▄░█▀▀░█▀▀▄░█▀▀▄
    ░█░░█░█▀▀░█▄▄█░█░░█
    ░▀▀▀░░▀▀▀░▀░░▀░▀▀▀░
`;

export async function handleAdventure(session: ClientSession, input: string) {
  if (!session.userId) {
    session.writeCommandOutput(
      "You need to be logged in to play. Please use /login or /register first."
    );
    return;
  }

  if (!session.isInAdventure) {
    session.isInAdventure = true;
    session.adventureConversation = [];
    session.writeToStream("\x1B[2J\x1B[H\x1B[3J");
    await handleAdventureMessage(session, "start");
  } else {
    await handleAdventureMessage(session, input);
  }
}

export async function handleAdventureMessage(
  session: ClientSession,
  message: string
) {
  try {
    session.adventureConversation.push({
      role: "user",
      content: message,
    });

    const stream = await openai.beta.chat.completions.stream({
      model: ADVENTURE_MODEL,
      messages: [
        { role: "system", content: ADVENTURE_SYSTEM_PROMPT },
        ...session.adventureConversation.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      ],
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "save_game",
            description: "Save the current game progress",
            parameters: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "win_game",
            description: "Call when player has won the game",
            parameters: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "lose_game",
            description: "Call when player has lost the game",
            parameters: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        },
      ],
      tool_choice: "auto",
    });

    let fullResponse = "";
    let shouldSaveGame = false;
    let gameWon = false;
    let gameLost = false;
    let isFirstChunk = true;
    let buffer = "";
    let inCodeBlock = false;

    // Clear the current line
    session.writeToStream("\r\n", false);

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";

      if (content) {
        buffer += content;

        // Check for code block markers
        if (buffer.includes("```")) {
          inCodeBlock = !inCodeBlock;
        }

        // Only process complete lines when we have a newline and we're not in a code block
        if (buffer.includes("\n") && !inCodeBlock) {
          const lines = buffer.split("\n");
          // Keep the last line in the buffer if it doesn't end with a newline
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (isFirstChunk) {
              isFirstChunk = false;
            } else {
              session.writeToStream("\r\n", false);
            }
            session.writeToStream("\r" + line, false);
          }
        }
      }

      fullResponse += content;
    }

    const chatCompletion = await stream.finalChatCompletion();

    const toolCalls = chatCompletion.choices[0]?.message?.tool_calls;

    if (toolCalls && toolCalls.length > 0) {
      for (const call of toolCalls) {
        switch (call.function?.name) {
          case "save_game":
            shouldSaveGame = true;
            break;
          case "win_game":
            gameWon = true;
            break;
          case "lose_game":
            gameLost = true;
            break;
        }
      }
    }

    // Flush any remaining buffer
    if (buffer) {
      if (!isFirstChunk) {
        session.writeToStream("\r\n", false);
      }
      session.writeToStream("\r" + buffer, false);
    }

    session.adventureConversation.push({
      role: "assistant",
      content: fullResponse.trim(),
    });

    if (shouldSaveGame) {
      await saveGameProgress(session);
      session.writeToStream("\r\n\x1b[32mGame progress saved!\x1b[0m", false);
    }

    if (gameWon || gameLost) {
      const color = gameWon ? COLORS.GREEN : COLORS.RED;
      const art = gameWon ? WIN_ART : LOSE_ART;
      const message = gameWon
        ? "🎉 Congratulations! You've won the game! 🎉"
        : "Game Over! Better luck next time!";

      // Add some spacing before the game end message
      session.writeToStream("\r\n\r\n", false);

      // Display the ASCII art and message
      session.writeToStream(`${color}${art}${COLORS.RESET}`, false);
      session.writeToStream(`\r\n${color}${message}${COLORS.RESET}`, false);

      // Add a small delay before showing options
      await new Promise((resolve) => setTimeout(resolve, 500));

      session.writeToStream("\r\n\r\nWhat would you like to do?", false);
      session.writeToStream("\r\n1. Start a new adventure", false);
      session.writeToStream("\r\n2. Return to main menu", false);
      session.writeToStream(`\r\n${COLORS.CYAN}>${COLORS.RESET} `, false);

      // Set a flag to handle the next input differently
      session.gameEndChoice = true;
      session.isInAdventure = false;
      session.adventureConversation = [];
    } else {
      session.writeToStream(`\r\n${COLORS.CYAN}>${COLORS.RESET} `, false);
    }

    console.log(
      `Adventure turn completed for user ${session.username || session.id}`
    );
  } catch (error) {
    console.error("Error in adventure mode:", error);
    session.writeCommandOutput(
      "An error occurred during the adventure. Please try again."
    );
  }
}

export async function saveGameProgress(session: ClientSession) {
  if (!session.userId) {
    console.error("Attempted to save game progress for non-logged in user");
    return;
  }

  try {
    const gameId = uuidv4();
    const conversationJson = JSON.stringify(session.adventureConversation);

    await sql`
      INSERT INTO game_saves (id, user_id, conversation, created_at)
      VALUES (${gameId}, ${session.userId}, ${conversationJson}, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET conversation = ${conversationJson}, updated_at = NOW()
    `;

    console.log(
      `Game progress saved for user ${session.username || session.id}`
    );
  } catch (error) {
    console.error(`Failed to save game progress: ${error.message}`);
  }
}

export async function handleGameEndChoice(
  session: ClientSession,
  input: string
) {
  try {
    switch (input.trim()) {
      case "1":
        session.isInAdventure = true;
        session.gameEndChoice = false;
        session.adventureConversation = [];
        session.writeToStream("\x1B[2J\x1B[H\x1B[3J", false); // Only clear screen when starting new game
        await handleAdventureMessage(session, "start");
        break;
      case "2":
        session.gameEndChoice = false;
        session.writeCommandOutput(
          "Welcome back! Type /help to see available commands."
        );
        break;
      default:
        session.writeToStream("\r\nPlease choose 1 or 2:", false);
        session.writeToStream("\r\n1. Start a new adventure", false);
        session.writeToStream("\r\n2. Return to main menu", false);
        session.writeToStream(`\r\n${COLORS.CYAN}>${COLORS.RESET} `, false);
    }
  } catch (error) {
    console.error("Error handling game end choice:", error);
    session.writeToStream("\r\nAn error occurred. Please try again.", false);
    session.writeToStream("\r\n1. Start a new adventure", false);
    session.writeToStream("\r\n2. Return to main menu", false);
    session.writeToStream(`\r\n${COLORS.CYAN}>${COLORS.RESET} `, false);
  }
}
