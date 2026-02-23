# WebMCP Embedded Agent Widget

This project is a web-based AI chat widget that uses WebMCP (`navigator.modelContext`) to discover and execute tools on the host page.

## Features
- **Two-pane layout**: Host page demo on the left, AI Chat widget on the right.
- **WebMCP Integration**: Automatically detects tools registered on the page.
- **AI Tool Calling**: Uses Gemini AI to interact with discovered tools.

## Tech Stack
- TypeScript
- Vite
- @google/genai

## Getting Started

1.  **Install dependencies:**
    ```bash
    npm install
    ```

2.  **Run development server:**
    ```bash
    npm run dev
    ```

3.  **Open in Browser:**
    Navigate to `http://localhost:3000`.

4.  **Configure API Key:**
    Click the settings icon (⚙️) in the chat widget and enter your Gemini API Key.

## Prerequisites
- **Chrome with WebMCP enabled**: Enable the "WebMCP for testing" flag in `chrome://flags` (Chrome 146+).
