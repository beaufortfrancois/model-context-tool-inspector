import { GoogleGenAI } from '@google/genai';
import { mcpAdapter, MCPTool } from './mcp-adapter';

export class ChatWidget {
  private container: HTMLElement;
  private messagesContainer: HTMLElement | null = null;
  private inputElement: HTMLInputElement | null = null;
  private genAI: any = null;
  private chat: any = null;
  private model: string = 'gemini-2.0-flash';
  private apiKey: string = '';

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container #${containerId} not found`);
    this.container = el;
    this.loadSettings();
    this.render();
    this.initAI();
  }

  private loadSettings() {
    // Priority: .env > localStorage
    this.apiKey = import.meta.env.VITE_GEMINI_API_KEY || localStorage.getItem('mcp_api_key') || '';
    this.model = localStorage.getItem('mcp_model') || 'gemini-2.0-flash';
  }

  private saveSettings() {
    localStorage.setItem('mcp_api_key', this.apiKey);
    localStorage.setItem('mcp_model', this.model);
  }

  private render() {
    this.container.innerHTML = `
      <div class="chat-widget">
        <header class="chat-header">
          <span>AI Assistant (Gemini 2.0 Flash)</span>
          <button id="settings-btn" style="background:none; border:none; color:white; cursor:pointer;">⚙️</button>
        </header>
        <div id="chat-messages" class="chat-messages">
          <div class="message ai">Hello! I'm your AI assistant. I can help you interact with the tools on this page.</div>
        </div>
        <div class="chat-input-area">
          <input type="text" id="chat-input" placeholder="Ask me anything..." />
          <button id="send-btn">Send</button>
        </div>
      </div>
    `;

    this.messagesContainer = document.getElementById('chat-messages');
    this.inputElement = document.getElementById('chat-input') as HTMLInputElement;

    document.getElementById('send-btn')?.addEventListener('click', () => this.handleSendMessage());
    this.inputElement?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleSendMessage();
    });

    document.getElementById('settings-btn')?.addEventListener('click', () => this.handleSettings());

    // Listen for tool changes on the page
    mcpAdapter.onToolsChanged(() => {
      console.log('[ChatWidget] Tools changed, updating AI config...');
      this.addMessage('system', 'Available tools updated.');
    });
  }

  private async initAI() {
    if (!this.apiKey) {
      this.addMessage('system', 'Please set your Gemini API key in settings.');
      return;
    }

    try {
      this.genAI = new GoogleGenAI({ apiKey: this.apiKey });
      this.resetChat();
    } catch (error) {
      this.addMessage('system', `Error initializing AI: ${error}`);
    }
  }

  private resetChat() {
    if (!this.genAI) return;
    
    let tools: MCPTool[] = [];
    try {
      tools = mcpAdapter.listTools();
    } catch (error) {
      console.warn('Could not list tools:', error);
    }

    const config = this.getChatConfig(tools);
    
    this.chat = this.genAI.chats.create({
      model: this.model,
      systemInstruction: config.systemInstruction,
      tools: config.tools
    });
  }

  private getChatConfig(tools: MCPTool[]) {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const systemInstruction = `You are an AI assistant embedded in a web page.
Today's date is: ${today}.
You can use the provided tools to interact with the page or perform actions.
Always use tools when the user asks for something that can be handled by a tool.
If you see a tool that can register or submit information, use it instead of just talking about it.`;

    const functionDeclarations = tools.map(tool => {
      let params = tool.inputSchema;
      if (typeof params === 'string') {
        try {
          params = JSON.parse(params);
        } catch (e) {
          params = { type: 'object', properties: {} };
        }
      }
      return {
        name: tool.name,
        description: tool.description,
        parameters: params || { type: 'object', properties: {} }
      };
    });

    return {
      systemInstruction,
      tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : []
    };
  }

  private addMessage(role: 'user' | 'ai' | 'system', text: string) {
    if (!this.messagesContainer) return;
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}`;
    msgEl.textContent = text;
    this.messagesContainer.appendChild(msgEl);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  private async handleSendMessage() {
    const text = this.inputElement?.value.trim();
    if (!text) return;
    if (this.inputElement) this.inputElement.value = '';

    this.addMessage('user', text);

    if (!this.chat) {
      if (!this.apiKey) {
        this.addMessage('system', 'Please set your API key first.');
        return;
      }
      await this.initAI();
    }

    try {
      await this.processAIChat(text);
    } catch (error: any) {
      console.error('Chat error:', error);
      this.addMessage('system', `Error: ${error.message || error}`);
    }
  }

  private async processAIChat(userMessage: any) {
    const tools = mcpAdapter.listTools();
    const config = this.getChatConfig(tools);
    
    // Pass config with tools and systemInstruction in every sendMessage call
    let currentResult = await this.chat.sendMessage({ 
      message: userMessage,
      config: config 
    });

    let isDone = false;
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    while (!isDone && iterations < MAX_ITERATIONS) {
      iterations++;
      const functionCalls = currentResult.functionCalls || [];

      if (functionCalls.length === 0) {
        if (currentResult.text) {
          this.addMessage('ai', currentResult.text);
        } else {
          console.warn('AI returned empty response');
        }
        isDone = true;
      } else {
        const toolResponses = [];
        for (const call of functionCalls) {
          this.addMessage('system', `[AI] Calling tool "${call.name}"...`);
          try {
            const result = await mcpAdapter.executeTool(call.name, call.args);
            const resultString = typeof result === 'string' ? result : JSON.stringify(result);
            this.addMessage('system', `[Tool] Result: ${resultString}`);
            
            toolResponses.push({
              functionResponse: {
                name: call.name,
                response: { result }
              }
            });
          } catch (error: any) {
            this.addMessage('system', `[Error] Tool "${call.name}": ${error.message}`);
            toolResponses.push({
              functionResponse: {
                name: call.name,
                response: { error: error.message }
              }
            });
          }
        }
        
        // Send tool results back to AI
        currentResult = await this.chat.sendMessage({ 
          message: toolResponses,
          config: config
        });
      }
    }
  }

  private handleSettings() {
    const key = prompt('Enter Gemini API Key:', this.apiKey);
    if (key !== null) {
      this.apiKey = key;
      this.saveSettings();
      this.initAI();
      this.addMessage('system', 'API Key updated.');
    }
  }
}
