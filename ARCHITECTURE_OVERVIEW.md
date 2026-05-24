# Claude DevTools — Architecture Overview

## What This App Does

**Claude DevTools** is a desktop application that visualizes Claude Code session execution. It reads Claude Code's log files from your local machine and presents them in a rich UI — letting you explore conversations, inspect tool calls, track token usage, and analyze subagent execution.

Think of it as "DevTools for Claude Code" — like Chrome DevTools is for web pages, but for AI coding sessions.

---

## High-Level Architecture

This is an **Electron + React + TypeScript** desktop app. Electron gives us a native desktop window with a full Node.js backend, while React provides the UI.

The app follows Electron's standard three-process architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                    RENDERER PROCESS                          │
│  (Chromium sandbox — React UI runs here)                   │
│                                                             │
│  • src/renderer/index.tsx  ← Entry point                     │
│  • src/renderer/App.tsx    ← Root component                  │
│  • Components, hooks, store (Zustand)                       │
│  • Cannot access filesystem, Node APIs, or OS directly       │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       │ IPC (Inter-Process Communication)
                       │ via contextBridge (secure)
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    PRELOAD SCRIPT                            │
│  (Tiny bridge — runs in a privileged context)                │
│                                                             │
│  • src/preload/index.ts  ← Entry point                       │
│  • Exposes a curated, typed API to the renderer             │
│  • Acts as a security firewall — only whitelisted           │
│    channels and methods are exposed                         │
│  • Renderer calls window.electronAPI.*                       │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       │ ipcMain / ipcRenderer
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    MAIN PROCESS                              │
│  (Node.js — full system access)                             │
│                                                             │
│  • src/main/index.ts  ← Entry point                         │
│  • Creates the BrowserWindow                                │
│  • Sets up IPC handlers (responds to renderer requests)       │
│  • Runs HTTP server (port 7777) for external access         │
│  • Watches Claude Code log files for changes                │
│  • Reads, parses, and analyzes session data                   │
│  • Manages projects, sessions, search, SSH, updates           │
└─────────────────────────────────────────────────────────────┘
```

---

## The Four Entry Points

### 1. `src/main/index.ts` — The Main Process (Backend)

**Lines:** ~640  
**Role:** The "server" of the app. This is the first code that runs when you launch Claude DevTools.

**What it does:**

| Responsibility | Details |
|---------------|---------|
| **App Lifecycle** | Creates the Electron `BrowserWindow`, handles app ready/quit events |
| **Window Management** | Sets window size, zoom factor, traffic light position (macOS), icon |
| **IPC Handlers** | Registers all `ipcMain.handle()` listeners — these respond when the UI asks for data |
| **HTTP Server** | Starts an Express-like HTTP server on port 7777 for external tools/browser access |
| **File Watching** | Watches Claude Code's log directories for new/changed sessions |
| **Service Registry** | Initializes `ServiceContextRegistry` — manages multiple project contexts |
| **SSH Support** | Can connect to remote machines via SSH to read their Claude Code sessions |
| **Auto-updater** | Checks for and downloads new versions |
| **Memory Management** | Dynamically sets V8 heap limit based on system RAM (50%, clamped 2–4 GB) |

**Key code patterns:**

```typescript
// App lifecycle
app.whenReady().then(() => {
  createWindow();
  initializeIpcHandlers();
  startHttpServer();
  startFileWatcher();
});

// IPC handler example (simplified)
ipcMain.handle('get-sessions', async (event, projectId) => {
  const context = contextRegistry.getContext(projectId);
  return context.sessionService.getSessions();
});

