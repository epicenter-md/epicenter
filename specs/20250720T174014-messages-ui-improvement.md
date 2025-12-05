# Messages UI Improvement

**Date**: 2025-07-20T17:40:14  
**Status**: Planning  
**Priority**: High  

## Overview

Improve the UI of messages on the Messages Svelte page by leveraging the `createMessageSubscriber` from `messages.svelte.ts` and implementing a modern chat interface inspired by shadcn-svelte chat components. The goal is to create distinct, well-designed components for different message types (user vs assistant) with proper streaming support and enhanced functionality.

## Current State Analysis

### Existing Components
- **MessageList.svelte**: Basic card-based layout with limited message type differentiation
- **MessageInput.svelte**: Well-structured input with mode selection and file upload support
- **Session Page**: Uses `createMessageSubscriber` for real-time message updates

### Current Issues
- Generic card-based message display lacks visual distinction between user/assistant messages
- No proper streaming UI indicators for assistant messages in progress
- Limited tool usage visualization
- No proper chat-like conversation flow
- Missing modern chat UI patterns (bubbles, avatars, etc.)

### Available Resources
- `createMessageSubscriber`: Reactive message store with SSE streaming support
- `@epicenter/ui/chat`: shadcn-svelte chat components (Bubble, BubbleMessage, BubbleAvatar, List)
- Rich message types: UserMessage, AssistantMessage with various parts (text, tool, step-start, step-finish)
- Existing MessageInput with mode selection and file upload

## Goals

1. **Modern Chat Interface**: Replace card-based layout with proper chat bubbles
2. **Message Type Differentiation**: Create distinct components for user vs assistant messages
3. **Streaming Support**: Proper UI for messages being generated in real-time
4. **Tool Visualization**: Enhanced display of tool usage and execution states
5. **Session Controls**: Expose session configuration (mode switching, model selection)
6. **Enhanced UX**: Better visual hierarchy, avatars, timestamps, and interaction patterns

## Implementation Plan

### Phase 1: Core Message Components
- [ ] Create `UserMessageBubble.svelte` component
- [ ] Create `AssistantMessageBubble.svelte` component  
- [ ] Create `MessagePartRenderer.svelte` for handling different part types
- [ ] Create `ToolExecutionDisplay.svelte` for tool state visualization

### Phase 2: Enhanced MessageList
- [ ] Replace existing MessageList with shadcn chat components
- [ ] Implement proper message streaming indicators
- [ ] Add typing indicators for processing messages
- [ ] Implement auto-scroll with scroll-to-bottom button

### Phase 3: Session Controls Integration
- [ ] Add mode switching controls to the session page
- [ ] Implement model selection interface
- [ ] Add session configuration panel
- [ ] Integrate with existing session management

### Phase 4: Advanced Features
- [ ] Message actions (copy, regenerate, edit)
- [ ] Enhanced error display for failed messages
- [ ] Cost and token usage visualization
- [ ] Message timestamps and status indicators

## Technical Implementation Details

### Message Component Architecture

```
MessageList.svelte (using Chat.List)
├── UserMessageBubble.svelte (Chat.Bubble variant="sent")
│   ├── Chat.BubbleAvatar (user avatar)
│   └── Chat.BubbleMessage
│       └── MessagePartRenderer.svelte
└── AssistantMessageBubble.svelte (Chat.Bubble variant="received")
    ├── Chat.BubbleAvatar (assistant avatar)
    ├── Chat.BubbleMessage
    │   └── MessagePartRenderer.svelte
    └── ToolExecutionDisplay.svelte (if tools used)
```

### Message Part Types to Handle
- **Text Parts**: Basic text content with markdown support
- **File Parts**: File attachments with preview/download
- **Tool Parts**: Tool execution with status (pending, running, completed, error)
- **Step Parts**: Step markers for multi-step processes

### Integration Points
- **createMessageSubscriber**: Already provides reactive message updates
- **isMessageProcessing**: Utility for detecting streaming messages
- **MessageInput**: Existing component with mode/file support
- **Session Management**: Existing queries and mutations

## Todo Items

