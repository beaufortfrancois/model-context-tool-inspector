/**
 * WebMCP polyfill page runtime bootstrap.
 *
 * Loaded in the page MAIN world at document_start. When the per-origin
 * polyfill flag is enabled, install a tiny synchronous modelContext stub so
 * page startup code can register tools immediately, then async-load
 * @mcp-b/global and replace the stub with the real BrowserMcpServer runtime.
 */

const INJECT_POLYFILL_STORAGE_KEY = '__webMcpPolyfill';
const DEFAULT_INPUT_SCHEMA = { type: 'object', properties: {} };
const MODULE_RERUN_MARKER = '__webmcpPolyfillModulesReplayed';

let shouldInstall = false;
try {
  shouldInstall = localStorage.getItem(INJECT_POLYFILL_STORAGE_KEY) === '1';
} catch {}

if (shouldInstall) {
  const existingOptions =
    window.__webModelContextOptions && typeof window.__webModelContextOptions === 'object'
      ? window.__webModelContextOptions
      : {};

  const options = {
    ...existingOptions,
    autoInitialize: false,
    installTestingShim: existingOptions.installTestingShim ?? 'if-missing',
    transport: {
      ...(existingOptions.transport && typeof existingOptions.transport === 'object'
        ? existingOptions.transport
        : {}),
      tabServer: {
        ...(existingOptions.transport?.tabServer && typeof existingOptions.transport.tabServer === 'object'
          ? existingOptions.transport.tabServer
          : {}),
        allowedOrigins: existingOptions.transport?.tabServer?.allowedOrigins ?? ['*'],
      },
    },
  };

  window.__webModelContextOptions = options;
  installModelContextStub();

  void import('@mcp-b/global')
    .then(({ initializeWebModelContext }) => {
      initializeWebModelContext(options);
      queueModuleScriptReplayIfNeeded();
    })
    .catch((error) => {
      console.error('[WebMCP Inspector] Failed to initialize WebMCP polyfill page runtime:', error);
    });
}

function installModelContextStub() {
  if (navigator.modelContext) {
    return;
  }

  const tools = new Map();
  const stub = {
    _registeredTools: tools,
    registerTool(tool) {
      if (!tool?.name || typeof tool.execute !== 'function') {
        throw new Error('registerTool() requires a named tool with an execute function.');
      }
      tools.set(tool.name, tool);
    },
    unregisterTool(nameOrTool) {
      const name = typeof nameOrTool === 'string' ? nameOrTool : nameOrTool?.name;
      if (name) {
        tools.delete(name);
      }
    },
    listTools() {
      return Array.from(tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? DEFAULT_INPUT_SCHEMA,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      }));
    },
    async callTool({ name, arguments: args }) {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return await tool.execute(args ?? {});
    },
    async executeTool(name, args) {
      return await this.callTool({ name, arguments: args });
    },
  };

  Object.defineProperty(navigator, 'modelContext', {
    configurable: true,
    enumerable: true,
    writable: false,
    value: stub,
  });
}

function queueModuleScriptReplayIfNeeded() {
  if (window[MODULE_RERUN_MARKER]) {
    return;
  }

  requestAnimationFrame(() => {
    const modelContext = navigator.modelContext;
    if (!modelContext || typeof modelContext.listTools !== 'function') {
      return;
    }
    if (modelContext.listTools().length > 0) {
      return;
    }

    const scripts = Array.from(document.querySelectorAll('script[type="module"][src]'));
    if (scripts.length === 0) {
      return;
    }

    window[MODULE_RERUN_MARKER] = true;
    void replayModuleScripts(scripts);
  });
}

async function replayModuleScripts(scripts) {
  for (const script of scripts) {
    const url = new URL(script.src, location.href);
    url.searchParams.set('__webmcp_rerun', '1');
    try {
      await import(url.href);
    } catch (error) {
      console.warn('[WebMCP Inspector] Failed to replay module script:', url.href, error);
    }
  }
}
