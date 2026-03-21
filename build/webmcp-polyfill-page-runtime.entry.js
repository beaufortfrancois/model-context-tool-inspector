/**
 * WebMCP polyfill page runtime bootstrap.
 *
 * Loaded in the page MAIN world at document_start. When the per-origin
 * polyfill flag is enabled, initialize the WebMCP polyfill runtime.
 */

const INJECT_POLYFILL_STORAGE_KEY = '__webMcpPolyfill';

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

  void import('@mcp-b/global')
    .then(({ initializeWebModelContext }) => {
      initializeWebModelContext(options);
    })
    .catch((error) => {
      console.error('[WebMCP Inspector] Failed to initialize WebMCP polyfill page runtime:', error);
    });
}
