/**
 * Simulates a host page that registers tools via WebMCP
 */

export function setupDemoForm() {
  const form = document.getElementById('demo-form') as HTMLFormElement;
  const submittedDataList = document.getElementById('registered-tools-list');
  const registerBtn = document.getElementById('register-mcp-tools-btn');
  const mcpToolsListEl = document.getElementById('mcp-tools-list');

  if (!form || !submittedDataList || !registerBtn || !mcpToolsListEl) return;

  const addSubmittedData = (userData: any) => {
    const li = document.createElement('li');
    li.textContent = `Submitted: ${userData.username} (${userData.email})`;
    submittedDataList.appendChild(li);
  };

  const registerUserToolHandler = (userData: any) => {
    console.log('[Demo Page] Tool execution - Registering user:', userData);
    addSubmittedData(userData);
    return `Successfully registered user ${userData.username} via AI tool call.`;
  };

  registerBtn.addEventListener('click', () => {
    const mc = (navigator as any).modelContext || (navigator as any).modelContextTesting;
    
    if (mc && mc.registerTool) {
      try {
        const toolName = 'register_user';
        mc.registerTool({
          name: toolName,
          description: 'Registers a new user with username and email into the system',
          inputSchema: {
            type: 'object',
            properties: {
              username: { type: 'string', description: 'The name of the user' },
              email: { type: 'string', description: 'The email address' }
            },
            required: ['username', 'email']
          },
          execute: registerUserToolHandler
        });

        // UI Update: Show registered tool name
        const li = document.createElement('li');
        li.textContent = `🛠️ ${toolName}`;
        mcpToolsListEl.appendChild(li);

        console.log(`[Demo Page] Tool "${toolName}" registered successfully`);
        
        // Note: The chat widget will detect this via mcpAdapter.onToolsChanged
      } catch (e) {
        console.warn('[Demo Page] Could not register tool via WebMCP:', e);
      }
    } else {
      alert('WebMCP API not found. Please check your browser flags.');
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const formData = new FormData(form);
    const userData = {
      username: formData.get('username'),
      email: formData.get('email')
    };
    addSubmittedData(userData);
    form.reset();
  });
}
