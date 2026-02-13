# Model Context Tool Inspector

A Chrome Extension that allows developers to inspect, monitor, and execute tools exposed via the experimental `navigator.modelContextTesting` Web API.

## Prerequisites

**Important:** This extension relies on the experimental `navigator.modelContextTesting` Web API. You must enable the "WebMCP for testing" flag in `chrome://flags` to turn it on in Chrome 146.0.7672.0 or higher.

## Installation

You can install this extension either directly from the Chrome Web Store or manually from the source code.

### Option 1: Chrome Web Store (recommended)

Install the extension directly via the [Chrome Web Store](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd).

### Option 2: Install from source

1.  **Download the Source:**
    Clone this repository or download the source files into a directory.

2.  **Install dependencies:**
    In the directory, run `npm install`.

3.  **Open Chrome Extensions:**
    Navigate to `chrome://extensions/` in your browser address bar.

4.  **Enable Developer Mode:**
    Toggle the **Developer mode** switch in the top right corner of the Extensions page.

5.  **Load Unpacked:**
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

5.  **Interact with AI Models:**
    
    The extension supports two AI providers:
    
    **Option A: Google Gemini (Cloud-based)**
    * **Select Provider:** Choose "Google Gemini" from the AI Provider dropdown.
    * **Set API Key:** Click **Set Gemini API key** to configure your Google AI API key.
    * **Select Model:** The model dropdown will automatically populate with available models from the Gemini API that support content generation. If the API call fails, it falls back to a default list of models.
    * **Send Prompts:** Enter a prompt and click **Send** to interact with the selected model using the available tools on the page.
    
    **Option B: Local Ollama (Privacy-focused)**
    * **Install Ollama:** Download and install [Ollama](https://ollama.com/) on your local machine.
    * **Start Ollama:** Run `ollama serve` or ensure the Ollama service is running.
    * **Pull a Model:** Download a model (e.g., `ollama pull llama2` or `ollama pull mistral`).
    * **Select Provider:** Choose "Local Ollama" from the AI Provider dropdown in the extension.
    * **Configure URL:** Enter your Ollama URL (default: `http://localhost:11434`) and click **Save Ollama Settings**.
    * **Select Model:** Choose from your locally installed Ollama models in the model dropdown.
    * **Send Prompts:** Enter a prompt and click **Send** to interact with the selected model using the available tools on the page.

## Features

* **Multiple AI Providers:** Choose between Google Gemini (cloud-based) or Local Ollama (privacy-focused) for AI interactions.
* **Dynamic Model Loading:** The extension automatically fetches and displays available models from your selected AI provider.
* **Tool Inspection:** View all Model Context tools available on the current page.
* **Tool Execution:** Manually execute tools with custom arguments.
* **AI Integration:** Use AI models to interact with page tools through natural language prompts.

## Disclaimer

This is not an officially supported Google product. This project is not
eligible for the [Google Open Source Software Vulnerability Rewards
Program](https://bughunters.google.com/open-source-security).
