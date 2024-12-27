import SSH2 from "ssh2";
import { ClientSession } from "./clientSession";
import { loadHostKey, generateWelcomeMessage } from "./utils";
import { sql } from "./database";
import { AutoLoginInfo } from "./types";
import http from "http";
import { openai } from "./index";
import bcrypt from "bcrypt";
import {
  handleAdventure,
  handleAdventureMessage,
  handleGameEndChoice,
} from "./adventureMode";

const HOST_KEY_PATH = "./host.key";
const PORT = Number(process.env.PORT ?? 2222);
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 3000);

let sessionCounter = 0;
const sessions = new Map<string, ClientSession>();
export const guestCredits = new Map<string, number>();

export function createServer() {
  console.log("Initializing server on port", PORT);

  const server = new SSH2.Server(
    {
      hostKeys: [loadHostKey(HOST_KEY_PATH)],
      bind: {
        port: PORT,
        host: "0.0.0.0",
        family: 4, // Force IPv4
      },
    },
    handleClientConnection
  );

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

  server.listen(PORT, "0.0.0.0");

  return server;
}

async function handleClientConnection(client: SSH2.Connection) {
  console.log("Client connected");
  const sessionId = `session_${++sessionCounter}`;
  const clientIP = client.remoteAddress;

  console.log("Client connection from:", clientIP);

  client.on("authentication", async (ctx) => {
    console.log("Authentication attempt:", {
      method: ctx.method,
      username: ctx.username,
      passwordGiven: ctx.password ? "[hidden]" : "(none)",
      ip: clientIP,
    });

    // Accept all connections as anonymous initially
    return ctx.accept();
  });

  client.on("ready", () => {
    console.log(`Client authenticated! (Session: ${sessionId})`, {
      ip: clientIP,
    });
    client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (accept) => accept());
      session.on("shell", (accept) => {
        const stream = accept();
        handleStream(stream, sessionId, null, clientIP);
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

async function handleStream(
  stream: SSH2.ServerChannel,
  sessionId: string,
  _unused: null,
  clientIP: string
) {
  console.log(`Stream opened for session ${sessionId}`);
  let autoLoginInfo: AutoLoginInfo | null = null;

  // Set up anonymous user with guest credits
  if (!guestCredits.has(clientIP)) {
    guestCredits.set(clientIP, 0.1);
  }
  const credits = guestCredits.get(clientIP) || 0.1;
  autoLoginInfo = {
    username: "guest",
    userId: clientIP,
    credits,
  };

  const session = new ClientSession(sessionId, stream, autoLoginInfo, clientIP);
  sessions.set(sessionId, session);

  const welcomeMessage = generateWelcomeMessage(autoLoginInfo);
  session.writeCommandOutput(welcomeMessage);

  stream.on("data", async (data) => {
    // Check if there's a custom input handler (for auth etc)
    if (session.inputHandler) {
      session.inputHandler(data);
      return;
    }

    const input = data.toString();

    // Handle special key sequences
    if (input.startsWith("\x1b")) {
      // ESC sequence
      if (input === "\x1b[A") {
        // Up arrow
        return;
      }
      if (input === "\x1b[B") {
        // Down arrow
        return;
      }
      if (input === "\x1b[C") {
        // Right arrow
        // Only move right if we're not at the end of the buffer
        if (session.cursorPos < session.buffer.length) {
          session.cursorPos++;
          stream.write("\x1b[C");
        }
        return;
      }
      if (input === "\x1b[D") {
        // Left arrow
        // Only move left if we're not at the start
        if (session.cursorPos > 0) {
          session.cursorPos--;
          stream.write("\x1b[D");
        }
        return;
      }
      return; // Ignore other escape sequences
    }

    // Handle backspace
    if (input === "\x7f") {
      if (session.cursorPos > 0) {
        // Remove character at cursor position
        session.buffer =
          session.buffer.slice(0, session.cursorPos - 1) +
          session.buffer.slice(session.cursorPos);
        session.cursorPos--;

        // Move cursor back
        stream.write("\b");

        // Rewrite the rest of the line
        stream.write(session.buffer.slice(session.cursorPos) + " ");

        // Move cursor back to position
        stream.write(
          "\x1b[" + (session.buffer.length - session.cursorPos + 1) + "D"
        );
      }
      return;
    }

    // Handle enter key
    if (input === "\r") {
      stream.write("\n");
      const trimmedBuffer = session.buffer.trim();

      // Add this block to handle game end choices
      if (session.gameEndChoice) {
        try {
          await handleGameEndChoice(session, trimmedBuffer);
          session.buffer = "";
          session.cursorPos = 0;
          return;
        } catch (error) {
          console.error("Error in game end choice:", error);
          session.writeCommandOutput("An error occurred. Please try again.");
          return;
        }
      }

      if (trimmedBuffer.toLowerCase() === "exit") {
        stream.write("Goodbye! 👋\r\n");
        sessions.delete(sessionId);
        stream.end();
        return;
      }
      if (trimmedBuffer) {
        await session.handleMessage(trimmedBuffer);
      } else {
        session.writeToStream("", true);
      }
      session.buffer = "";
      session.cursorPos = 0;
      return;
    }

    // Regular character input
    if (input.length === 1 && input.charCodeAt(0) >= 32) {
      // Insert character at cursor position
      session.buffer =
        session.buffer.slice(0, session.cursorPos) +
        input +
        session.buffer.slice(session.cursorPos);
      session.cursorPos++;

      // Write the new character and the rest of the line
      stream.write(session.buffer.slice(session.cursorPos - 1));

      // Move cursor back to position
      if (session.cursorPos < session.buffer.length) {
        stream.write(
          "\x1b[" + (session.buffer.length - session.cursorPos) + "D"
        );
      }
    }
  });

  stream.on("error", (err) => {
    console.error(`Stream error for session ${sessionId}:`, err);
    sessions.delete(sessionId);
  });

  stream.on("close", () => {
    console.log(`Stream closed for session ${sessionId}`);
    sessions.delete(sessionId);
  });
}

export function createHttpServer() {
  const httpServer = http.createServer((req, res) => {
    const activeConnections = sessions.size;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>question.sh</title>
        <meta name="description" content="Query LLMs from your terminal">
        <style>
          body {
            background: #000;
            color: #fff;
            font-family: monospace;
            white-space: pre-wrap;
            padding: 20px;
          }
          .stats {
            text-align:left;
            margin-right: auto;
            color: #0f0;
            margin-top: 20px;
          }
        </style>
      </head>
      <body><div style="display: flex; flex-direction: column; align-items: center; justify-content: center;"><pre>::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::                                                          ::
::                                                          ::
::                          _   _                   _       ::
::     __ _ _   _  ___  ___| |_(_) ___  _ __    ___| |__    ::
::    / _\` | | | |/ _ \\/ __| __| |/ _ \\| '_ \\  / __| '_ \\   ::
::   | (_| | |_| |  __/\\__ \\ |_| | (_) | | | |_\\__ \\ | | |  ::
::    \\__, |\\__,_|\\___||___/\\__|_|\\___/|_| |_(_)___/_| |_|  ::
::       |_|                                                ::
::                                                          ::
::                                                          ::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::

Query LLMs from your terminal.

<p class="stats">Open sessions: ${activeConnections}</p>

Connect:

> ssh question.sh</pre>
</div></body></html>`);
  });

  httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP server listening on port ${HTTP_PORT}`);
  });

  return httpServer;
}

export { sessions };
