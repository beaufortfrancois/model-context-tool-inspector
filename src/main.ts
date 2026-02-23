import './styles.css';
import { ChatWidget } from './chat-widget';
import { setupDemoForm } from './demo-form';

document.addEventListener('DOMContentLoaded', () => {
  console.log('[App] Initializing WebMCP Demo...');
  
  // Setup the left side demo form
  setupDemoForm();

  // Initialize the right side chat widget
  try {
    new ChatWidget('chat-widget-container');
    console.log('[App] Chat widget initialized');
  } catch (error) {
    console.error('[App] Failed to initialize chat widget:', error);
  }
});
