// Poids variables uniquement, sous-ensemble latin (app légère).
import '@fontsource-variable/inter/wght.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { StoreProvider } from './store';
import { ToastProvider } from './components/toast';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Élément racine introuvable');

createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StoreProvider>
  </StrictMode>,
);