// File watcher → broadcasts to both renderer AND HTTP SSE clients
fileWatcher.on('file-change', (event) => {
  mainWindow?.webContents.send('file-change', event);  // to UI
  httpServer?.broadcast('file-change', event);           // to HTTP clients
});
```

**Why it matters:** This is where all the "heavy lifting" happens. The renderer can't read files or access the network directly — it has to ask the main process via IPC. The main process is also where the HTTP server lives, enabling external tools to query session data.

---

### 2. `src/preload/index.ts` — The Security Bridge

**Lines:** ~530  
**Role:** A tiny, carefully-controlled script that sits between the renderer and main process.

**What it does:**

| Responsibility | Details |
|---------------|---------|
| **Expose API** | Uses `contextBridge.exposeInMainWorld('electronAPI', {...})` to inject a safe API into the renderer's `window` object |
| **Channel Whitelist** | Only specific IPC channels are exposed — prevents arbitrary IPC calls |
| **Type Safety** | All exposed methods are fully typed via TypeScript interfaces |
| **Result Wrapping** | Wraps IPC results in a standard `{success, data, error}` shape |
| **Event Forwarding** | Forwards main-process events (file changes, notifications) to the renderer |

**Key code patterns:**

```typescript
// Expose a curated API to the renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Data fetching
  getProjects: () => ipcRenderer.invoke('get-projects'),
  getSessions: (projectId) => ipcRenderer.invoke('get-sessions', projectId),
  getSessionById: (id) => ipcRenderer.invoke('get-session-by-id', id),

  // Config management
  config: {
    get: () => invokeIpcWithResult('config:get'),
    update: (config) => invokeIpcWithResult('config:update', config),
    // ... many more
  },

  // Event listeners
  onFileChange: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('file-change', handler);
    return () => ipcRenderer.off('file-change', handler); // cleanup
  },

  // SSH
  ssh: {
    connect: (config) => ipcRenderer.invoke('ssh:connect', config),
    disconnect: () => ipcRenderer.invoke('ssh:disconnect'),
    onStatus: (callback) => { /* ... */ },
  },

  // Window controls
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
});
```

**Why it matters:** Electron's security model requires this. The renderer (Chromium) runs untrusted web content — we can't give it direct access to `ipcRenderer` or Node.js APIs. The preload script acts as a firewall: only the methods we explicitly expose are available, and they're all typed.

The renderer accesses this API as `window.electronAPI.*` (typed via the `ElectronAPI` interface).

---

### 3. `src/renderer/index.tsx` — The React Entry Point

**Role:** The first React code that runs. Mounts the React app into the DOM.

**What it does (typical pattern):**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

// Create root and render the app
const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<App />);
```

This file is usually small (~10–20 lines). Its job is simply to bootstrap React. The actual app logic lives in `App.tsx` and the component tree.

---

### 4. `src/renderer/App.tsx` — The Root Component

**Lines:** ~50  
**Role:** The top-level React component that orchestrates the entire UI.

**What it does:**

| Responsibility | Details |
|---------------|---------|
| **Theme Setup** | `useTheme()` hook initializes dark/light mode |
| **Splash Screen** | Fades out and removes the loading splash screen once React is ready |
| **Context System** | Initializes the project/context system (which Claude Code root to read from) |
| **SSH Listener** | Watches SSH connection status and refreshes available contexts |
| **Notification Listeners** | Sets up IPC event listeners for file changes, todo changes, memory changes |
| **Layout** | Renders the main `<TabbedLayout />` component |
| **Overlays** | Renders `<ContextSwitchOverlay />` and `<ConfirmDialog />` |
| **Error Boundary** | Wraps everything in an error boundary to catch crashes |

**Key code:**

```tsx
export const App = (): React.JSX.Element => {
  useTheme();  // Initialize dark/light mode

  // Remove splash screen when React is ready
  useEffect(() => {
    const splash = document.getElementById('splash');
    if (splash) {
      splash.style.opacity = '0';
      setTimeout(() => splash.remove(), 300);
    }
  }, []);

  // Initialize context system
  useEffect(() => {
    void useStore.getState().initializeContextSystem();
  }, []);

  // Listen for SSH status changes → refresh contexts
  useEffect(() => {
    if (!api.ssh?.onStatus) return;
    const cleanup = api.ssh.onStatus(() => {
      void useStore.getState().fetchAvailableContexts();
    });
    return cleanup;
  }, []);

  // Initialize IPC notification listeners
  useEffect(() => {
    const cleanup = initializeNotificationListeners();
    return cleanup;
  }, []);

  return (
    <ErrorBoundary>
      <ContextSwitchOverlay />
      <TabbedLayout />
      <ConfirmDialog />
    </ErrorBoundary>
  );
};
```

**Why it matters:** This is the "air traffic controller" of the UI. It sets up all the global listeners and state initialization that the rest of the app depends on. The actual page content is rendered by `<TabbedLayout />`, which switches between different views (session viewer, search, settings, etc.).

---

## How Data Flows

### Reading Session Data (Renderer → Main)

```
1. User opens app → React component mounts
   ↓
2. Component calls api.getSessions(projectId)
   ↓
3. api (renderer) calls window.electronAPI.getSessions(projectId)
   ↓
4. preload script forwards to ipcRenderer.invoke('get-sessions', projectId)
   ↓
5. ipcMain.handle('get-sessions') in main process receives the request
   ↓
6. Main process reads from SessionService → reads log files from disk
   ↓
7. Data flows back: main → preload → renderer → React state → UI renders
```