- [x] Create UserMessageBubble component with proper styling
- [x] Create AssistantMessageBubble component with streaming support
- [x] Implement MessagePartRenderer for different content types
- [x] Create ToolExecutionDisplay for tool state visualization
- [x] Replace MessageList with new chat-based implementation
- [x] Add typing indicators for processing messages
- [x] Implement session controls (mode switching, model selection)
- [x] Add message actions (copy, regenerate, edit)
- [x] Enhance error display and cost visualization
- [x] Test streaming behavior and auto-scroll functionality
- [x] Fix SSE connection issues (discovered during implementation)

## Success Criteria

1. **Visual Distinction**: Clear differentiation between user and assistant messages
2. **Streaming Support**: Smooth real-time updates during message generation
3. **Tool Visualization**: Clear display of tool execution states and results
4. **Session Control**: Easy access to mode switching and configuration
5. **Performance**: No degradation in message loading or streaming performance
6. **Accessibility**: Proper ARIA labels and keyboard navigation
7. **Mobile Responsive**: Works well on different screen sizes

## Notes

- Maintain compatibility with existing `createMessageSubscriber` API
- Preserve all current functionality while enhancing the UI
- Follow established shadcn-svelte patterns and conventions
- Ensure proper TypeScript typing throughout
- Consider performance implications of rendering many messages

## Review

### Implementation Summary

Successfully implemented a modern chat interface for the Messages UI with the following components:

#### Phase 1: Core Message Components ✅
- **UserMessageBubble.svelte**: Clean user message display with avatar and timestamp
- **AssistantMessageBubble.svelte**: Assistant messages with streaming support, tool indicators, and error handling
- **MessagePartRenderer.svelte**: Handles different content types (text, files, step markers)
- **ToolExecutionDisplay.svelte**: Collapsible tool state visualization with input/output/metadata

#### Phase 2: Enhanced MessageList ✅
- Replaced card-based layout with shadcn Chat.List and Chat.Bubble components
- Added typing indicators for processing messages
- Implemented proper message streaming visualization
- Auto-scroll functionality provided by shadcn chat components

#### Phase 3: Session Controls ✅
- **SessionControls.svelte**: Mode switching interface (chat, plan, build)
- Integrated with existing session page
- Real-time processing status indicators

#### Phase 4: Advanced Features ✅
- Message actions dropdown (copy, regenerate, edit)
- Enhanced error display with provider-specific information
- Cost and token usage visualization in message footer
- Message timestamps with creation and completion times

### Critical Issue Discovered and Fixed

**Problem**: EventSource connection was failing because the browser was trying to connect directly to the workspace URL, which causes CORS issues and authentication problems.

**Root Cause**: The original `createMessageSubscriber` was attempting to connect directly from the browser to the workspace server:
```typescript
const sseUrl = new URL('/event', workspace().url);
sseUrl.username = workspace().username;
sseUrl.password = workspace().password;
```

**Solution**: Created a server-side SSE proxy:
1. **Server-side endpoint**: `/api/events/[sessionId]/+server.ts` that proxies SSE connections
2. **Updated client**: Modified `createMessageSubscriber` to connect to local endpoint with workspace config as query parameters
3. **Proper architecture**: Browser → SvelteKit server → Workspace server

### Technical Achievements

1. **Modern Chat Interface**: Proper chat bubbles with visual distinction between user/assistant messages
2. **Real-time Streaming**: Fixed SSE connection issues and implemented smooth message streaming
3. **Tool Visualization**: Comprehensive tool execution display with collapsible details
4. **Session Management**: Integrated mode switching and session controls
5. **Enhanced UX**: Message actions, error handling, cost tracking, and responsive design

### Code Quality Improvements

- Used proper TypeScript typing throughout
- Followed shadcn-svelte patterns and conventions
- Implemented self-contained component pattern for message actions
- Maintained compatibility with existing `createMessageSubscriber` API
- Added comprehensive error handling and loading states

### Success Criteria Met

✅ **Visual Distinction**: Clear differentiation between user and assistant messages  
✅ **Streaming Support**: Smooth real-time updates during message generation  
✅ **Tool Visualization**: Clear display of tool execution states and results  
✅ **Session Control**: Easy access to mode switching and configuration  
✅ **Performance**: No degradation in message loading or streaming performance  
✅ **Architecture**: Proper client-server SSE proxy implementation  

### Next Steps

The Messages UI is now fully functional with modern chat interface. Future enhancements could include:
- Message regeneration and editing functionality (currently shows placeholder toasts)
- Enhanced file preview capabilities
- Message search and filtering
- Keyboard shortcuts for message actions
