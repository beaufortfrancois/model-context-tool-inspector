/**
 * Adapter for WebMCP (navigator.modelContext)
 */

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
}

export class MCPAdapter {
  private get modelContext(): any {
    const testing = (navigator as any).modelContextTesting;
    const standard = (navigator as any).modelContext;

    // Check which one actually has the required methods
    if (testing && typeof testing.listTools === 'function') {
      return testing;
    }
    if (standard && typeof standard.listTools === 'function') {
      return standard;
    }

    // Fallback/Debug: Log what's available
    console.debug('[WebMCP Adapter] navigator.modelContext:', standard);
    console.debug('[WebMCP Adapter] navigator.modelContextTesting:', testing);
    
    return standard || testing;
  }

  public isSupported(): boolean {
    return !!(this.modelContext && typeof this.modelContext.listTools === 'function');
  }

  public listTools(): MCPTool[] {
    if (!this.isSupported()) {
      console.warn('[WebMCP Adapter] listTools is not available on this browser.');
      return [];
    }
    try {
      return this.modelContext.listTools() || [];
    } catch (error) {
      console.error('[WebMCP Adapter] Failed to call listTools:', error);
      return [];
    }
  }

  public async executeTool(name: string, inputArgs: any): Promise<any> {
    if (!this.isSupported() || typeof this.modelContext.executeTool !== 'function') {
      throw new Error('WebMCP executeTool is not supported in this browser.');
    }
    
    // WebMCP might expect arguments as a JSON string
    const argsToSend = typeof inputArgs === 'string' ? inputArgs : JSON.stringify(inputArgs);
    
    console.debug(`[WebMCP Adapter] Executing tool "${name}" with:`, argsToSend);
    
    try {
      const result = await this.modelContext.executeTool(name, argsToSend);
      
      // Handle cross-document result if necessary
      if (result === null && typeof this.modelContext.getCrossDocumentScriptToolResult === 'function') {
        console.debug('[WebMCP Adapter] Tool returned null, checking for cross-document result...');
        return await this.modelContext.getCrossDocumentScriptToolResult();
      }
      
      return result;
    } catch (error) {
      console.error(`[WebMCP Adapter] Error executing tool "${name}":`, error);
      throw error;
    }
  }

  public onToolsChanged(callback: () => void): void {
    if (this.isSupported() && this.modelContext.registerToolsChangedCallback) {
      this.modelContext.registerToolsChangedCallback(callback);
    }
  }
}

export const mcpAdapter = new MCPAdapter();
