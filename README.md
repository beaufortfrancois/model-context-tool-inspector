# WebMCP - Model Context Tool Inspector

A Chrome Extension that allows developers to inspect, monitor, and execute WebMCP tools manually or with Gemini via a local backend server interface.

## Prerequisites

**Important:**  You must enable the "WebMCP for testing" flag in `chrome://flags` to turn it on in Chrome 150.0.7861.0 or higher.

## Installation

1.  **Download the Source:**
    Clone this repository or download the source files into a directory.

2.  **Install dependencies:**
    In the directory, run `npm install`.

3.  **Configure `.env.json`**
    Create a `.env.json` file in the root directory with your Gemini API Key:
    ```json
    {
      "apiKey": "YOUR_GEMINI_API_KEY",
      "model": "gemini-3.6-flash",
      "serverUrl": "http://localhost:3000"
    }
    ```
    *Note: `model` (defaults to `gemini-3.6-flash`) and `serverUrl` (defaults to `http://localhost:3000`) are optional.*

4.  **Start the Local Backend Server**
    Start the local backend server interface that handles communication with the Gemini API:
    ```bash
    npm run start:server
    ```
    *The server runs locally at `http://localhost:3000`.*

5.  **Open Chrome Extensions:**
    Navigate to `chrome://extensions/` in your browser address bar.

6.  **Enable Developer Mode:**
    Toggle the **Developer mode** switch in the top right corner of the Extensions page.

7.  **Load Unpacked:**
    Click the **Load unpacked** button that appears in the top left. Select the directory containing `manifest.json` (the folder where you saved the files).

## Usage

1.  **Navigate to a Page:**
    Open a web page that exposes Model Context tools.

2.  **Open the Inspector:**
    Click the extension's action icon (the puzzle piece or pinned icon) in the Chrome toolbar. This will open the **Side Panel**.

3.  **Inspect Tools:**
    * The extension will inject a content script to query the page.
    * A table will appear listing all available tools found on the page.

4.  **Execute a Tool:**
    * **Tool:** Select the desired tool from the dropdown menu.
    * **Input Arguments:** Enter the arguments for the tool in the text area.
        * *Note:* The input must be valid JSON (e.g., `{"text": "hello world"}`).
    * Click **Execute Tool**.

5.  **Interact with Gemini:**
    * Enter a prompt in the **User Prompt** field and click **Send**.
    * The extension communicates with the local backend server (`http://localhost:3000`), which interacts with Gemini to execute tools and return responses.

## Disclaimer

This is not an officially supported Google product. This project is not
eligible for the [Google Open Source Software Vulnerability Rewards
Program](https://bughunters.google.com/open-source-security).
