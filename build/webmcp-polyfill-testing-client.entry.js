/**
 * WebMCP polyfill testing client for the content script world.
 *
 * Provides a navigator.modelContextTesting-compatible adapter that speaks MCP
 * over TabClientTransport (postMessage) to the page-world BrowserMcpServer.
 */

import { TabClientTransport } from '@mcp-b/transports';
import { Client, NoOpJsonSchemaValidator } from '@mcp-b/webmcp-ts-sdk';

const BRIDGE_KEY = '__webMcpPolyfillTestingBridge';
const INSTALLED_MARKER = '__webMcpPolyfillTestingInstalled';
const INJECT_POLYFILL_STORAGE_KEY = '__webMcpPolyfill';
const DEFAULT_INPUT_SCHEMA = '{"type":"object","properties":{}}';
const CLIENT_INFO = {
  name: 'model-context-tool-inspector',
  version: '1.8.0',
};

class WebMcpPolyfillTestingAdapter {
  constructor() {
    this._tools = [];
    this._toolChangeCallbacks = new Set();

    this.client = new Client(CLIENT_INFO, {
      jsonSchemaValidator: new NoOpJsonSchemaValidator(),
      listChanged: {
        tools: {
          autoRefresh: true,
          onChanged: (error, tools) => {
            if (error) {
              console.warn('[WebMcpPolyfillTestingAdapter] tools/list refresh failed:', error);
              return;
            }
            this._setTools(tools);
            this._dispatchToolChange();
          },
        },
      },
    });

    this.transport = new TabClientTransport({
      targetOrigin: location.origin,
    });
  }

  async initialize() {
    await this.client.connect(this.transport);
    const result = await this.client.listTools();
    this._setTools(result?.tools);
  }

  listTools() {
    return this._tools;
  }

  async executeTool(toolName, inputArgsJson) {
    let args;
    try {
      args = JSON.parse(inputArgsJson);
    } catch {
      throw new DOMException('Failed to parse input arguments', 'UnknownError');
    }

    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new DOMException('Input arguments must be a JSON object', 'UnknownError');
    }

    const result = await this.client.callTool({
      name: toolName,
      arguments: args,
    });

    if (result?.isError) {
      throw new DOMException(this._extractErrorText(result), 'UnknownError');
    }

    if (result?.metadata && typeof result.metadata === 'object' && result.metadata.willNavigate) {
      return null;
    }

    return JSON.stringify(result);
  }

  getCrossDocumentScriptToolResult() {
    // noop
    return Promise.resolve('[]');
  }

  registerToolsChangedCallback(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError("parameter 1 is not of type 'Function'");
    }
    this._toolChangeCallbacks.add(cb);
  }

  async close() {
    await this.client.close();
  }

  _setTools(tools) {
    this._tools = Array.isArray(tools)
      ? tools.map((tool) => ({
          name: tool?.name ?? '',
          description: tool?.description ?? '',
          inputSchema: tool?.inputSchema ? JSON.stringify(tool.inputSchema) : DEFAULT_INPUT_SCHEMA,
        }))
      : [];
  }

  _dispatchToolChange() {
    for (const cb of this._toolChangeCallbacks) {
      cb();
    }
  }

  _extractErrorText(result) {
    if (Array.isArray(result?.content)) {
      for (const block of result.content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          return block.text.replace(/^Error:\s*/i, '').trim();
        }
      }
    }
    return 'Tool execution failed';
  }
}

let _adapter = null;
let _installPromise = null;
let _enabled = false;
const _settingsReady = initializeSettings();

async function install() {
  if (_adapter) {
    return _adapter;
  }

  if (_installPromise) {
    return _installPromise;
  }

  _installPromise = (async () => {
    const adapter = new WebMcpPolyfillTestingAdapter();
    await adapter.initialize();

    Object.defineProperty(navigator, 'modelContextTesting', {
      configurable: true,
      enumerable: true,
      writable: false,
      value: Object.assign(adapter, { [INSTALLED_MARKER]: true }),
    });

    _adapter = adapter;
    return adapter;
  })().finally(() => {
    _installPromise = null;
  });

  return _installPromise;
}

async function ensureTesting() {
  await _settingsReady;
  if (_enabled) {
    await install();
    if (_adapter) {
      return navigator.modelContextTesting;
    }
    throw new Error('WebMCP polyfill runtime injected but no testing surface became available.');
  }

  if (navigator.modelContextTesting) {
    return navigator.modelContextTesting;
  }

  throw new Error('Enable native WebMCP testing or turn on the WebMCP polyfill option.');
}

function cleanup() {
  const adapter = _adapter;
  _adapter = null;
  _installPromise = null;

  if (adapter) {
    void adapter.close();
  }

  try {
    delete navigator.modelContextTesting;
  } catch {}
}

async function initializeSettings() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }

  try {
    const stored = await chrome.storage.local.get({ injectWebMcpPolyfill: false });
    setEnabled(stored.injectWebMcpPolyfill === true);
    if (_enabled) {
      await install();
    }
  } catch {}
}

function setEnabled(enabled) {
  _enabled = enabled;
  try {
    if (enabled) {
      localStorage.setItem(INJECT_POLYFILL_STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(INJECT_POLYFILL_STORAGE_KEY);
    }
  } catch {}

  if (!enabled) {
    cleanup();
  }
}

function hasNativeTestingApi() {
  return Boolean(
    navigator.modelContextTesting &&
    navigator.modelContextTesting.listTools &&
    !(navigator.modelContextTesting && navigator.modelContextTesting[INSTALLED_MARKER])
  );
}

window[BRIDGE_KEY] = { install, ensureTesting, cleanup, setEnabled, hasNativeTestingApi };
