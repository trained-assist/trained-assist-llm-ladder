// Safe library entry point: importing this module starts no proxy/server and uses no Node API.
export { createContextSnapshot, contextLabel, contextPointer } from './context-snapshot.js';
export { selectHistoryContext, messageText } from './history-context.js';
export { compressRequest, READ_CONTEXT_TOOL } from './compress-request.js';
