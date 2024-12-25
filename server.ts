import SSH2 from "ssh2";
import { ClientSession } from "./clientSession";
import { loadHostKey, generateWelcomeMessage } from "./utils";
import { sql } from "./database";
import { AutoLoginInfo } from "./types";
import http from "http";

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
  let autoLoginUsername: string | null = null;
  const clientIP = client.remoteAddress;

  console.log("Client connection from:", clientIP);

  client.on("authentication", async (ctx) => {
    console.log("Authentication attempt:", {
      method: ctx.method,
      username: ctx.username,
      ip: clientIP,
    });

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
    console.log(`Client authenticated! (Session: ${sessionId})`, {
      ip: clientIP,
    });
    client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (accept) => accept());
      session.on("shell", (accept) => {
        const stream = accept();
        handleStream(stream, sessionId, autoLoginUsername, null, clientIP);
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
  autoLoginUsername: string | null,
  clientPublicKey: string | null,
  clientIP: string
) {
  console.log(`Stream opened for session ${sessionId}`);
  let autoLoginInfo: AutoLoginInfo | null = null;

  if (!autoLoginUsername) {
    if (!guestCredits.has(clientIP)) {
      guestCredits.set(clientIP, 10);
    }
    const credits = guestCredits.get(clientIP) || 0;
    autoLoginInfo = {
      username: "guest",
      userId: clientIP,
      credits,
    };
  } else if (autoLoginUsername) {
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

  const session = new ClientSession(sessionId, stream, autoLoginInfo, clientIP);
  sessions.set(sessionId, session);

  const welcomeMessage = generateWelcomeMessage(autoLoginInfo);
  session.writeCommandOutput(welcomeMessage);

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
}

export function createHttpServer() {
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>question.sh - Query LLMs from your terminal</title>
        <style>
          body {
            background: #000;
            color: #fff;
            font-family: monospace;
            white-space: pre-wrap;
            padding: 20px;
          }
        </style>
      </head>
      <body>
<div style="display: flex; flex-direction: column; align-items: center; justify-content: center;">
<pre>
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
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

Connect:

$ ssh question.sh</pre></div></body></html>
    `);
  });

  httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP server listening on port ${HTTP_PORT}`);
  });

  return httpServer;
}

export { sessions };
