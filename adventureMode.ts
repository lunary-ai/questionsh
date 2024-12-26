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

    const stream = await openai.chat.completions.create({
      model: ADVENTURE_MODEL,
      messages: [
        { role: "system", content: ADVENTURE_SYSTEM_PROMPT },
        ...session.adventureConversation.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        { role: "user", content: message },
      ],
      stream: true,
    });

    let fullResponse = "";

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      fullResponse += content;
      session.writeToStream(content, false);
    }

    session.writeToStream("\n");
    session.adventureConversation.push({ role: "user", content: message });
    session.adventureConversation.push({
      role: "assistant",
      content: fullResponse.trim(),
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
