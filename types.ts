export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface Character {
  id: string;
  name: string;
  system_prompt: string;
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
  currentRoom: Room | null;
  currentCharacter: Character | null;
  stream: any;

  writeToStream(message: string, addPrompt?: boolean): void;
  writeCommandOutput(message: string): void;
  handleCommand(cmd: string): Promise<boolean>;
  streamResponse(message: string): Promise<boolean>;
  handleMessage(message: string): Promise<void>;
}

export interface Room {
  id: string;
  name: string;
  members: Set<ClientSession>;
  addMember(session: ClientSession): void;
  removeMember(session: ClientSession): void;
  broadcast(message: string, sender: ClientSession): void;
}
