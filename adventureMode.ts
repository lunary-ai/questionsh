import { readFileSync } from "fs";
import { v4 as uuidv4 } from "uuid";
import Anthropic from "@anthropic-ai/sdk";
import { sql } from "./database";
import { ClientSession, Message } from "./types";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function handleAdventure(session: ClientSession, input: string) {
  if (!session.userId) {
    session.writeCommandOutput(
      "You need to be logged in to play the adventure game. Please use /login or /register first."
    );
    return;
  }

  if (!session.isInAdventure) {
    session.isInAdventure = true;
    session.adventureConversation = [];
    session.writeCommandOutput("\x1B[2J\x1B[H"); // Clear screen
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
    if (session.credits <= 0) {
      session.writeCommandOutput(
        "You've run out of credits. The adventure ends here."
      );
      session.isInAdventure = false;
      return;
    }

    session.credits--;
    if (session.userId) {
      await sql`UPDATE accounts SET credits = credits - 1 WHERE id = ${session.userId}`;
    }

    session.adventureConversation.push({
      role: "user",
      content: message,
    });

    const gamePrompt = readFileSync("game_prompt.txt", "utf-8");

    console.log(
      `Processing adventure turn for user ${session.username || session.id}`
    );
    let fullResponse = "";
    const messageStream = await anthropic.messages.stream({
      model: session.model,
      max_tokens: 1024,
      temperature: 0.8,
      messages: session.adventureConversation,
      system: gamePrompt,
    });

    session.writeToStream("\r\n", false);

    for await (const chunk of messageStream) {
      if (chunk.type === "content_block_delta") {
        const text = chunk.delta.text;
        fullResponse += text;
        // Remove color codes and other special characters
        const cleanText = text.replace(/\x1b\[[0-9;]*m/g, "");
        session.writeToStream(cleanText.replace(/\n/g, "\r\n"), false);
      }
    }

    session.adventureConversation.push({
      role: "assistant",
      content: fullResponse,
    });

    // Save game progress every 5 turns
    if (session.adventureConversation.length % 10 === 0) {
      await saveGameProgress(session);
    }

    session.writeToStream("\r\n", false);
    session.writeToStream("> ", false);
    console.log(
      `Adventure turn completed for user ${session.username || session.id}`
    );
  } catch (error) {
    console.error(
      `Error in handleAdventureMessage for user ${
        session.username || session.id
      }:`,
      error
    );
    session.writeCommandOutput(
      `\x1b[31mError: ${(error as Error).message}\x1b[0m`
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
