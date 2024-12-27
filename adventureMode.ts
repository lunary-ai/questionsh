import { readFileSync } from "fs";
import { v4 as uuidv4 } from "uuid";
import { openai } from "./index";
import { sql } from "./database";
import { ClientSession, Message } from "./types";

const ADVENTURE_MODEL = "anthropic/claude-3.5-sonnet";
const ADVENTURE_SYSTEM_PROMPT = readFileSync("game_prompt.txt", "utf-8");

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

    const stream = await openai.chat.completions.create({
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
      ],
      tool_choice: "auto",
    });

    let fullResponse = "";
    let shouldSaveGame = false;
    let isFirstChunk = true;
    let buffer = "";
    let inCodeBlock = false;

    // Clear the current line
    session.writeToStream("\r\n", false);

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      const toolCalls = chunk.choices[0]?.delta?.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        shouldSaveGame = toolCalls.some(
          (call) => call.function?.name === "save_game"
        );
      }

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

    session.writeToStream("\r\n\x1b[36m>\x1b[0m ", false);
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