### Live Updates (Main → Renderer)

```
1. Claude Code writes a new log file
   ↓
2. FileWatcher (main process) detects the change
   ↓
3. Main process broadcasts: mainWindow.webContents.send('file-change', event)
   ↓
4. Preload script receives via ipcRenderer.on('file-change')
   ↓
5. Preload forwards to renderer callback
   ↓
6. React component receives event → updates state → UI re-renders
```

### HTTP API (External → Main)

```
1. External tool/browser makes HTTP request to localhost:7777
   ↓
2. HttpServer (Express-like) receives the request
   ↓
3. Route handler calls the same SessionService/ProjectService as IPC
   ↓
4. JSON response returned
   ↓
5. For live updates: SSE (Server-Sent Events) streams file-change events
```

---

## Build Configuration (`electron.vite.config.ts`)

This config tells **electron-vite** how to build the three bundles:

| Target | Entry | Output | Format | Notes |
|--------|-------|--------|--------|-------|
| **Main** | `src/main/index.ts` | `dist-electron/main/index.cjs` | CommonJS | Node.js backend |
| **Preload** | `src/preload/index.ts` | `dist-electron/preload/index.js` | CommonJS | Security bridge |
| **Renderer** | `src/renderer/index.html` | `out/renderer/` | ESM | React UI bundle |

**Key features:**
- **Path aliases:** `@main`, `@preload`, `@renderer`, `@shared` resolve to their respective `src/` directories
- **Dependency bundling:** All `dependencies` from `package.json` are bundled into the main process (avoids pnpm symlink issues with electron-builder)
- **Native module stubbing:** `.node` addons (like ssh2's optional native bindings) are replaced with empty stubs — the libraries have pure-JS fallbacks

---

## Key Services (Main Process)

The main process organizes functionality into services:

| Service | Purpose |
|---------|---------|
| **SessionService** | Reads, parses, and caches Claude Code session files |
| **ProjectService** | Manages project list, root folders, configuration |
| **SearchService** | Full-text search across sessions |
| **FileWatcher** | Watches log directories for changes |
| **ChunkBuilder** | Breaks sessions into display chunks |
| **SemanticStepExtractor** | Identifies logical steps in conversations |
| **SubagentDetailBuilder** | Tracks subagent execution details |
| **ToolExecutionBuilder** | Analyzes tool call patterns |
| **HttpServer** | Serves HTTP API + SSE for external access |
| **SshConnectionManager** | Connects to remote machines for remote sessions |
| **NotificationManager** | Desktop notifications for events |
| **UpdaterService** | Auto-update checks and downloads |

---

## State Management (Renderer)

The renderer uses **Zustand** (a lightweight state manager) with the store in `src/renderer/store/`. Key state slices:

| Slice | Manages |
|-------|---------|
| **Context** | Active project, available contexts, SSH connections |
| **Sessions** | Session list, selected session, pagination |
| **Search** | Search query, filters, results |
| **UI** | Theme, sidebar state, dialog visibility |
| **Notifications** | Toast notifications, file change events |

---

## Summary: Where to Look for What

| If you want to... | Look in... |
|-------------------|------------|
| **Add a new IPC command** | `src/main/ipc/handlers.ts` + `src/preload/index.ts` + `src/shared/types` |
| **Add a new HTTP endpoint** | `src/main/http/*.ts` |
| **Change how sessions are parsed** | `src/main/services/session/` + `src/main/services/analysis/` |
| **Add a UI component** | `src/renderer/components/` |
| **Change the layout** | `src/renderer/components/layout/TabbedLayout.tsx` |
| **Add a new page/view** | `src/renderer/pages/` + update `TabbedLayout` |
| **Change state management** | `src/renderer/store/` |
| **Change styling** | `src/renderer/styles/` + `tailwind.config.js` |
| **Add a build step** | `electron.vite.config.ts` |
| **Add tests** | `test/` (mirrors `src/` structure) |

---

## Quick Start for Development

```bash
# Install dependencies (uses pnpm)
pnpm install

# Run in development mode (starts Electron with hot reload)
pnpm dev

# Type check
pnpm typecheck

# Lint
pnpm lint

# Build for production
pnpm build

# Package for distribution
pnpm dist
```

The dev server runs the renderer on a Vite dev server (hot reload) and the main process via Electron, with IPC communication wired between them.
