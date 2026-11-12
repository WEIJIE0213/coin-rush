import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// No <StrictMode>: its simulated unmount would close the live WebSocket on first mount in dev.
createRoot(document.getElementById('root')!).render(<App />);
