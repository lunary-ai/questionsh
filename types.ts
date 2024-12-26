import { Stream } from "ssh2";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface ClientSession {
  id: string;
  buffer: string;
  lastRequest: number;
  requestCount: number;
  conversation: Message[];
  startTime: number;
  model: string;
  systemPrompt: string;
  temperature: number;
  userId: string | null;
  username: string | null;
  credits: number;
  stream: Stream;
  currentCharacter: Character | null;
  isInAdventure: boolean;
  adventureConversation: Message[];
  clientIP: string;
  inputHandler: ((data: Buffer) => void) | null;
  cursorPos: number;
  clientPublicKey: string | null;

  writeToStream(message: string, addPrompt?: boolean): void;
  writeCommandOutput(message: string, addPrompt?: boolean): void;
  handleCommand(cmd: string): Promise<boolean>;
  handleMessage(message: string): Promise<void>;
  streamResponse(userMessage: string): Promise<void>;
}

export interface Room {
  id: string;
  name: string;
  members: Set<ClientSession>;
  addMember(session: ClientSession): void;
  removeMember(session: ClientSession): void;
  addMessage(
    content: string,
    userId: string | null,
    isSystemMessage?: boolean
  ): Promise<void>;
  broadcast(message: string, sender: ClientSession): Promise<void>;
  getRecentMessages(limit?: number): Promise<any[]>;
}

export interface Character {
  id: string;
  name: string;
  system_prompt: string;
}

export interface AutoLoginInfo {
  username: string;
  userId: string;
  credits: number;
}

export interface DatabaseMessage {
  content: string;
  created_at: Date;
  is_system_message: boolean;
  username: string | null;
}

export interface Account {
  id: string;
  username: string;
  credits: number;
  password_hash: string;
}
