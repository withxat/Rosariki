export interface SlackUser {
  id: string;
  displayName: string;
  username?: string;
  isBot: boolean;
}

export interface SlackMessage {
  messageId: string;
  chatId: string;
  sender?: SlackUser;
  date: number;
  text: string;
  replyToMessageId?: string;
  receivedAtMs?: number;
  utcOffsetMin?: number;
}

export interface SlackMessageEdit {
  messageId: string;
  chatId: string;
  sender?: SlackUser;
  date: number;
  editDate: number;
  text: string;
  receivedAtMs?: number;
  utcOffsetMin?: number;
}

export interface SlackMessageDelete {
  messageIds: string[];
  chatId: string;
  receivedAtMs?: number;
  utcOffsetMin?: number;
}

export interface SlackSentMessage {
  messageId: string;
  date: number;
  text: string;
}
