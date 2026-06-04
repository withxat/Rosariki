export type {
  CanonicalAttachment,
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalIMEvent,
  CanonicalForwardInfo,
  CanonicalMessageEvent,
  CanonicalServiceEvent,
  CanonicalUser,
  ContentNode,
  ServiceAction,
} from './types';

export const contentToPlainText = (nodes: import('./types').ContentNode[]): string =>
  nodes.map(node => 'children' in node ? contentToPlainText(node.children) : node.text).join('');

export const captureUtcOffset = (): number => -new Date().getTimezoneOffset();
