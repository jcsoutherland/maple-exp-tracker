import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Controller } from './app/controller';
import { App } from './ui/App';
import { CtrlContext } from './ui/hooks';
import './ui/styles.css';

const ctrl = new Controller();
window.addEventListener('beforeunload', () => ctrl.persistNow());
// exposed for the headless replay harness and console debugging
(window as unknown as { met: Controller }).met = ctrl;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CtrlContext.Provider value={ctrl}>
      <App />
    </CtrlContext.Provider>
  </StrictMode>,
);
