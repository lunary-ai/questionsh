import { v4 as uuidv4 } from "uuid";
import { Room as IRoom, ClientSession, DatabaseMessage } from "./types";
import { sql, getRecentMessages } from "./database";

export class Room implements IRoom {
  id: string;
  name: string;
  members: Set<ClientSession>;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
    this.members = new Set();
    console.log(`Room created: ${name} (${id})`);
  }

  addMember(session: ClientSession) {
    this.members.add(session);
    console.log(
      `User ${session.username || session.id} joined room ${this.name}`
    );
  }

  removeMember(session: ClientSession) {
    this.members.delete(session);
    console.log(
      `User ${session.username || session.id} left room ${this.name}`
    );
  }

  async addMessage(
    content: string,
    userId: string | null,
    isSystemMessage: boolean = false
  ) {
    try {
      await sql`
        INSERT INTO messages (id, room_id, user_id, content, is_system_message)
        VALUES (${uuidv4()}, ${
        this.id
      }, ${userId}, ${content}, ${isSystemMessage})
      `;
      console.log(
        `Message added to room ${this.name}: ${content.substring(0, 50)}${
          content.length > 50 ? "..." : ""
        }`
      );
    } catch (error) {
      console.error(`Failed to add message to room ${this.name}:`, error);
    }
  }

  async broadcast(message: string, sender: ClientSession) {
    await this.addMessage(message, sender.userId);
    this.members.forEach((member) => {
      if (member !== sender) {
        member.writeToStream(
          `\r\n[${this.name}] ${sender.username || sender.id}: ${message}\r\n> `
        );
      }
    });
  }

  async getRecentMessages(limit: number = 20): Promise<DatabaseMessage[]> {
    return getRecentMessages(this.id, limit);
  }
}
