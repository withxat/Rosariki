export interface SlackUser {
  id: string;
  displayName: string;
  username?: string;
  isBot: boolean;
}

export interface SlackFileAttachment {
  id: string;
  name?: string;
  title?: string;
  mimeType?: string;
  fileType?: string;
  urlPrivate?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  thumbnailWebp?: string;
}

export interface SlackMessage {
  messageId: string;
  chatId: string;
  sender?: SlackUser;
  date: number;
  text: string;
  files?: SlackFileAttachment[];
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
  files?: SlackFileAttachment[];
  receivedAtMs?: number;
  utcOffsetMin?: number;
}

export interface SlackMessageDelete {
  messageIds: string[];
  chatId: string;
  receivedAtMs?: number;
  utcOffsetMin?: number;
}

export interface SlackReactionEvent {
  messageId: string;
  chatId: string;
  sender?: SlackUser;
  reaction: string;
  operation: 'added' | 'removed';
  receivedAtMs?: number;
  utcOffsetMin?: number;
}

export interface SlackSentMessage {
  messageId: string;
  date: number;
  text: string;
}

export interface SlackThreadReply {
  messageId: string;
  sender?: SlackUser;
  text: string;
  date: number;
}
